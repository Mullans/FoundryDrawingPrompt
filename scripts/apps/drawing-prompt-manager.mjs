import { BG_SOURCE, FIT_MODE, INTERNAL, MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { computeBackgroundLayout } from "../drawing/background-layout.mjs";
import { defaultAssetFolder, normalizePath } from "../prompts/asset-service.mjs";
import {
  blankBackground,
  browseForImage,
  getControlledTileImage,
  getControlledTokenImage,
  getSceneBackgroundImage,
  loadBackgroundImage,
  resolveCanvasSize
} from "../foundry/background-source-service.mjs";
import { defaultAssignmentAssetName } from "../prompts/naming-service.mjs";
import { loadAllPrompts, loadPrompt } from "../prompts/persistence-service.mjs";
import { emit, isSocketReady } from "../socket.mjs";
import { formatClock, formatTimerChip } from "../utils/timer-chip.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SNAPSHOT_KEY_PREFIX = "drawing-prompts.snap.";
const SNAPSHOT_INDEX_KEY = "drawing-prompts.snap.index";
const SNAPSHOT_CACHE_LIMIT = 2 * 1024 * 1024;

/**
 * GM prompt manager window.
 */
export class DrawingPromptManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-manager",
    classes: ["drawing-prompts", "drawing-prompts-manager", "standard-form"],
    tag: "form",
    window: {
      title: "DRAWING-PROMPTS.manager.title",
      icon: "fa-solid fa-palette",
      resizable: true,
      positioned: true
    },
    position: { width: 980, height: 720 },
    actions: {
      browseBackground: DrawingPromptManager.#onBrowseBackground,
      useTokenBackground: DrawingPromptManager.#onUseTokenBackground,
      useTileBackground: DrawingPromptManager.#onUseTileBackground,
      useSceneBackground: DrawingPromptManager.#onUseSceneBackground,
      clearBackground: DrawingPromptManager.#onClearBackground,
      sendPrompt: DrawingPromptManager.#onSendPrompt,
      cancelAll: DrawingPromptManager.#onCancelAll,
      resendAll: DrawingPromptManager.#onResendAll,
      showPreview: DrawingPromptManager.#onShowPreview,
      selectAssignment: DrawingPromptManager.#onSelectAssignment,
      resendAssignment: DrawingPromptManager.#onResendAssignment,
      cancelAssignment: DrawingPromptManager.#onCancelAssignment,
      reopenAssignment: DrawingPromptManager.#onReopenAssignment,
      showPlayerUi: DrawingPromptManager.#onShowPlayerUi,
      saveAssignment: DrawingPromptManager.#onSaveAssignment,
      placeAssignment: DrawingPromptManager.#onPlaceAssignment,
      placeHiddenAssignment: DrawingPromptManager.#onPlaceHiddenAssignment,
      finishPrompt: DrawingPromptManager.#onFinishPrompt
    }
  };

  static PARTS = {
    body: {
      template: "modules/drawing-prompts/templates/drawing-prompt-manager.hbs"
    }
  };

  /**
   * Open or focus the singleton manager.
   * @returns {Promise<DrawingPromptManager>}
   */
  static async open() {
    if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    this.#instance ??= new this();
    const adoption = await this.#instance.adoptMostRecentActivePrompt();
    await this.#instance.render({ force: true });
    this.#instance.bringToFront();
    if ( adoption.total > 1 ) {
      ui.notifications.info(game.i18n.format("DRAWING-PROMPTS.manager.notifications.unfinishedPrompts", { count: adoption.total }));
    }
    return this.#instance;
  }

  /**
   * Refresh the open manager, if any.
   * @returns {void}
   */
  static refreshOpen() {
    this.#instance?.refreshFromService();
  }

  /**
   * Track a player window open state.
   * @param {string} assignmentId Assignment id.
   * @param {boolean} open Whether the player window is open.
   * @returns {void}
   */
  static setWindowOpen(assignmentId, open) {
    if ( !this.#instance ) return;
    this.#instance.windowOpenByAssignment.set(assignmentId, open);
    this.#instance.render({ parts: ["body"] });
  }

  /**
   * Deliver a snapshot to the open manager, if any.
   * @param {string} assignmentId Assignment id.
   * @param {string} dataUrl Snapshot data URL.
   * @returns {void}
   */
  static receiveSnapshotOpen(assignmentId, dataUrl) {
    this.#instance?.receiveSnapshot(assignmentId, dataUrl);
  }

  constructor() {
    super();
    this.draft = {
      promptText: "",
      drawingName: "",
      selectedUserIds: new Set(),
      canvasWidth: setting(SETTINGS.DEFAULT_CANVAS_WIDTH, 1024),
      canvasHeight: setting(SETTINGS.DEFAULT_CANVAS_HEIGHT, 768),
      timerSeconds: setting(SETTINGS.DEFAULT_TIMER_SECONDS, 0),
      background: blankBackground()
    };
    this.activePrompt = null;
    this.latestSnapshots = new Map();
    this.selectedAssignmentId = null;
    this.windowOpenByAssignment = new Map();
    this.#expiryTimerId = null;
    this.#expiryStateSignature = "";
  }

  #expiryTimerId;
  #expiryStateSignature;
  #formListenersAttached = false;
  #onFormInput = () => this.#syncDraftFromForm();
  #onFormChange = event => {
    this.#syncDraftFromForm();
    if ( event.target?.name === "fitMode" ) this.render({ parts: ["body"] });
    if ( event.target?.name === "selectedUserIds" ) this.#updateSelectedCount();
  };

  /**
   * Reload the active prompt and rerender.
   * @returns {void}
   */
  refreshFromService() {
    if ( this.activePrompt?.id ) this.activePrompt = loadPrompt(this.activePrompt.id) ?? this.activePrompt;
    this.render({ parts: ["body"] });
  }

  /**
   * Receive a player snapshot for preview.
   * @param {string} assignmentId Assignment id.
   * @param {string} dataUrl Snapshot data URL.
   * @returns {void}
   */
  receiveSnapshot(assignmentId, dataUrl) {
    this.latestSnapshots.set(assignmentId, dataUrl);
    this.#cacheSnapshot(assignmentId, dataUrl);
    this.selectedAssignmentId ??= assignmentId;
    if ( this.selectedAssignmentId === assignmentId ) this.#updatePreviewImage(dataUrl);
  }

  /**
   * Adopt the newest active persisted prompt after a GM reload.
   * @returns {Promise<{adopted: boolean, remaining: number, total: number}>} Adoption result.
   */
  async adoptMostRecentActivePrompt() {
    const prompts = this.#unfinishedPrompts();
    if ( this.activePrompt ) {
      return {
        adopted: false,
        remaining: Math.max(0, prompts.filter(prompt => prompt.id !== this.activePrompt.id).length),
        total: prompts.length
      };
    }
    this.activePrompt = prompts[0] ?? null;
    if ( this.activePrompt ) this.#adoptDraftFromPrompt();
    this.selectedAssignmentId = Object.keys(this.activePrompt?.assignments ?? {})[0] ?? null;
    this.#hydrateSnapshotCache();
    await this.#hydrateSubmissionCache();
    if ( this.activePrompt && isSocketReady() ) {
      for ( const assignment of Object.values(this.activePrompt.assignments) ) {
        if ( assignment.isActive && game.users.get(assignment.userId)?.active ) {
          await emit.requestSnapshot(assignment.userId, assignment.id);
        }
      }
    }
    return {
      adopted: Boolean(this.activePrompt),
      remaining: Math.max(0, prompts.length - 1),
      total: prompts.length
    };
  }

  /** @override */
  async _prepareContext(options) {
    const users = userValues().filter(user => !user.isGM);
    const rows = users.map(user => this.#rowContext(user));
    const selectedAssignment = this.#selectedAssignment();
    const selectedPreview = await this.#selectedPreviewContext(selectedAssignment);
    const hasActivePrompt = Boolean(this.activePrompt);
    return {
      draft: this.#draftContext(),
      rows,
      mode: hasActivePrompt ? "review" : "setup",
      hasActivePrompt,
      summary: this.#summaryContext(),
      maxCanvasDim: INTERNAL.MAX_CANVAS_DIM,
      fitModes: this.#fitModeOptions(),
      selectedSnapshot: selectedPreview.src,
      selectedPreviewHeading: selectedPreview.heading,
      selectedAssignmentId: this.selectedAssignmentId,
      canSend: !this.activePrompt,
      hasAssignments: Boolean(this.activePrompt && Object.keys(this.activePrompt.assignments).length),
      canCancelAll: Boolean(this.activePrompt && Object.values(this.activePrompt.assignments).some(a => a.isActive)),
      canResendAll: Boolean(this.activePrompt && Object.values(this.activePrompt.assignments).some(a => [STATUS.PENDING, STATUS.OPENED, STATUS.CANCELLED].includes(a.status))),
      canFinishPrompt: Boolean(this.activePrompt),
      selectedCanSave: selectedAssignment?.status === STATUS.SUBMITTED && !selectedAssignment.primaryImagePath,
      selectedIsSaved: Boolean(selectedAssignment?.primaryImagePath),
      selectedSavedTooltip: selectedAssignment?.primaryImagePath
        ? game.i18n.format("DRAWING-PROMPTS.manager.savedTooltip", { path: selectedAssignment.primaryImagePath })
        : "",
      selectedCanPlace: Boolean(selectedAssignment?.primaryImagePath),
      saveFirstTooltip: game.i18n.localize("DRAWING-PROMPTS.manager.actions.saveFirst")
    };
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const form = this.#formElement();
    if ( form && !this.#formListenersAttached ) {
      form.addEventListener("input", this.#onFormInput);
      form.addEventListener("change", this.#onFormChange);
      this.#formListenersAttached = true;
    }
    this.#refreshExpiryTicker();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#clearExpiryTicker();
    if ( this.constructor.#instance === this ) this.constructor.#instance = null;
  }

  /**
   * Sync draft state from the rendered form.
   * @returns {void}
   */
  #syncDraftFromForm() {
    if ( this.activePrompt ) return;
    const form = this.#formElement();
    if ( !form ) return;
    const data = new FormData(form);
    this.draft.promptText = String(data.get("promptText") ?? "");
    this.draft.drawingName = String(data.get("drawingName") ?? "");
    this.draft.canvasWidth = normalizeNumber(data.get("canvasWidth"));
    this.draft.canvasHeight = normalizeNumber(data.get("canvasHeight"));
    this.draft.timerSeconds = normalizeNumber(data.get("timerSeconds"));
    this.draft.background.fitMode = String(data.get("fitMode") ?? this.draft.background.fitMode);
    this.draft.selectedUserIds = new Set(data.getAll("selectedUserIds").map(String));
  }

  /**
   * Create a serializable draft for the prompt service.
   * @returns {object}
   */
  #serviceDraft() {
    this.#syncDraftFromForm();
    return {
      promptText: this.draft.promptText.trim(),
      drawingName: this.draft.drawingName.trim(),
      selectedUserIds: Array.from(this.draft.selectedUserIds),
      canvasWidth: this.draft.canvasWidth,
      canvasHeight: this.draft.canvasHeight,
      timerSeconds: this.draft.timerSeconds,
      background: { ...this.draft.background }
    };
  }

  /**
   * Use the active prompt as the retained draft after adopting from persistence.
   * @returns {void}
   */
  #adoptDraftFromPrompt() {
    if ( !this.activePrompt ) return;
    this.draft = {
      promptText: this.activePrompt.promptText,
      drawingName: this.activePrompt.drawingName,
      selectedUserIds: new Set(Object.values(this.activePrompt.assignments).map(assignment => assignment.userId)),
      canvasWidth: this.activePrompt.canvasWidth,
      canvasHeight: this.activePrompt.canvasHeight,
      timerSeconds: this.activePrompt.timerSeconds ?? 0,
      background: { ...this.activePrompt.background }
    };
  }

  /**
   * Validate the draft and show localized warnings.
   * @param {object} draft Serializable draft.
   * @returns {boolean}
   */
  #validateDraft(draft) {
    if ( !draft.promptText ) return warn("DRAWING-PROMPTS.manager.validation.promptText");
    if ( !draft.selectedUserIds.length ) return warn("DRAWING-PROMPTS.manager.validation.users");
    if ( !validDimension(draft.canvasWidth) || !validDimension(draft.canvasHeight) ) {
      return warn("DRAWING-PROMPTS.manager.validation.dimensions", { max: INTERNAL.MAX_CANVAS_DIM });
    }
    return true;
  }

  /**
   * Select and validate a background image.
   * @param {string} sourceType Background source type.
   * @param {string|null} path Image path.
   * @returns {Promise<void>}
   */
  async #selectBackground(sourceType, path) {
    this.#syncDraftFromForm();
    if ( !path ) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.background.errors.noSource"));
      return;
    }
    try {
      const loaded = await loadBackgroundImage(path);
      this.draft.background = {
        sourceType,
        path: loaded.path,
        fitMode: this.draft.background.fitMode || setting(SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_WIDTH),
        naturalWidth: loaded.naturalWidth,
        naturalHeight: loaded.naturalHeight
      };
      const dims = resolveCanvasSize(this.draft.canvasWidth, this.draft.canvasHeight, loaded.naturalWidth, loaded.naturalHeight);
      this.draft.canvasWidth = dims.width;
      this.draft.canvasHeight = dims.height;
      await this.render({ parts: ["body"] });
    } catch (err) {
      const key = err.code === "tainted" ? "DRAWING-PROMPTS.background.errors.tainted" : "DRAWING-PROMPTS.background.errors.loadFailed";
      ui.notifications.warn(game.i18n.localize(key));
    }
  }

  /**
   * Build draft context for templates.
   * @returns {object}
   */
  #draftContext() {
    const thumbnail = this.#backgroundThumbnailContext();
    return {
      ...this.draft,
      selectedCount: this.draft.selectedUserIds.size,
      hasBackground: Boolean(this.draft.background.path),
      backgroundLabel: this.draft.background.path || game.i18n.localize("DRAWING-PROMPTS.background.blank"),
      backgroundFrameStyle: thumbnail.frameStyle,
      backgroundImageStyle: thumbnail.imageStyle
    };
  }

  /**
   * Build read-only review summary context.
   * @returns {object|null}
   */
  #summaryContext() {
    if ( !this.activePrompt ) return null;
    const promptText = String(this.activePrompt.promptText ?? "");
    const truncated = truncateText(promptText, 90);
    const timerSeconds = Number(this.activePrompt.timerSeconds || 0);
    const timerCountdown = formatTimerChip(this.activePrompt.deadlineAt, Date.now(), {
      left: game.i18n.localize("DRAWING-PROMPTS.manager.timer.left"),
      over: game.i18n.localize("DRAWING-PROMPTS.manager.timer.over")
    });
    const hasBackground = Boolean(this.activePrompt.background?.path);
    return {
      promptText,
      promptPreview: truncated.text,
      promptTruncated: truncated.truncated,
      drawingName: this.activePrompt.drawingName || game.i18n.localize("DRAWING-PROMPTS.player.untitled"),
      canvasWidth: this.activePrompt.canvasWidth,
      canvasHeight: this.activePrompt.canvasHeight,
      hasTimer: timerSeconds > 0,
      timerDuration: formatClock(timerSeconds * 1000),
      timerCountdownText: timerCountdown.text,
      timerOvertime: timerCountdown.overtime,
      hasBackground,
      backgroundPath: hasBackground ? this.activePrompt.background.path : "",
      backgroundLabel: hasBackground
        ? game.i18n.format("DRAWING-PROMPTS.manager.summary.backgroundTooltip", { path: this.activePrompt.background.path })
        : ""
    };
  }

  /**
   * Resolve the application form element.
   * @returns {HTMLFormElement|null}
   */
  #formElement() {
    if ( this.element?.matches?.("form") ) return this.element;
    return this.element?.querySelector?.("form") ?? null;
  }

  /**
   * Build inline styles for the background thumbnail frame and image.
   * @returns {{frameStyle: string, imageStyle: string}}
   */
  #backgroundThumbnailContext() {
    const canvasWidth = Math.max(1, Number(this.draft.canvasWidth) || 1);
    const canvasHeight = Math.max(1, Number(this.draft.canvasHeight) || 1);
    const frameStyle = `aspect-ratio: ${canvasWidth} / ${canvasHeight};`;
    if ( !this.draft.background.path ) return { frameStyle, imageStyle: "" };

    const rect = computeBackgroundLayout(
      canvasWidth,
      canvasHeight,
      this.draft.background.naturalWidth,
      this.draft.background.naturalHeight,
      this.draft.background.fitMode
    );
    const pct = (value, basis) => `${(Number(value) / Math.max(1, Number(basis))) * 100}%`;
    return {
      frameStyle,
      imageStyle: [
        `left: ${pct(rect.dx, canvasWidth)}`,
        `top: ${pct(rect.dy, canvasHeight)}`,
        `width: ${pct(rect.dw, canvasWidth)}`,
        `height: ${pct(rect.dh, canvasHeight)}`
      ].join("; ")
    };
  }

  /**
   * Update the selected player count without rerendering the form.
   * @returns {void}
   */
  #updateSelectedCount() {
    const count = this.element?.querySelector(".dp-selected-count");
    if ( count ) count.textContent = String(this.draft.selectedUserIds.size);
  }

  /**
   * Build a user row context.
   * @param {User} user Foundry user.
   * @returns {object}
   */
  #rowContext(user) {
    const assignment = this.activePrompt?.assignmentForUser(user.id) ?? null;
    const now = Date.now();
    const selected = this.draft.selectedUserIds.has(user.id);
    const status = assignment?.status ?? "unselected";
    const isExpired = assignment?.isExpired(this.activePrompt?.deadlineAt ?? null, now) ?? false;
    return {
      user,
      userId: user.id,
      name: user.name,
      active: Boolean(user.active),
      selected,
      assignment,
      assignmentId: assignment?.id ?? "",
      status,
      statusLabel: status === "unselected"
        ? game.i18n.localize("DRAWING-PROMPTS.status.unselected")
        : game.i18n.localize(`DRAWING-PROMPTS.status.${status}`),
      classes: [
        assignment ? `status-${assignment.status}` : "status-unselected",
        assignment?.late ? "is-late" : "",
        isExpired ? "is-expired" : "",
        user.active ? "" : "is-offline",
        this.selectedAssignmentId === assignment?.id ? "is-selected" : ""
      ].filter(Boolean).join(" "),
      isLate: Boolean(assignment?.late),
      isExpired,
      isOffline: !user.active,
      overtimeLabel: assignment?.overtimeMs ? formatClock(assignment.overtimeMs) : "",
      windowOpen: assignment ? Boolean(this.windowOpenByAssignment.get(assignment.id)) : false,
      canSelectPreview: Boolean(assignment),
      canResend: Boolean(assignment && [STATUS.PENDING, STATUS.OPENED, STATUS.CANCELLED].includes(assignment.status)),
      canCancel: Boolean(assignment?.isActive),
      canReopen: Boolean(assignment && [STATUS.SUBMITTED, STATUS.REJECTED].includes(assignment.status)),
      canShow: Boolean(assignment?.isActive),
      isSubmitted: assignment?.status === STATUS.SUBMITTED,
      isSaved: Boolean(assignment?.primaryImagePath),
      savedTooltip: assignment?.primaryImagePath
        ? game.i18n.format("DRAWING-PROMPTS.manager.savedTooltip", { path: assignment.primaryImagePath })
        : ""
    };
  }

  /**
   * Build fit mode select options.
   * @returns {object[]}
   */
  #fitModeOptions() {
    return Object.values(FIT_MODE).map(value => ({
      value,
      selected: value === this.draft.background.fitMode,
      label: game.i18n.localize(`DRAWING-PROMPTS.choices.fitMode.${fitModeKey(value)}`)
    }));
  }

  /**
   * @this {DrawingPromptManager}
   * @returns {Promise<void>}
   */
  static async #onBrowseBackground() {
    const path = await browseForImage();
    if ( path ) await this.#selectBackground(BG_SOURCE.FILE, path);
  }

  /** @this {DrawingPromptManager} */
  static async #onUseTokenBackground() {
    await this.#selectBackground(BG_SOURCE.TOKEN, getControlledTokenImage());
  }

  /** @this {DrawingPromptManager} */
  static async #onUseTileBackground() {
    await this.#selectBackground(BG_SOURCE.TILE, getControlledTileImage());
  }

  /** @this {DrawingPromptManager} */
  static async #onUseSceneBackground() {
    await this.#selectBackground(BG_SOURCE.SCENE, getSceneBackgroundImage());
  }

  /** @this {DrawingPromptManager} */
  static async #onClearBackground() {
    this.#syncDraftFromForm();
    this.draft.background = blankBackground();
    await this.render({ parts: ["body"] });
  }

  /** @this {DrawingPromptManager} */
  static async #onSendPrompt() {
    const draft = this.#serviceDraft();
    if ( !this.#validateDraft(draft) ) return;
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = await service.createAndSendPrompt(draft);
    this.selectedAssignmentId = Object.keys(this.activePrompt.assignments)[0] ?? null;
    await this.render({ parts: ["body"] });
  }

  /** @this {DrawingPromptManager} */
  static async #onCancelAll() {
    if ( !this.activePrompt ) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.manager.cancelAllDialog.title", icon: "fa-solid fa-ban" },
      content: game.i18n.localize("DRAWING-PROMPTS.manager.cancelAllDialog.confirm"),
      yes: { label: "DRAWING-PROMPTS.manager.actions.cancelAll", icon: "fa-solid fa-ban", class: "dp-danger" },
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    const service = await import("../prompts/prompt-service.mjs");
    await service.cancelAllAssignments(this.activePrompt.id);
  }

  /** @this {DrawingPromptManager} */
  static async #onResendAll() {
    if ( !this.activePrompt ) return;
    const service = await import("../prompts/prompt-service.mjs");
    await service.resendAllAssignments(this.activePrompt.id);
  }

  /** @this {DrawingPromptManager} */
  static async #onShowPreview() {
    this.#syncDraftFromForm();
    const { PlayerDrawingApp } = await import("./player-drawing-app.mjs");
    await PlayerDrawingApp.open({
      assignment: { id: "preview", userId: game.user.id, status: STATUS.OPENED },
      prompt: {
        id: "preview",
        gmUserId: game.user.id,
        promptText: this.draft.promptText,
        drawingName: this.draft.drawingName,
        canvasWidth: this.draft.canvasWidth,
        canvasHeight: this.draft.canvasHeight,
        background: { ...this.draft.background },
        timerSeconds: this.draft.timerSeconds,
        deadlineAt: null
      }
    }, { mode: "preview" });
  }

  /** @this {DrawingPromptManager} */
  static async #onSelectAssignment(_event, target) {
    const assignmentId = target.dataset.assignmentId;
    if ( !assignmentId ) return;
    this.selectedAssignmentId = assignmentId;
    await this.render({ parts: ["body"] });
  }

  /** @this {DrawingPromptManager} */
  static async #onResendAssignment(_event, target) {
    const service = await import("../prompts/prompt-service.mjs");
    await service.resendAssignment(target.dataset.assignmentId);
  }

  /** @this {DrawingPromptManager} */
  static async #onCancelAssignment(_event, target) {
    const assignment = this.activePrompt?.getAssignment(target.dataset.assignmentId);
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.manager.cancelAssignmentDialog.title", icon: "fa-solid fa-ban" },
      content: game.i18n.format("DRAWING-PROMPTS.manager.cancelAssignmentDialog.confirm", { name: assignment?.userName ?? "" }),
      yes: { label: "DRAWING-PROMPTS.manager.actions.cancelAssignment", icon: "fa-solid fa-ban", class: "dp-danger" },
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    const service = await import("../prompts/prompt-service.mjs");
    await service.cancelAssignment(target.dataset.assignmentId);
  }

  /** @this {DrawingPromptManager} */
  static async #onReopenAssignment(_event, target) {
    const service = await import("../prompts/prompt-service.mjs");
    await service.reopenAssignment(target.dataset.assignmentId);
  }

  /** @this {DrawingPromptManager} */
  static async #onShowPlayerUi(_event, target) {
    const service = await import("../prompts/prompt-service.mjs");
    await service.showPlayerWindow(target.dataset.assignmentId);
  }

  /** @this {DrawingPromptManager} */
  static async #onSaveAssignment(_event, target) {
    const assignmentId = target.dataset.assignmentId || this.selectedAssignmentId;
    if ( !assignmentId ) return;
    const saveDetails = await this.#promptForSaveDetails(assignmentId);
    if ( saveDetails === null ) return;
    const service = await import("../prompts/prompt-service.mjs");
    try {
      await service.saveAssignment(assignmentId, saveDetails);
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }

  /** @this {DrawingPromptManager} */
  static async #onPlaceAssignment(_event, target) {
    await this.#placeAssignment(target.dataset.assignmentId || this.selectedAssignmentId, { hidden: false });
  }

  /** @this {DrawingPromptManager} */
  static async #onPlaceHiddenAssignment(_event, target) {
    await this.#placeAssignment(target.dataset.assignmentId || this.selectedAssignmentId, { hidden: true });
  }

  /** @this {DrawingPromptManager} */
  static async #onFinishPrompt() {
    if ( !this.activePrompt ) return;
    const affected = Object.values(this.activePrompt.assignments)
      .filter(assignment => assignment.isActive || (assignment.status === STATUS.SUBMITTED && !assignment.primaryImagePath));
    if ( affected.length ) {
      const names = affected.map(assignment => assignment.userName).join(", ");
      const confirmed = await DialogV2.confirm({
        window: { title: "DRAWING-PROMPTS.manager.finishDialog.title", icon: "fa-solid fa-flag-checkered" },
        content: `
          <p>${game.i18n.format("DRAWING-PROMPTS.manager.finishDialog.confirm", { count: affected.length })}</p>
          <p class="hint">${escapeHtml(names)}</p>`,
        yes: {
          label: "DRAWING-PROMPTS.manager.finishDialog.confirmButton",
          icon: "fa-solid fa-trash",
          class: "dp-danger"
        },
        rejectClose: false,
        modal: true
      });
      if ( !confirmed ) return;
    }
    const assignmentIds = Object.keys(this.activePrompt.assignments);
    const service = await import("../prompts/prompt-service.mjs");
    try {
      await service.finishPrompt(this.activePrompt.id);
      for ( const assignmentId of assignmentIds ) this.#clearCachedSnapshot(assignmentId);
      this.activePrompt = null;
      this.selectedAssignmentId = null;
      this.latestSnapshots.clear();
      const adoption = await this.adoptMostRecentActivePrompt();
      await this.render({ parts: ["body"] });
      if ( adoption.adopted ) {
        ui.notifications.info(game.i18n.format("DRAWING-PROMPTS.manager.notifications.adoptedNext", { count: adoption.remaining }));
      }
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }

  /**
   * Place an already-saved assignment.
   * @param {string} assignmentId Assignment id.
   * @param {{hidden: boolean}} options Placement options.
   * @returns {Promise<void>}
   */
  async #placeAssignment(assignmentId, { hidden }) {
    if ( !assignmentId ) return;
    const service = await import("../prompts/prompt-service.mjs");
    try {
      await service.placeAssignmentAsTile(assignmentId, { hidden });
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }

  /**
   * Prompt the GM for saved drawing details.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<{name: string, folder: string}|null>} Save details or null when cancelled.
   */
  async #promptForSaveDetails(assignmentId) {
    const assignment = this.activePrompt?.getAssignment(assignmentId);
    if ( !assignment ) return null;
    const fallback = assignment.assets?.name || defaultAssignmentAssetName({
      drawingName: this.activePrompt.drawingName,
      promptText: this.activePrompt.promptText,
      userName: assignment.userName
    });
    const state = {
      folder: normalizePath(setting(SETTINGS.LAST_SAVE_FOLDER, "") || defaultAssetFolder())
    };
    const result = await DialogV2.input({
      window: { title: "DRAWING-PROMPTS.manager.saveDialog.title" },
      content: `
        <div class="form-group">
          <label>${game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.name")}</label>
          <div class="form-fields">
            <input type="text" name="name" value="${escapeHtml(fallback)}" required>
          </div>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.folder")}</label>
          <div class="form-fields">
            <input type="text" name="folder" value="${escapeHtml(state.folder)}" readonly>
            <button type="button" data-dp-choose-folder>
              <i class="fa-solid fa-folder-open" inert></i>
              <span>${game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.chooseFolder")}</span>
            </button>
          </div>
        </div>`,
      ok: { label: "DRAWING-PROMPTS.manager.saveDialog.confirm", icon: "fa-solid fa-floppy-disk" },
      rejectClose: false,
      modal: true,
      render: (_event, dialog) => {
        const input = dialog.element.querySelector("input[name='folder']");
        dialog.element.querySelector("[data-dp-choose-folder]")?.addEventListener("click", async event => {
          event.preventDefault();
          const chosen = await chooseFolder(input.value);
          if ( !chosen ) return;
          state.folder = normalizePath(chosen);
          input.value = state.folder;
          await game.settings.set(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER, state.folder);
        });
      }
    });
    if ( result === null ) return null;
    const name = String(result?.name ?? "").trim();
    if ( !name ) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.manager.validation.name"));
      return null;
    }
    const folder = normalizePath(result?.folder || state.folder || defaultAssetFolder());
    return { name, folder };
  }

  /**
   * Get the currently selected assignment.
   * @returns {import("../prompts/prompt-models.mjs").DrawingAssignment|null}
   */
  #selectedAssignment() {
    return this.selectedAssignmentId ? this.activePrompt?.getAssignment(this.selectedAssignmentId) ?? null : null;
  }

  /**
   * Resolve preview source and heading for the selected assignment.
   * @param {import("../prompts/prompt-models.mjs").DrawingAssignment|null} assignment Selected assignment.
   * @returns {Promise<{src: string|null, heading: string}>}
   */
  async #selectedPreviewContext(assignment) {
    if ( !assignment ) {
      return {
        src: null,
        heading: game.i18n.localize("DRAWING-PROMPTS.manager.sections.preview")
      };
    }
    const snapshot = this.latestSnapshots.get(assignment.id) ?? null;
    if ( assignment.status === STATUS.SUBMITTED && assignment.primaryImagePath ) {
      return {
        src: assignment.primaryImagePath,
        heading: assignment.assets.name || game.i18n.localize("DRAWING-PROMPTS.manager.submittedDrawing")
      };
    }
    if ( assignment.status === STATUS.SUBMITTED ) {
      const service = await import("../prompts/prompt-service.mjs");
      const submission = service.getPendingSubmission(assignment.id);
      return {
        src: submission?.merged?.dataUrl ?? submission?.overlay?.dataUrl ?? snapshot,
        heading: assignment.assets.name || game.i18n.localize("DRAWING-PROMPTS.manager.submittedDrawing")
      };
    }
    return {
      src: snapshot,
      heading: game.i18n.localize("DRAWING-PROMPTS.manager.sections.preview")
    };
  }

  /**
   * Hydrate cached snapshots for active prompt assignments.
   * @returns {void}
   */
  #hydrateSnapshotCache() {
    if ( !game.user.isGM || !this.activePrompt ) return;
    for ( const assignmentId of Object.keys(this.activePrompt.assignments) ) {
      try {
        const dataUrl = sessionStorage.getItem(`${SNAPSHOT_KEY_PREFIX}${assignmentId}`);
        if ( dataUrl ) this.latestSnapshots.set(assignmentId, dataUrl);
      } catch (_err) {
        continue;
      }
    }
  }

  /**
   * Hydrate cached submissions for active prompt assignments.
   * @returns {Promise<void>}
   */
  async #hydrateSubmissionCache() {
    if ( !game.user.isGM || !this.activePrompt ) return;
    const service = await import("../prompts/prompt-service.mjs");
    for ( const assignmentId of Object.keys(this.activePrompt.assignments) ) {
      try {
        service.getPendingSubmission(assignmentId);
      } catch (_err) {
        continue;
      }
    }
  }

  /**
   * List this GM's unfinished prompts newest first.
   * @returns {import("../prompts/prompt-models.mjs").DrawingPrompt[]} Unfinished prompts.
   */
  #unfinishedPrompts() {
    return loadAllPrompts()
      .filter(prompt => prompt.needsAttention && prompt.gmUserId === game.user.id)
      .sort((a, b) => Number(b.sentAt ?? 0) - Number(a.sentAt ?? 0));
  }

  /**
   * Cache a snapshot in sessionStorage with coarse size eviction.
   * @param {string} assignmentId Assignment id.
   * @param {string} dataUrl Snapshot data URL.
   * @returns {void}
   */
  #cacheSnapshot(assignmentId, dataUrl) {
    if ( !game.user.isGM ) return;
    try {
      sessionStorage.setItem(`${SNAPSHOT_KEY_PREFIX}${assignmentId}`, dataUrl);
      const index = readSnapshotIndex();
      index[assignmentId] = { ts: Date.now(), size: dataUrl.length };
      writeSnapshotIndex(index);
      this.#evictSnapshotCache(index);
    } catch (_err) {
      // Ignore quota or privacy mode failures.
    }
  }

  /**
   * Clear one cached snapshot.
   * @param {string} assignmentId Assignment id.
   * @returns {void}
   */
  #clearCachedSnapshot(assignmentId) {
    try {
      sessionStorage.removeItem(`${SNAPSHOT_KEY_PREFIX}${assignmentId}`);
      const index = readSnapshotIndex();
      delete index[assignmentId];
      writeSnapshotIndex(index);
    } catch (_err) {
      // Ignore storage failures.
    }
  }

  /**
   * Evict old snapshots when the session cache grows too large.
   * @param {Record<string, {ts: number, size: number}>} index Snapshot index.
   * @returns {void}
   */
  #evictSnapshotCache(index) {
    const activeIds = new Set(Object.keys(this.activePrompt?.assignments ?? {}));
    let total = Object.values(index).reduce((sum, item) => sum + Number(item.size || 0), 0);
    const entries = Object.entries(index).sort((a, b) => Number(a[1].ts || 0) - Number(b[1].ts || 0));
    for ( const [assignmentId, item] of entries ) {
      if ( total <= SNAPSHOT_CACHE_LIMIT ) break;
      if ( activeIds.has(assignmentId) ) continue;
      sessionStorage.removeItem(`${SNAPSHOT_KEY_PREFIX}${assignmentId}`);
      total -= Number(item.size || 0);
      delete index[assignmentId];
    }
    for ( const [assignmentId, item] of entries ) {
      if ( total <= SNAPSHOT_CACHE_LIMIT ) break;
      if ( !index[assignmentId] ) continue;
      sessionStorage.removeItem(`${SNAPSHOT_KEY_PREFIX}${assignmentId}`);
      total -= Number(item.size || 0);
      delete index[assignmentId];
    }
    writeSnapshotIndex(index);
  }

  /**
   * Update the preview image without rerendering the full form.
   * @param {string} dataUrl Snapshot data URL.
   * @returns {void}
   */
  #updatePreviewImage(dataUrl) {
    const frame = this.element?.querySelector(".dp-preview-frame");
    if ( !frame ) return;
    let img = frame.querySelector("img");
    if ( !img ) {
      frame.innerHTML = "";
      img = document.createElement("img");
      img.alt = game.i18n.localize("DRAWING-PROMPTS.manager.alt.assignmentPreview");
      frame.append(img);
    }
    img.classList.remove("is-fading");
    img.src = dataUrl;
    requestAnimationFrame(() => img.classList.add("is-fading"));
  }

  /**
   * Start or stop the expired-row ticker.
   * @returns {void}
   */
  #refreshExpiryTicker() {
    const shouldTick = Boolean(this.activePrompt?.deadlineAt && Object.values(this.activePrompt.assignments).some(a => a.isActive));
    this.#updateTimerChip();
    if ( shouldTick && !this.#expiryTimerId ) {
      this.#expiryStateSignature = this.#expirySignature();
      this.#expiryTimerId = window.setInterval(() => this.#onExpiryTick(), 1000);
    } else if ( !shouldTick ) {
      this.#clearExpiryTicker();
    } else {
      this.#expiryStateSignature = this.#expirySignature();
    }
  }

  /**
   * Update timer chip text and rerender only when expiry classes need to change.
   * @returns {void}
   */
  #onExpiryTick() {
    this.#updateTimerChip();
    const nextSignature = this.#expirySignature();
    if ( nextSignature !== this.#expiryStateSignature ) {
      this.#expiryStateSignature = nextSignature;
      this.render({ parts: ["body"] });
    }
  }

  /**
   * Update the review timer countdown without rerendering the application body.
   * @returns {void}
   */
  #updateTimerChip() {
    const chip = this.element?.querySelector("[data-dp-timer-countdown]");
    if ( !chip || !this.activePrompt?.deadlineAt ) return;
    const timer = formatTimerChip(this.activePrompt.deadlineAt, Date.now(), {
      left: game.i18n.localize("DRAWING-PROMPTS.manager.timer.left"),
      over: game.i18n.localize("DRAWING-PROMPTS.manager.timer.over")
    });
    chip.textContent = timer.text;
    chip.classList.toggle("is-overtime", timer.overtime);
    chip.closest(".dp-summary-timer")?.classList.toggle("is-overtime", timer.overtime);
  }

  /**
   * Build a compact signature for active assignment expiry styling.
   * @returns {string}
   */
  #expirySignature() {
    if ( !this.activePrompt?.deadlineAt ) return "";
    const now = Date.now();
    return Object.values(this.activePrompt.assignments)
      .filter(assignment => assignment.isActive)
      .map(assignment => `${assignment.id}:${assignment.isExpired(this.activePrompt.deadlineAt, now) ? "1" : "0"}`)
      .join("|");
  }

  /**
   * Clear the expired-row ticker.
   * @returns {void}
   */
  #clearExpiryTicker() {
    if ( this.#expiryTimerId ) window.clearInterval(this.#expiryTimerId);
    this.#expiryTimerId = null;
    this.#expiryStateSignature = "";
  }
}

