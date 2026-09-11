import { PROMPT_STATUS } from "../constants.mjs";
import { loadAllPrompts } from "../prompts/persistence-service.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

export const LIBRARY_SORT = Object.freeze({ STATUS: "status", NAME: "name", CREATED: "createdAt", CLOSED: "closedAt" });
const STATUS_ORDER = Object.freeze({ open: 0, draft: 1, closed: 2, archived: 3 });
const DEFAULT_SORT_FIELD = LIBRARY_SORT.CREATED;
const DEFAULT_SORT_DIRECTION = "desc";

function timestamp(value) {
  if ( value == null || value === "" ) return null;
  const result = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function compareText(left, right) {
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { sensitivity: "base", numeric: true });
}

function tieBreak(left, right) {
  return compareText(left.promptName, right.promptName) || compareText(left.id, right.id);
}

function statusTimestamp(prompt) {
  if ( prompt.lifecycleStatus === "open" ) return timestamp(prompt.sentAt) ?? timestamp(prompt.createdAt) ?? 0;
  if ( prompt.lifecycleStatus === "draft" ) return timestamp(prompt.createdAt) ?? 0;
  return timestamp(prompt.closedAt) ?? timestamp(prompt.createdAt) ?? 0;
}

function compareClosed(left, right, direction) {
  const category = prompt => {
    if ( prompt.lifecycleStatus === "draft" ) return 2;
    if ( prompt.lifecycleStatus === "open" ) return direction === "desc" ? 0 : 1;
    return direction === "desc" ? 1 : 0;
  };
  const categoryDelta = category(left) - category(right);
  if ( categoryDelta ) return categoryDelta;
  const leftClosed = timestamp(left.closedAt);
  const rightClosed = timestamp(right.closedAt);
  if ( leftClosed != null && rightClosed != null && leftClosed !== rightClosed ) {
    return direction === "desc" ? rightClosed - leftClosed : leftClosed - rightClosed;
  }
  return tieBreak(left, right);
}

/** Pure presentation helper used by the Application and focused tests. */
export function filterAndSortPrompts(prompts, { query = "", showArchived = false, sortField = DEFAULT_SORT_FIELD, sortDirection = DEFAULT_SORT_DIRECTION } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const visible = prompts.filter(prompt => {
    if ( prompt.lifecycleStatus === "archived" && !showArchived ) return false;
    if ( !needle ) return true;
    return `${prompt.promptName ?? ""}\n${prompt.promptText ?? ""}`.toLocaleLowerCase().includes(needle);
  });
  return visible.sort((left, right) => {
    if ( sortField === LIBRARY_SORT.CLOSED ) return compareClosed(left, right, sortDirection);
    let result = 0;
    if ( sortField === LIBRARY_SORT.STATUS ) {
      result = (STATUS_ORDER[left.lifecycleStatus] ?? 99) - (STATUS_ORDER[right.lifecycleStatus] ?? 99);
      if ( !result ) result = statusTimestamp(right) - statusTimestamp(left) || tieBreak(left, right);
    } else if ( sortField === LIBRARY_SORT.NAME ) result = tieBreak(left, right);
    else result = (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0) || tieBreak(left, right);
    return sortDirection === "asc" ? result : -result;
  });
}

function setting(key, fallback) {
  try { return game.settings?.get("drawing-prompts", key) ?? fallback; }
  catch { return fallback; }
}

