import { PROMPT_STATUS } from "../constants.mjs";
import { loadAllPrompts } from "../prompts/persistence-service.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Closed/Archived Prompt library. Lifecycle mutations remain behind prompt-service. */
export class PromptLibrary extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  constructor(options = {}, dependencies = {}) {
    super(options);
    this.loadPrompts = dependencies.loadPrompts ?? loadAllPrompts;
    this.lifecycleServices = dependencies.services ?? null;
    this.openManager = dependencies.openManager ?? (async promptId => {
      const { DrawingPromptManager } = await import("./drawing-prompt-manager.mjs");
      return DrawingPromptManager.openPrompt(promptId);
    });
  }

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-library",
    classes: ["drawing-prompts", "drawing-prompts-library", "standard-form"],
    window: { title: "DRAWING-PROMPTS.library.title", icon: "fa-solid fa-box-archive", resizable: true },
    position: { width: 680, height: 560 },
    actions: {
      openPrompt: PromptLibrary.#onOpen,
      archivePrompt: PromptLibrary.#onArchive,
      restorePrompt: PromptLibrary.#onRestore,
      deletePrompt: PromptLibrary.#onDelete
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

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( this.constructor.#instance === this ) this.constructor.#instance = null;
  }

  async _prepareContext() {
    const prompts = this.loadPrompts().sort((a, b) => Number(b.closedAt ?? 0) - Number(a.closedAt ?? 0));
    const row = prompt => ({ id: prompt.id, name: prompt.drawingName || prompt.promptText || prompt.id });
    return {
      closed: prompts.filter(p => p.lifecycleStatus === PROMPT_STATUS.CLOSED).map(row),
      archived: prompts.filter(p => p.lifecycleStatus === PROMPT_STATUS.ARCHIVED).map(row)
    };
  }

  static async #onOpen(_event, target) {
    const service = this.lifecycleServices ?? await import("../prompts/prompt-service.mjs");
    await service.reopenPrompt(target.dataset.promptId);
    await this.openManager(target.dataset.promptId);
    await this.render({ parts: ["body"] });
  }

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
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.library.deleteTitle" },
      content: `<p>${game.i18n.localize("DRAWING-PROMPTS.library.deleteConfirm")}</p>`,
      yes: { label: "DRAWING-PROMPTS.library.delete", class: "dp-danger" },
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    const service = this.lifecycleServices ?? await import("../prompts/prompt-service.mjs");
    await service.deletePrompt(target.dataset.promptId, { confirmed: true });
    await this.render({ parts: ["body"] });
  }
}