/**
 * Read a setting with fallback.
 * @param {string} key Setting key.
 * @param {*} fallback Fallback value.
 * @returns {*}
 */
function setting(key, fallback) {
  const value = game.settings.get(MODULE_ID, key);
  return value === undefined || value === null ? fallback : value;
}

/**
 * Escape text for use in a small dialog HTML attribute.
 * @param {string} value Value.
 * @returns {string} Escaped value.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Choose a target folder using Foundry's FilePicker folder mode.
 * @param {string} current Current folder.
 * @returns {Promise<string|null>}
 */
function chooseFolder(current) {
  return new Promise(resolve => {
    const FilePickerImpl = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
    const picker = new FilePickerImpl({
      type: "folder",
      current,
      activeSource: "data",
      callback: path => resolve(path)
    });
    picker.addEventListener?.("close", () => resolve(null), { once: true });
    picker.render({ force: true });
  });
}

/**
 * Read snapshot cache index.
 * @returns {Record<string, {ts: number, size: number}>}
 */
function readSnapshotIndex() {
  try {
    return JSON.parse(sessionStorage.getItem(SNAPSHOT_INDEX_KEY) || "{}");
  } catch (_err) {
    return {};
  }
}

/**
 * Write snapshot cache index.
 * @param {Record<string, {ts: number, size: number}>} index Snapshot index.
 * @returns {void}
 */