function localizedDate(value) {
  const time = timestamp(value);
  if ( time == null ) return null;
  return new Intl.DateTimeFormat(game.i18n?.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

function localize(key, fallback) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}

/** Persistent Prompt browser. Lifecycle mutations remain behind prompt-service. */
export class PromptLibrary extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;
  #query = "";
  #showArchived = false;
  #sortField;
  #sortDirection;
  #listenerRoots = new WeakSet();

  constructor(options = {}, dependencies = {}) {
    super(options);
    this.loadPrompts = dependencies.loadPrompts ?? loadAllPrompts;
    this.lifecycleServices = dependencies.services ?? null;
    this.openManager = dependencies.openManager ?? (async promptId => {
      const { DrawingPromptManager } = await import("./drawing-prompt-manager.mjs");
      return DrawingPromptManager.openPrompt(promptId);
    });
    this.openNew = dependencies.openNew ?? (async () => {
      const { DrawingPromptManager } = await import("./drawing-prompt-manager.mjs");
      return DrawingPromptManager.openNewPrompt();
    });
    this.openCopy = dependencies.openCopy ?? (async promptId => {
      const { DrawingPromptManager } = await import("./drawing-prompt-manager.mjs");
      return DrawingPromptManager.openPromptCopy(promptId);
    });
    this.activePromptId = dependencies.activePromptId ?? (() => null);
    this.#sortField = dependencies.sortField ?? setting("defaultLibrarySortField", DEFAULT_SORT_FIELD);
    this.#sortDirection = dependencies.sortDirection ?? setting("defaultLibrarySortDirection", DEFAULT_SORT_DIRECTION);
  }

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-library",
    classes: ["drawing-prompts", "drawing-prompts-library", "standard-form"],
    window: { title: "DRAWING-PROMPTS.library.title", icon: "fa-solid fa-folder-open", resizable: true },
    position: { width: 820, height: "auto" },
    actions: {
      newPrompt: PromptLibrary.#onNew, openPrompt: PromptLibrary.#onOpen, openCopy: PromptLibrary.#onOpenCopy,
      toggleArchived: PromptLibrary.#onToggleArchived, showArchived: PromptLibrary.#onShowArchived,
      archivePrompt: PromptLibrary.#onArchive, restorePrompt: PromptLibrary.#onRestore, deletePrompt: PromptLibrary.#onDelete
    }
  };

  static PARTS = { body: { template: "modules/drawing-prompts/templates/prompt-library.hbs" } };

  static async open() {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    const app = this.#instance ??= new this();
    await app.render({ force: true });
    app.bringToFront();
    return app;
  }

  static refreshOpen() { return this.#instance?.render({ parts: ["body"] }); }

  _onClose(options) {
    super._onClose(options);
    if ( this.constructor.#instance === this ) this.constructor.#instance = null;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if ( !root || this.#listenerRoots.has(root) ) return;
    this.#listenerRoots.add(root);
    root.addEventListener("input", event => {
      if ( event.target?.name !== "promptSearch" ) return;
      this.#query = event.target.value;
      void this.render({ parts: ["body"] });
    });
    root.addEventListener("change", event => {
      if ( event.target?.name === "sortField" ) this.#sortField = event.target.value;
      else if ( event.target?.name === "sortDirection" ) this.#sortDirection = event.target.value;
      else return;
      void this.render({ parts: ["body"] });
    });
  }

  async _prepareContext() {
    const all = this.loadPrompts();
    const filtered = filterAndSortPrompts([...all], { query: this.#query, showArchived: this.#showArchived, sortField: this.#sortField, sortDirection: this.#sortDirection });
    const needle = this.#query.trim().toLocaleLowerCase();
    const hiddenArchivedMatch = !this.#showArchived && all.some(prompt => prompt.lifecycleStatus === "archived"
      && (!needle || `${prompt.promptName ?? ""}\n${prompt.promptText ?? ""}`.toLocaleLowerCase().includes(needle)));
    const activeId = this.activePromptId();
    const rows = filtered.map(prompt => this.#rowContext(prompt, activeId));
    return {
      rows,
      hasRows: rows.length > 0,
      emptyMessage: !all.length ? localize("DRAWING-PROMPTS.library.emptyAll", "No prompts have been saved.")
        : hiddenArchivedMatch ? localize("DRAWING-PROMPTS.library.emptyArchived", "Matching archived prompts are hidden.")
          : localize("DRAWING-PROMPTS.library.emptySearch", "No prompts match your search."),
      hiddenArchivedMatch,
      query: this.#query,
      showArchived: this.#showArchived,
      archiveToggleIcon: this.#showArchived ? "fa-eye" : "fa-eye-slash",
      archiveToggleText: this.#showArchived ? localize("DRAWING-PROMPTS.library.archivedShown", "Archived shown") : localize("DRAWING-PROMPTS.library.archivedHidden", "Archived hidden"),
      archiveToggleLabel: this.#showArchived ? localize("DRAWING-PROMPTS.library.hideArchived", "Hide archived prompts") : localize("DRAWING-PROMPTS.library.showArchived", "Show archived prompts"),
      sortOptions: this.#sortOptions(),
      directionOptions: this.#directionOptions()
    };
  }

  #rowContext(prompt, activeId) {
    const status = prompt.lifecycleStatus ?? "draft";
    const promptName = prompt.promptName || prompt.id;
    return {
      id: prompt.id, promptName,
      promptText: prompt.promptText || localize("DRAWING-PROMPTS.library.noPromptText", "No prompt text."),
      status,
      statusLabel: localize(`DRAWING-PROMPTS.library.status.${status}`, status[0].toUpperCase() + status.slice(1)),
      createdAt: localizedDate(prompt.createdAt) ?? localize("DRAWING-PROMPTS.library.notCreated", "Not created"),
      closedAt: localizedDate(prompt.closedAt) ?? localize("DRAWING-PROMPTS.library.notClosed", "Not closed"),
      isCurrent: prompt.id === activeId,
      isArchived: status === PROMPT_STATUS.ARCHIVED,
      canArchive: status === "draft" || status === PROMPT_STATUS.CLOSED,
      canRestore: status === PROMPT_STATUS.ARCHIVED
    };
  }

  #sortOptions() {
    return [[LIBRARY_SORT.STATUS, "status", "Status"], [LIBRARY_SORT.NAME, "name", "Prompt name"], [LIBRARY_SORT.CREATED, "created", "Date created"], [LIBRARY_SORT.CLOSED, "closed", "Date closed"]]
      .map(([value, key, fallback]) => ({ value, label: localize(`DRAWING-PROMPTS.library.sort.${key}`, fallback), selected: value === this.#sortField }));
  }

  #directionOptions() {
    const labels = this.#sortField === LIBRARY_SORT.NAME ? [["asc", "A–Z"], ["desc", "Z–A"]]
      : this.#sortField === LIBRARY_SORT.STATUS ? [["asc", "Open → Archived"], ["desc", "Archived → Open"]]
        : [["desc", "Newest first"], ["asc", "Oldest first"]];
    return labels.map(([value, label]) => ({ value, label, selected: value === this.#sortDirection }));
  }

  static async #onNew() { await this.openNew(); }
  static async #onOpen(_event, target) { await this.openManager(target.dataset.promptId); }
  static async #onOpenCopy(_event, target) { await this.openCopy(target.dataset.promptId); }
  static async #onToggleArchived() { this.#showArchived = !this.#showArchived; await this.render({ parts: ["body"] }); }
  static async #onShowArchived() { this.#showArchived = true; await this.render({ parts: ["body"] }); }

  static async #onArchive(_event, target) {
    const service = this.lifecycleServices ?? await import("../prompts/prompt-service.mjs");
    await service.archivePrompt(target.dataset.promptId);
    await this.render({ parts: ["body"] });
  }

  static async #onRestore(_event, target) {
    const service = this.lifecycleServices ?? await import("../prompts/prompt-service.mjs");
    await service.restorePrompt(target.dataset.promptId);
    await this.render({ parts: ["body"] });
  }

  static async #onDelete(_event, target) {
    const confirmed = await DialogV2.confirm({ window: { title: "DRAWING-PROMPTS.library.deleteTitle" }, content: `<p>${game.i18n.localize("DRAWING-PROMPTS.library.deleteConfirm")}</p>`, yes: { label: "DRAWING-PROMPTS.library.delete", class: "dp-danger" }, rejectClose: false, modal: true });
    if ( !confirmed ) return;
    const service = this.lifecycleServices ?? await import("../prompts/prompt-service.mjs");
    await service.deletePrompt(target.dataset.promptId, { confirmed: true });
    await this.render({ parts: ["body"] });
  }
}