function writeSnapshotIndex(index) {
  try {
    sessionStorage.setItem(SNAPSHOT_INDEX_KEY, JSON.stringify(index));
  } catch (_err) {
    // Ignore storage failures.
  }
}

/**
 * Return Foundry users from a Collection or Map-like object.
 * @returns {User[]}
 */
function userValues() {
  if ( typeof game.users.filter === "function" ) return game.users.filter(() => true);
  if ( typeof game.users.values === "function" ) return Array.from(game.users.values());
  return Array.from(game.users);
}

/**
 * Show a localized warning and return false.
 * @param {string} key Localization key.
 * @param {object} [data] Format data.
 * @returns {false}
 */
function warn(key, data = {}) {
  ui.notifications.warn(game.i18n.format(key, data));
  return false;
}

/**
 * Test a canvas dimension.
 * @param {number} value Dimension.
 * @returns {boolean}
 */
function validDimension(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= INTERNAL.MAX_CANVAS_DIM;
}

/**
 * Normalize a numeric form value.
 * @param {FormDataEntryValue|null} value Form value.
 * @returns {number}
 */
function normalizeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Convert fit mode value to i18n suffix.
 * @param {string} value Fit mode.
 * @returns {string}
 */
function fitModeKey(value) {
  return {
    [FIT_MODE.CENTER]: "center",
    [FIT_MODE.FIT_WIDTH]: "fitWidth",
    [FIT_MODE.FIT_HEIGHT]: "fitHeight",
    [FIT_MODE.STRETCH]: "stretch"
  }[value] ?? "fitWidth";
}

/**
 * Truncate text for a one-line summary.
 * @param {string} value Source text.
 * @param {number} maxLength Maximum display length.
 * @returns {{text: string, truncated: boolean}}
 */
function truncateText(value, maxLength) {
  const text = String(value ?? "").trim();
  if ( text.length <= maxLength ) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`, truncated: true };
}
