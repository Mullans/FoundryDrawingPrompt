import { BG_SOURCE, FILES_UPLOAD_PERMISSION, FIT_MODE, FRAMING_VIEW, INTERNAL, MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import {
  FRAMING_ZOOM_STEP,
  drawFramingEditor,
  framingAfterFitModeSelect,
  framingForPlacedStart,
  lockFramingToCanvasAspect,
  panFraming,
  resetFraming,
  resolveDraftFraming,
  zoomFraming
} from "../drawing/draft-framing-editor.mjs";
import { defaultFramingForBackground } from "../drawing/framed-background.mjs";
import { fitPlateInBox, layoutPlateInStage } from "../drawing/plate-layout.mjs";
import { classifyWheelGesture } from "../drawing/player-navigation.mjs";
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
import {
  canPlaceFramingView,
  framingViewNeedsLiveOverlay,
  hasSourceBackground,
  normalizeFramingView,
  resolveFramingViewAssetPath
} from "../prompts/dual-save.mjs";
import { resolveAssignmentReview } from "../prompts/assignment-review.mjs";
import { resolveReviewPlateAspect } from "../prompts/review-preview.mjs";
import { loadAllPrompts, loadPrompt } from "../prompts/persistence-service.mjs";
import { isSaveGateOpen } from "../prompts/transitions.mjs";
import { emit, isSocketReady } from "../socket.mjs";
import { formatClock, formatTimerAdjustment, formatTimerState } from "../utils/timer-chip.mjs";
import { normalizeSnapshotPayload } from "../prompts/wire-validation.mjs";
import {
  waitForApplicationClose
} from "./manager-canvas-yield.mjs";

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
      minimizable: true,
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
      toggleTimer: DrawingPromptManager.#onToggleTimer,
      resetTimer: DrawingPromptManager.#onResetTimer,
      stopTimer: DrawingPromptManager.#onStopTimer,
      adjustTimer: DrawingPromptManager.#onAdjustTimer,
      cancelAll: DrawingPromptManager.#onCancelAll,
      resendAll: DrawingPromptManager.#onResendAll,
      showPreview: DrawingPromptManager.#onShowPreview,
      selectAssignment: DrawingPromptManager.#onSelectAssignment,
      resendAssignment: DrawingPromptManager.#onResendAssignment,
      cancelAssignment: DrawingPromptManager.#onCancelAssignment,
      reopenAssignment: DrawingPromptManager.#onReopenAssignment,
      showPlayerUi: DrawingPromptManager.#onShowPlayerUi,
      saveAssignment: DrawingPromptManager.#onSaveAssignment,
      openPlaceDialog: DrawingPromptManager.#onOpenPlaceDialog,
      applyTransform: DrawingPromptManager.#onApplyTransform,
      finishPrompt: DrawingPromptManager.#onFinishPrompt,
      switchPrompt: DrawingPromptManager.#onSwitchPrompt,
      setFramingView: DrawingPromptManager.#onSetFramingView,
      framingZoomIn: DrawingPromptManager.#onFramingZoomIn,
      framingZoomOut: DrawingPromptManager.#onFramingZoomOut,
      framingReset: DrawingPromptManager.#onFramingReset
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
    // A newly opened player window withholds overlay bytes until it is told this view needs them.
    if ( open ) void this.#instance.#requestLiveSnapshots({ assignmentId });
    this.#instance.render({ parts: ["body"] });
  }

  /**
   * Deliver a snapshot to the open manager, if any.
   * @param {string} assignmentId Assignment id.
   * @param {string|{composite?: string, overlay?: string}} snapshotPayload Snapshot payload.
   * @returns {void}
   */
  static receiveSnapshotOpen(assignmentId, snapshotPayload) {
    this.#instance?.receiveSnapshot(assignmentId, snapshotPayload);
  }

  /**
   * Temporarily hide the open manager for Place/Transform canvas work, then restore.
   * Uses full visibility hide (not window minimize) so the canvas is unobstructed.
   * @template T
   * @param {() => Promise<T>|T} work Async canvas-facing work.
   * @returns {Promise<T>}
   */
  static async withCanvasYield(work) {
    const { hideApplicationForCanvasYield, restoreApplicationAfterCanvasYield } = await import(
      "../foundry/canvas-place-preview.mjs"
    );
    const app = this.#instance;
    const hideState = hideApplicationForCanvasYield(app);
    try {
      return await work();
    } finally {
      restoreApplicationAfterCanvasYield(app, hideState);
    }
  }

  constructor() {
    super();
    this.draft = {
      promptText: "",
      drawingName: "",
      selectedUserIds: new Set(),
      canvasWidth: setting(SETTINGS.DEFAULT_CANVAS_WIDTH, 512),
      canvasHeight: setting(SETTINGS.DEFAULT_CANVAS_HEIGHT, 512),
      timerSeconds: setting(SETTINGS.DEFAULT_TIMER_SECONDS, 0),
      background: blankBackground()
    };
    this.activePrompt = null;
    this.latestSnapshots = new Map();
    /** @type {Map<string, string>} Latest overlay-only (ink) live snapshots for Full Framing remaps. */
    this.latestOverlaySnapshots = new Map();
    this.selectedAssignmentId = null;
    this.windowOpenByAssignment = new Map();
    /** @type {string} GM review Framing View for the open manager session. */
    this.framingView = FRAMING_VIEW.PROMPT_CANVAS;
    /** @type {Map<string, string>} Cached Full Framing live-remap data URLs by assignment. */
    this.#sourceFramingPreviewCache = new Map();
    this.#expiryTimerId = null;
    this.#expiryStateSignature = "";
  }

  #expiryTimerId;
  #expiryStateSignature;
  #formListenersAttached = false;
  #sourceFramingPreviewCache;
  /**
   * Loaded (and taint-checked) `<img>` for the current draft background, cached
   * alongside its path so {@link #updateFramingEditor} can redraw the framing
   * viewport cheaply without refetching the image on every input/change event.
   * @type {{path: string, img: HTMLImageElement}|null}
  */
  #previewBackgroundImage = null;
  #previewBackgroundLoad = null;
  #framingEditorAttached = false;
  #framingEditorHandlers = null;
  #framingResizeObserver = null;
  #framingViewportEl = null;
  #reviewPlateResizeObserver = null;
  /** Bumps on Framing View change so stale async remaps cannot paint intermediate frames. */
  #framingPreviewEpoch = 0;
  /**
   * Bumps when starting an async selected-preview resolve (live Full Framing remap or refresh).
   * Completions with an older sequence must not paint over a newer resolve.
   */
  #previewResolveSeq = 0;
  /**
   * Framing View last committed to the review plate (image + aspect together).
   * Toggle may move `this.framingView` earlier; layout must not use that until paint commits,
   * or ResizeObserver/#layoutReviewPlate stretches the prior bitmap (live Full Framing flash).
   * @type {string|null}
   */
  #committedReviewFramingView = null;
  #framingPanPointerId = null;
  #framingPanLast = null;
  #onFormInput = event => {
    // Defer fitMode to `change`: Chromium fires input then change for <select>,
    // and syncing fitMode on input would make previous===next on change (skipping
    // full-source framing reset for non-Placed modes).
    if ( event.target?.name === "fitMode" ) return;
    this.#syncDraftFromForm();
    this.#updateFramingEditor();
  };
  #onFormChange = event => {
    const previousFitMode = this.draft.background.fitMode;
    this.#syncDraftFromForm();
    if ( event.target?.name === "fitMode" ) {
      this.#handleFitModeChange(previousFitMode, this.draft.background.fitMode);
    }
    this.#updateFramingEditor();
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
   * @param {string|{composite?: string, overlay?: string}} snapshotPayload Composite and/or overlay data URLs.
   * @returns {void}
   */
  receiveSnapshot(assignmentId, snapshotPayload) {
    const { composite, overlay } = normalizeSnapshotPayload(snapshotPayload);
    if ( composite ) {
      this.latestSnapshots.set(assignmentId, composite);
      this.#cacheSnapshot(assignmentId, composite);
    }
    // Composite-only ticks (Prompt-canvas view, or overlay dropped for wire budget) must
    // invalidate cached overlay ink so Full Framing never remaps a stale layer.
    if ( overlay ) this.latestOverlaySnapshots.set(assignmentId, overlay);
    else if ( composite ) this.latestOverlaySnapshots.delete(assignmentId);

    this.selectedAssignmentId ??= assignmentId;
    if ( this.selectedAssignmentId !== assignmentId ) return;

    const view = normalizeFramingView(this.framingView, {
      hasSource: hasSourceBackground(this.activePrompt)
    });
    if ( view !== FRAMING_VIEW.FULL ) {
      if ( composite ) this.#updatePreviewImage(composite);
      return;
    }

    const assignment = this.activePrompt?.getAssignment(assignmentId);
    if ( !assignment || !this.activePrompt ) return;
    const resolveSeq = ++this.#previewResolveSeq;
    const epoch = this.#framingPreviewEpoch;
    void this.#selectedPreviewContext(assignment, FRAMING_VIEW.FULL).then(preview => {
      if ( resolveSeq !== this.#previewResolveSeq ) return;
      if ( this.selectedAssignmentId !== assignmentId ) return;
      if ( epoch !== this.#framingPreviewEpoch ) return;
      if ( normalizeFramingView(this.framingView, {
        hasSource: hasSourceBackground(this.activePrompt)
      }) !== FRAMING_VIEW.FULL ) return;
      if ( preview.src ) {
        void this.#setPreviewFrame(preview.src, {
          epoch,
          framingView: FRAMING_VIEW.FULL
        });
      }
    });
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
    await this.#requestLiveSnapshots();
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
    const hasSource = hasSourceBackground(this.activePrompt);
    this.framingView = normalizeFramingView(this.framingView, { hasSource });
    const framingView = this.framingView;
    const selectedPreview = await this.#selectedPreviewContext(selectedAssignment, framingView);
    const hasActivePrompt = Boolean(this.activePrompt);
    const viewAssetPath = resolveFramingViewAssetPath(selectedAssignment, framingView);
    const savedAndGateOpen = isSaveGateOpen(selectedAssignment);
    return {
      draft: this.#draftContext(),
      rows,
      mode: hasActivePrompt ? "review" : "setup",
      hasActivePrompt,
      summary: this.#summaryContext(),
      timerControls: this.#timerControlsContext(),
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
      promptQueue: this.#promptQueueContext(),
      selectedCanSave: selectedAssignment?.status === STATUS.SUBMITTED && !savedAndGateOpen,
      selectedIsSaved: savedAndGateOpen,
      selectedSavedTooltip: viewAssetPath
        ? game.i18n.format("DRAWING-PROMPTS.manager.savedTooltip", { path: viewAssetPath })
        : selectedAssignment?.primaryImagePath
          ? game.i18n.format("DRAWING-PROMPTS.manager.savedTooltip", { path: selectedAssignment.primaryImagePath })
          : "",
      selectedCanPlace: canPlaceFramingView(selectedAssignment, framingView),
      saveFirstTooltip: game.i18n.localize("DRAWING-PROMPTS.manager.actions.saveFirst"),
      transformSaveFirstTooltip: game.i18n.localize("DRAWING-PROMPTS.transform.saveFirst"),
      framingViewToggle: this.#framingViewToggleContext(hasSource, framingView)
    };
  }

  /** @override */
  async _onRender(context, options) {
    this.#destroyFramingEditor();
    await super._onRender(context, options);
    const form = this.#formElement();
    if ( form && !this.#formListenersAttached ) {
      form.addEventListener("input", this.#onFormInput);
      form.addEventListener("change", this.#onFormChange);
      this.#formListenersAttached = true;
    }
    void this.#ensurePreviewBackgroundImage();
    this.#updateFramingEditor();
    this.#ensureFramingEditor();
    if ( this.activePrompt ) {
      this.#committedReviewFramingView ??= normalizeFramingView(this.framingView, {
        hasSource: hasSourceBackground(this.activePrompt)
      });
    }
    this.#layoutReviewPlate();
    this.#ensureReviewPlateStage();
    this.#refreshExpiryTicker();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#destroyFramingEditor();
    this.#destroyReviewPlateStage();
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
    this.draft.timerSeconds = Number(data.get("timerSeconds"));
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
    if ( !validTimerSeconds(draft.timerSeconds) ) return warn("DRAWING-PROMPTS.manager.validation.timerSeconds");
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
        fitMode: this.draft.background.fitMode || setting(SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_CANVAS),
        naturalWidth: loaded.naturalWidth,
        naturalHeight: loaded.naturalHeight,
        framing: defaultFramingForBackground({
          sourceType,
          path: loaded.path,
          naturalWidth: loaded.naturalWidth,
          naturalHeight: loaded.naturalHeight
        }),
        framedPath: null
      };
      this.#previewBackgroundImage = { path: loaded.path, img: loaded.img };
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
    return {
      ...this.draft,
      selectedCount: this.draft.selectedUserIds.size,
      hasBackground: Boolean(this.draft.background.path),
      backgroundLabel: this.draft.background.path || game.i18n.localize("DRAWING-PROMPTS.background.blank")
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
    const timerCountdown = formatTimerState(this.activePrompt.timerState, Date.now(), {
      left: game.i18n.localize("DRAWING-PROMPTS.manager.timer.left"),
      over: game.i18n.localize("DRAWING-PROMPTS.manager.timer.over")
    });
    const hasBackground = Boolean(this.activePrompt.background?.path);
    return {
      promptText,
      promptPreview: truncated.text,
      promptTruncated: truncated.truncated,
      drawingName: this.activePrompt.drawingName || game.i18n.localize("DRAWING-PROMPTS.player.untitled"),
      hasTimer: this.activePrompt.timerStatus !== "none",
      timerDuration: formatClock(timerSeconds * 1000),
      timerCountdownText: timerCountdown.text,
      timerOvertime: timerCountdown.overtime,
      timerPaused: this.activePrompt.timerStatus === "paused",
      hasBackground,
      backgroundPath: hasBackground ? this.activePrompt.background.path : "",
      backgroundLabel: hasBackground
        ? game.i18n.format("DRAWING-PROMPTS.manager.summary.backgroundTooltip", { path: this.activePrompt.background.path })
        : ""
    };
  }

  /**
   * Build GM timer control labels and signed adjustment values.
   * @returns {object|null}
   */
  #timerControlsContext() {
    if ( !this.activePrompt ) return null;
    const paused = this.activePrompt.timerStatus === "paused";
    const disabled = this.activePrompt.timerStatus === "none";
    const extendShort = timerSettingSeconds(SETTINGS.TIMER_EXTEND_SHORT, 30);
    const extendLong = timerSettingSeconds(SETTINGS.TIMER_EXTEND_LONG, 120);
    const reduceShort = timerSettingSeconds(SETTINGS.TIMER_REDUCE_SHORT, 30);
    const reduceLong = timerSettingSeconds(SETTINGS.TIMER_REDUCE_LONG, 120);
    return {
      disabled,
      paused,
      toggleLabel: game.i18n.localize(paused
        ? "DRAWING-PROMPTS.manager.actions.resumeTimer"
        : "DRAWING-PROMPTS.manager.actions.pauseTimer"),
      adjustments: [
        {
          deltaMs: -reduceLong * 1000,
          label: formatTimerAdjustment(reduceLong, -1),
          tooltip: game.i18n.localize("DRAWING-PROMPTS.manager.timer.reduce"),
          isMinus: true
        },
        {
          deltaMs: -reduceShort * 1000,
          label: formatTimerAdjustment(reduceShort, -1),
          tooltip: game.i18n.localize("DRAWING-PROMPTS.manager.timer.reduce"),
          isMinus: true
        },
        {
          deltaMs: extendShort * 1000,
          label: formatTimerAdjustment(extendShort, 1),
          tooltip: game.i18n.localize("DRAWING-PROMPTS.manager.timer.extend"),
          isMinus: false
        },
        {
          deltaMs: extendLong * 1000,
          label: formatTimerAdjustment(extendLong, 1),
          tooltip: game.i18n.localize("DRAWING-PROMPTS.manager.timer.extend"),
          isMinus: false
        }
      ]
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
   * Size the compose Canvas plate to draft Prompt canvas aspect inside the void stage.
   * Stage uses min-height:0 + height/max-height caps so the host can shrink with the window
   * even though the plate child has explicit px size.
   * @returns {void}
   */
  #layoutFramingPlate() {
    if ( this.activePrompt ) return;
    const stage = this.element?.querySelector("[data-dp-framing-stage]");
    const plate = stage?.querySelector(".dp-framing-plate");
    if ( !stage || !plate ) return;
    layoutPlateInStage(plate, stage, {
      width: this.draft.canvasWidth,
      height: this.draft.canvasHeight
    });
  }

  /**
   * Size the review Canvas plate for the current Framing View aspect.
   * @returns {void}
   */
  #layoutReviewPlate() {
    if ( !this.activePrompt ) return;
    const stage = this.element?.querySelector("[data-dp-review-stage]");
    const plate = stage?.querySelector("[data-dp-review-plate]");
    if ( !stage || !plate ) return;
    const hasSource = hasSourceBackground(this.activePrompt);
    const framingView = this.#committedReviewFramingView
      ?? normalizeFramingView(this.framingView, { hasSource });
    const aspect = resolveReviewPlateAspect({
      framingView,
      prompt: this.activePrompt,
      hasSource
    });
    layoutPlateInStage(plate, stage, aspect);
  }

  /**
   * Observe the review plate stage for void-host resizes.
   * @returns {void}
   */
  #ensureReviewPlateStage() {
    if ( !this.activePrompt ) {
      this.#destroyReviewPlateStage();
      return;
    }
    const stage = this.element?.querySelector("[data-dp-review-stage]");
    const host = this.element?.querySelector(".dp-preview-panel fieldset");
    if ( !stage ) return;
    this.#reviewPlateResizeObserver?.disconnect();
    if ( typeof ResizeObserver !== "undefined" ) {
      this.#reviewPlateResizeObserver = new ResizeObserver(() => this.#layoutReviewPlate());
      this.#reviewPlateResizeObserver.observe(stage);
      if ( host ) this.#reviewPlateResizeObserver.observe(host);
    }
  }

  /**
   * Tear down review plate resize observation.
   * @returns {void}
   */
  #destroyReviewPlateStage() {
    this.#reviewPlateResizeObserver?.disconnect();
    this.#reviewPlateResizeObserver = null;
  }

  /**
   * Repaint the Prompt Framing editor plate over the source image.
   * @returns {void}
   */
  #updateFramingEditor() {
    if ( this.activePrompt ) return;
    const canvasEl = this.element?.querySelector("[data-dp-framing-plate]");
    if ( !canvasEl ) return;
    const emptyEl = this.element?.querySelector("[data-dp-framing-empty]");
    const { path, naturalWidth, naturalHeight } = this.draft.background;
    const img = path && this.#previewBackgroundImage?.path === path ? this.#previewBackgroundImage.img : null;
    const hasImage = Boolean(img);
    emptyEl?.toggleAttribute("hidden", hasImage);
    canvasEl.toggleAttribute("hidden", !hasImage);
    for ( const button of this.element?.querySelectorAll(".dp-framing-controls button") ?? [] ) {
      button.disabled = !hasImage;
    }
    // Aspect-true plate first so bitmap metrics match draft canvas W×H.
    this.#layoutFramingPlate();
    if ( !img ) return;
    const framing = resolveDraftFraming(this.draft.background);
    if ( !framing ) return;
    // Measure the plate (not the void stage) so pan/zoom map to the painted surface.
    const viewportEl = canvasEl.parentElement;
    const viewportWidth = Math.max(
      1,
      Math.round(viewportEl?.clientWidth || canvasEl.clientWidth || 1)
    );
    const viewportHeight = Math.max(
      1,
      Math.round(viewportEl?.clientHeight || canvasEl.clientHeight || 1)
    );
    if ( canvasEl.width === viewportWidth && canvasEl.height === viewportHeight ) {
      // Still repaint (pan/zoom), but skip attribute resize when size is stable.
    } else {
      canvasEl.width = viewportWidth;
      canvasEl.height = viewportHeight;
    }
    drawFramingEditor(canvasEl.getContext("2d"), img, {
      framing,
      sourceWidth: naturalWidth,
      sourceHeight: naturalHeight,
      fitMode: this.draft.background.fitMode,
      canvasWidth: this.draft.canvasWidth,
      canvasHeight: this.draft.canvasHeight,
      viewportWidth,
      viewportHeight
    });
  }

  /**
   * Apply a Prompt Framing rect to the draft and refresh previews.
   * Manual pan/zoom switches Fit mode to Placed and locks crop aspect to GM canvas dims
   * (only Stretch may use anisotropic fill of non-matching ROI).
   * Framing reset leaves Fit mode alone (full-source rect; may remain Placed).
   * @param {{x: number, y: number, width: number, height: number}} framing Framing rect.
   * @param {{fromPanZoom?: boolean}} [options] When true, set Fit mode to Placed and lock aspect.
   * @returns {void}
   */
  #applyDraftFraming(framing, { fromPanZoom = false } = {}) {
    if ( this.activePrompt || !this.draft.background.path ) return;
    let next = { ...framing };
    if ( fromPanZoom ) {
      const canvasWidth = this.draft.canvasWidth;
      const canvasHeight = this.draft.canvasHeight;
      const previousFitMode = this.draft.background.fitMode;
      const enteringPlaced = previousFitMode !== FIT_MODE.PLACED;
      if ( enteringPlaced && (
        previousFitMode === FIT_MODE.STRETCH || !framingMatchesCanvasAspect(next, canvasWidth, canvasHeight)
      ) ) {
        next = framingForPlacedStart({
          sourceWidth: this.draft.background.naturalWidth,
          sourceHeight: this.draft.background.naturalHeight,
          framing: next,
          canvasWidth,
          canvasHeight
        });
      } else {
        next = lockFramingToCanvasAspect(next, canvasWidth, canvasHeight);
      }
      this.draft.background.framing = next;
      this.#setDraftFitMode(FIT_MODE.PLACED);
    } else {
      this.draft.background.framing = next;
    }
    this.#updateFramingEditor();
  }

  /**
   * Set draft Fit mode and keep the fit-mode select in sync without full re-render.
   * @param {string} fitMode Fit mode value.
   * @returns {void}
   */
  #setDraftFitMode(fitMode) {
    this.draft.background.fitMode = fitMode;
    const select = this.element?.querySelector?.("#dp-fit-mode");
    if ( select && select.value !== fitMode ) select.value = fitMode;
  }

  /**
   * React to a Fit mode select change.
   * Non-Placed modes reset framing to full source.
   * Placed: seed a canvas-aspect ROI containing the current framing (Fit Canvas-like start).
   * @param {string} previousFitMode Fit mode before the form sync.
   * @param {string} nextFitMode Fit mode after the form sync.
   * @returns {void}
   */
  #handleFitModeChange(previousFitMode, nextFitMode) {
    if ( nextFitMode === FIT_MODE.PLACED ) {
      const { naturalWidth, naturalHeight, path } = this.draft.background;
      if ( !path || !(Number(naturalWidth) > 0 && Number(naturalHeight) > 0) ) return;
      const current = resolveDraftFraming(this.draft.background);
      this.draft.background.framing = framingForPlacedStart({
        sourceWidth: naturalWidth,
        sourceHeight: naturalHeight,
        framing: current,
        canvasWidth: this.draft.canvasWidth,
        canvasHeight: this.draft.canvasHeight
      });
      return;
    }
    const full = framingAfterFitModeSelect(this.draft.background, previousFitMode, nextFitMode);
    if ( full ) this.draft.background.framing = { ...full };
  }

  /**
   * Resolve the framing editor plate canvas and its display size.
   * @returns {{canvas: HTMLCanvasElement, width: number, height: number}|null}
   */
  #framingPlateMetrics() {
    const canvas = this.element?.querySelector("[data-dp-framing-plate]");
    if ( !canvas ) return null;
    return {
      canvas,
      width: Math.max(1, canvas.width || canvas.clientWidth || 1),
      height: Math.max(1, canvas.height || canvas.clientHeight || 1)
    };
  }

  /**
   * Attach pan/zoom handlers to the Prompt Framing editor plate.
   * @returns {void}
   */
  #ensureFramingEditor() {
    if ( this.activePrompt || this.#framingEditorAttached ) return;
    const root = this.element?.querySelector("[data-dp-framing-editor]");
    const stage = root?.querySelector("[data-dp-framing-stage]");
    const plate = root?.querySelector(".dp-framing-plate");
    if ( !plate ) return;

    const onWheel = event => this.#onFramingWheel(event);
    const onPointerDown = event => this.#onFramingPointerDown(event);
    const onPointerMove = event => this.#onFramingPointerMove(event);
    const onPointerUp = event => this.#onFramingPointerUp(event);
    const onDblClick = event => {
      event.preventDefault();
      this.#resetDraftFraming();
    };
    const onBlur = () => this.#endFramingPan();

    this.#framingEditorHandlers = { onWheel, onPointerDown, onPointerMove, onPointerUp, onDblClick, onBlur };
    this.#framingViewportEl = plate;
    plate.addEventListener("wheel", onWheel, { passive: false });
    plate.addEventListener("pointerdown", onPointerDown);
    plate.addEventListener("pointermove", onPointerMove);
    plate.addEventListener("pointerup", onPointerUp);
    plate.addEventListener("pointercancel", onPointerUp);
    plate.addEventListener("dblclick", onDblClick);
    window.addEventListener("blur", onBlur);
    if ( typeof ResizeObserver !== "undefined" ) {
      this.#framingResizeObserver = new ResizeObserver(() => this.#updateFramingEditor());
      // Observe the void stage so plate re-letterboxes when the pane resizes.
      this.#framingResizeObserver.observe(stage ?? plate);
    }
    this.#framingEditorAttached = true;
  }

  /**
   * Tear down Prompt Framing editor listeners.
   * @returns {void}
   */
  #destroyFramingEditor() {
    this.#endFramingPan();
    const viewport = this.#framingViewportEl;
    const handlers = this.#framingEditorHandlers;
    if ( viewport && handlers ) {
      viewport.removeEventListener("wheel", handlers.onWheel);
      viewport.removeEventListener("pointerdown", handlers.onPointerDown);
      viewport.removeEventListener("pointermove", handlers.onPointerMove);
      viewport.removeEventListener("pointerup", handlers.onPointerUp);
      viewport.removeEventListener("pointercancel", handlers.onPointerUp);
      viewport.removeEventListener("dblclick", handlers.onDblClick);
    }
    if ( handlers ) window.removeEventListener("blur", handlers.onBlur);
    this.#framingResizeObserver?.disconnect();
    this.#framingResizeObserver = null;
    this.#framingEditorHandlers = null;
    this.#framingViewportEl = null;
    this.#framingEditorAttached = false;
  }

  /**
   * Reset Prompt Framing to the full source image.
   * @returns {void}
   */
  #resetDraftFraming() {
    const { naturalWidth, naturalHeight, path } = this.draft.background;
    if ( !path || !(Number(naturalWidth) > 0 && Number(naturalHeight) > 0) ) return;
    this.#applyDraftFraming(resetFraming(naturalWidth, naturalHeight));
  }

  /**
   * Zoom the draft Prompt Framing about the viewport center.
   * @param {number} factor Zoom factor (>1 zooms in).
   * @returns {void}
   */
  #zoomDraftFraming(factor) {
    const framing = resolveDraftFraming(this.draft.background);
    const metrics = this.#framingPlateMetrics();
    if ( !framing || !metrics ) return;
    this.#applyDraftFraming(zoomFraming(framing, {
      factor,
      focusX: metrics.width / 2,
      focusY: metrics.height / 2,
      viewportWidth: metrics.width,
      viewportHeight: metrics.height,
      canvasWidth: this.draft.canvasWidth,
      canvasHeight: this.draft.canvasHeight
    }), { fromPanZoom: true });
  }

  /**
   * Handle wheel / trackpad gestures on the framing editor.
   * @param {WheelEvent} event Wheel event.
   * @returns {void}
   */
  #onFramingWheel(event) {
    const framing = resolveDraftFraming(this.draft.background);
    const metrics = this.#framingPlateMetrics();
    if ( !framing || !metrics ) return;
    event.preventDefault();
    const gesture = classifyWheelGesture(event);
    if ( gesture.type === "pan" ) {
      this.#applyDraftFraming(panFraming(framing, {
        dxDisplay: gesture.dx,
        dyDisplay: gesture.dy,
        viewportWidth: metrics.width,
        viewportHeight: metrics.height,
        canvasWidth: this.draft.canvasWidth,
        canvasHeight: this.draft.canvasHeight
      }), { fromPanZoom: true });
      return;
    }
    const rect = metrics.canvas.getBoundingClientRect();
    this.#applyDraftFraming(zoomFraming(framing, {
      factor: gesture.factor,
      focusX: event.clientX - rect.left,
      focusY: event.clientY - rect.top,
      viewportWidth: metrics.width,
      viewportHeight: metrics.height,
      canvasWidth: this.draft.canvasWidth,
      canvasHeight: this.draft.canvasHeight
    }), { fromPanZoom: true });
  }

  /**
   * Begin a framing-editor pan drag.
   * Primary (left) button pans; middle button remains an optional alternate.
   * @param {PointerEvent} event Pointer event.
   * @returns {void}
   */
  #onFramingPointerDown(event) {
    if ( event.button !== 0 && event.button !== 1 ) return;
    if ( !resolveDraftFraming(this.draft.background) ) return;
    event.preventDefault();
    this.#framingPanPointerId = event.pointerId;
    this.#framingPanLast = { x: event.clientX, y: event.clientY };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
  }

  /**
   * Continue a framing-editor pan drag.
   * @param {PointerEvent} event Pointer event.
   * @returns {void}
   */
  #onFramingPointerMove(event) {
    if ( this.#framingPanPointerId !== event.pointerId || !this.#framingPanLast ) return;
    const framing = resolveDraftFraming(this.draft.background);
    const metrics = this.#framingPlateMetrics();
    if ( !framing || !metrics ) return;
    const dxDisplay = event.clientX - this.#framingPanLast.x;
    const dyDisplay = event.clientY - this.#framingPanLast.y;
    this.#framingPanLast = { x: event.clientX, y: event.clientY };
    this.#applyDraftFraming(panFraming(framing, {
      dxDisplay,
      dyDisplay,
      viewportWidth: metrics.width,
      viewportHeight: metrics.height,
      canvasWidth: this.draft.canvasWidth,
      canvasHeight: this.draft.canvasHeight
    }), { fromPanZoom: true });
  }

  /**
   * End a framing-editor pan drag.
   * @param {PointerEvent} [event] Pointer event.
   * @returns {void}
   */
  #onFramingPointerUp(event) {
    if ( event && this.#framingPanPointerId !== event.pointerId ) return;
    event?.currentTarget?.releasePointerCapture?.(this.#framingPanPointerId);
    this.#endFramingPan();
  }

  /**
   * Clear framing-editor pan drag state.
   * @returns {void}
   */
  #endFramingPan() {
    this.#framingPanPointerId = null;
    this.#framingPanLast = null;
  }

  /**
   * Load a persisted draft background that was not selected during this session.
   * Concurrent renders share the same request, and stale completions cannot replace
   * a newer background selection.
   * @returns {Promise<void>}
   */
  async #ensurePreviewBackgroundImage() {
    if ( this.activePrompt ) return;
    const path = this.draft.background.path;
    if ( !path || this.#previewBackgroundImage?.path === path ) return;
    if ( this.#previewBackgroundLoad?.path === path ) return this.#previewBackgroundLoad.promise;

    const request = loadBackgroundImage(path);
    const promise = (async () => {
      try {
        const loaded = await request;
        if ( this.#previewBackgroundLoad?.promise !== promise || this.draft.background.path !== path ) return;
        this.#previewBackgroundImage = { path, img: loaded.img };
        this.#updateFramingEditor();
      } catch {
        // Selection-time validation already reports load errors; keep restored drafts blank if the asset disappeared.
      } finally {
        if ( this.#previewBackgroundLoad?.promise === promise ) this.#previewBackgroundLoad = null;
      }
    })();
    this.#previewBackgroundLoad = { path, promise };
    return promise;
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
    const isExpired = this.activePrompt?.timerStatus === "running"
      ? assignment?.isExpired(this.activePrompt.deadlineAt, now) ?? false
      : false;
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
        : "",
      lacksFileUpload: !userCanUploadFiles(user),
      fileUploadTooltip: game.i18n.localize("DRAWING-PROMPTS.manager.fileUpload.tooltip")
    };
  }

  /**
   * Build Framing View toggle context for review mode.
   * @param {boolean} hasSource Whether Full Framing is available for this Prompt.
   * @param {string} framingView Current Framing View.
   * @returns {{visible: boolean, options: object[]}}
   */
  #framingViewToggleContext(hasSource, framingView) {
    if ( !hasSource ) return { visible: false, options: [] };
    return {
      visible: true,
      label: game.i18n.localize("DRAWING-PROMPTS.manager.framingView.label"),
      options: [
        {
          value: FRAMING_VIEW.PROMPT_CANVAS,
          selected: framingView === FRAMING_VIEW.PROMPT_CANVAS,
          label: game.i18n.localize("DRAWING-PROMPTS.manager.framingView.promptCanvas")
        },
        {
          value: FRAMING_VIEW.FULL,
          selected: framingView === FRAMING_VIEW.FULL,
          label: game.i18n.localize("DRAWING-PROMPTS.manager.framingView.fullFraming")
        }
      ]
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
   * @returns {void}
   */
  static #onSetFramingView(_event, target) {
    const hasSource = hasSourceBackground(this.activePrompt);
    const next = normalizeFramingView(target?.dataset?.framingView, { hasSource });
    if ( next === this.framingView ) return;
    // Session UI only — must not touch clearFramingViewAssets / savedSubmissionTs (Save gate).
    this.framingView = next;
    this.#framingPreviewEpoch += 1;
    // Re-arm the players' overlay gate for the new view: on it supplies live remap ink, off stops the bytes.
    void this.#requestLiveSnapshots();
    this.#updateFramingViewToggle();
    this.#updatePlaceActionsForFramingView();
    // Single atomic preview update (aspect + image together) — do not layout before the new src is ready.
    void this.#refreshSelectedPreview();
  }

  /**
   * @this {DrawingPromptManager}
   * @returns {void}
   */
  static #onFramingZoomIn() {
    this.#zoomDraftFraming(FRAMING_ZOOM_STEP);
  }

  /** @this {DrawingPromptManager} */
  static #onFramingZoomOut() {
    this.#zoomDraftFraming(1 / FRAMING_ZOOM_STEP);
  }

  /** @this {DrawingPromptManager} */
  static #onFramingReset() {
    this.#resetDraftFraming();
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
    this.#previewBackgroundImage = null;
    await this.render({ parts: ["body"] });
  }

  /** @this {DrawingPromptManager} */
  static async #onSendPrompt() {
    const draft = this.#serviceDraft();
    if ( !this.#validateDraft(draft) ) return;
    this.#warnSelectedUsersWithoutFileUpload(draft.selectedUserIds);
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = await service.createAndSendPrompt(draft);
    this.selectedAssignmentId = Object.keys(this.activePrompt.assignments)[0] ?? null;
    await this.render({ parts: ["body"] });
  }

  /** @this {DrawingPromptManager} */
  static async #onToggleTimer() {
    if ( !this.activePrompt || this.activePrompt.timerStatus === "none" ) return;
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = this.activePrompt.timerStatus === "paused"
      ? await service.resumePromptTimer(this.activePrompt.id)
      : await service.pausePromptTimer(this.activePrompt.id);
  }

  /** @this {DrawingPromptManager} */
  static async #onResetTimer() {
    if ( !this.activePrompt || this.activePrompt.timerStatus === "none" ) return;
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = await service.resetPromptTimer(this.activePrompt.id);
  }

  /** @this {DrawingPromptManager} */
  static async #onStopTimer() {
    if ( !this.activePrompt || this.activePrompt.timerStatus === "none" ) return;
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = await service.stopPromptTimer(this.activePrompt.id);
  }

  /** @this {DrawingPromptManager} */
  static async #onAdjustTimer(_event, target) {
    if ( !this.activePrompt || this.activePrompt.timerStatus === "none" ) return;
    const deltaMs = Number(target.dataset.deltaMs);
    if ( !Number.isFinite(deltaMs) ) return;
    const service = await import("../prompts/prompt-service.mjs");
    this.activePrompt = await service.adjustPromptTimer(this.activePrompt.id, deltaMs);
  }

  /**
   * Warn when selected users cannot stage full-resolution uploads.
   * @param {string[]} selectedUserIds Selected user ids.
   * @returns {void}
   */
  #warnSelectedUsersWithoutFileUpload(selectedUserIds) {
    const selected = new Set(selectedUserIds);
    const names = userValues()
      .filter(user => !user.isGM && selected.has(user.id) && !userCanUploadFiles(user))
      .map(user => user.name);
    if ( names.length ) {
      ui.notifications.warn(game.i18n.format("DRAWING-PROMPTS.manager.warnings.noFileUpload", { names: names.join(", ") }));
    }
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
    const { serializeFramedBackgroundForPreview } = await import("../prompts/framed-delivery.mjs");
    const background = await serializeFramedBackgroundForPreview(this.draft);
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
        background,
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
  static async #onOpenPlaceDialog(_event, target) {
    const assignmentId = target.dataset.assignmentId || this.selectedAssignmentId;
    const assignment = this.activePrompt?.getAssignment(assignmentId);
    if ( !assignment ) return;
    const framingView = normalizeFramingView(this.framingView, {
      hasSource: hasSourceBackground(this.activePrompt)
    });
    const imagePath = resolveFramingViewAssetPath(assignment, framingView);
    const { PlaceDialog } = await import("./place-dialog.mjs");
    try {
      // Dialog stays visible for mode selection; canvas yield starts after Place commits.
      const dialog = await PlaceDialog.open(assignment, { framingView, imagePath });
      await waitForApplicationClose(dialog);
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }

  /** @this {DrawingPromptManager} */
  static async #onApplyTransform(_event, target) {
    const assignmentId = target.dataset.assignmentId || this.selectedAssignmentId;
    if ( !assignmentId ) return;
    const framingView = normalizeFramingView(this.framingView, {
      hasSource: hasSourceBackground(this.activePrompt)
    });
    const service = await import("../prompts/prompt-service.mjs");
    try {
      await DrawingPromptManager.withCanvasYield(async () => {
        await service.applyAssignmentTransform(assignmentId, { framingView });
      });
    } catch (err) {
      ui.notifications.warn(err.message);
    }
  }

  /** @this {DrawingPromptManager} */
  static async #onSwitchPrompt(_event, target) {
    const promptId = target?.value ?? target?.dataset?.promptId;
    await this.#switchToPrompt(String(promptId || ""));
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
      this.latestOverlaySnapshots.clear();
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
   * Prompt the GM for saved drawing details.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<{name: string, folder: string}|null>} Save details or null when cancelled.
   */
  async #promptForSaveDetails(assignmentId) {
    const assignment = this.activePrompt?.getAssignment(assignmentId);
    if ( !assignment ) return null;
    const fallback = assignment.assets?.name || defaultAssignmentAssetName({
      drawingName: this.activePrompt.drawingName,
      promptText: this.activePrompt.promptText
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
      // Non-modal: a modal <dialog> traps the top layer, which leaves the folder FilePicker
      // (opened from within this dialog) uninteractable underneath it.
      modal: false,
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
   * Resolve preview source and heading for the selected assignment via deep Assignment review.
   * @param {import("../prompts/prompt-models.mjs").DrawingAssignment|null} assignment Selected assignment.
   * @param {string} [framingView] Framing View for this preview.
   * @returns {Promise<import("../prompts/assignment-review.mjs").AssignmentReviewResult>}
   */
  async #selectedPreviewContext(assignment, framingView = FRAMING_VIEW.PROMPT_CANVAS) {
    let pendingSubmission = null;
    if ( assignment?.status === STATUS.SUBMITTED ) {
      const service = await import("../prompts/prompt-service.mjs");
      pendingSubmission = service.getPendingSubmission(assignment.id);
    }
    return resolveAssignmentReview({
      assignment,
      prompt: this.activePrompt,
      framingView,
      liveSnapshot: assignment ? (this.latestSnapshots.get(assignment.id) ?? null) : null,
      liveOverlaySnapshot: assignment ? (this.latestOverlaySnapshots.get(assignment.id) ?? null) : null,
      pendingSubmission,
      remapCache: this.#sourceFramingPreviewCache,
      localize: key => game.i18n.localize(key)
    });
  }

  /**
   * Ask active player clients for a fresh live snapshot, telling them whether the
   * current Framing View needs overlay (ink-only) bytes for its live remap.
   * @param {object} [options] Options.
   * @param {string|null} [options.assignmentId=null] Limit the request to one assignment.
   * @returns {Promise<void>}
   */
  async #requestLiveSnapshots({ assignmentId = null } = {}) {
    if ( !this.activePrompt || !isSocketReady() ) return;
    const includeOverlay = framingViewNeedsLiveOverlay(this.framingView, {
      hasSource: hasSourceBackground(this.activePrompt)
    });
    for ( const assignment of Object.values(this.activePrompt.assignments) ) {
      if ( assignmentId && assignment.id !== assignmentId ) continue;
      if ( !assignment.isActive || !game.users.get(assignment.userId)?.active ) continue;
      await emit.requestSnapshot(assignment.userId, assignment.id, { includeOverlay });
    }
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
   * Build review-mode prompt queue context.
   * @returns {{options: Array<{id: string, label: string, selected: boolean}>}|null}
   */
  #promptQueueContext() {
    const prompts = this.#unfinishedPrompts();
    if ( prompts.length <= 1 ) return null;
    return {
      options: prompts.map(prompt => ({
        id: prompt.id,
        label: prompt.drawingName || prompt.promptText || prompt.id,
        selected: prompt.id === this.activePrompt?.id
      }))
    };
  }

  /**
   * Switch the manager to another unfinished prompt.
   * @param {string} promptId Prompt id.
   * @returns {Promise<void>}
   */
  async #switchToPrompt(promptId) {
    if ( !promptId || promptId === this.activePrompt?.id ) return;
    this.activePrompt = loadPrompt(promptId);
    if ( !this.activePrompt ) return;
    this.#adoptDraftFromPrompt();
    this.selectedAssignmentId = Object.keys(this.activePrompt.assignments)[0] ?? null;
    this.latestSnapshots.clear();
    this.latestOverlaySnapshots.clear();
    this.#sourceFramingPreviewCache.clear();
    this.framingView = normalizeFramingView(this.framingView, {
      hasSource: hasSourceBackground(this.activePrompt)
    });
    this.#hydrateSnapshotCache();
    await this.#hydrateSubmissionCache();
    await this.#requestLiveSnapshots();
    await this.render({ parts: ["body"] });
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
   * Update Framing View toggle selected state without re-rendering the manager body.
   * @returns {void}
   */
  #updateFramingViewToggle() {
    const toggle = this.element?.querySelector(".dp-framing-view-toggle");
    if ( !toggle ) return;
    for ( const button of toggle.querySelectorAll("[data-action='setFramingView']") ) {
      const selected = button.dataset.framingView === this.framingView;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  /**
   * Resolve and paint the selected assignment preview for the current Framing View.
   * Guards against stale async completions when Framing View or assignment changes mid-resolve.
   * @returns {Promise<void>}
   */
  async #refreshSelectedPreview() {
    const assignment = this.#selectedAssignment();
    const assignmentId = this.selectedAssignmentId;
    const framingView = this.framingView;
    const resolveSeq = ++this.#previewResolveSeq;
    const epoch = this.#framingPreviewEpoch;
    const preview = await this.#selectedPreviewContext(assignment, framingView);
    if ( resolveSeq !== this.#previewResolveSeq ) return;
    if ( this.selectedAssignmentId !== assignmentId || this.framingView !== framingView ) return;
    if ( epoch !== this.#framingPreviewEpoch ) return;
    // Live Full Framing often resolves before overlay ink arrives. Keep the Prompt-canvas
    // pixels until remapped Full Framing is ready — never paint bare source as an interim.
    if ( preview.pendingRemap ) {
      const legend = this.element?.querySelector(".dp-preview-panel fieldset > legend");
      if ( legend ) legend.textContent = preview.heading;
      return;
    }
    const legend = this.element?.querySelector(".dp-preview-panel fieldset > legend");
    if ( legend ) legend.textContent = preview.heading;
    await this.#setPreviewFrame(preview.src, { epoch, framingView });
  }

  /**
   * Sync place/transform enablement and tooltips after a Framing View change.
   * @returns {void}
   */
  #updatePlaceActionsForFramingView() {
    const assignment = this.#selectedAssignment();
    const canPlace = canPlaceFramingView(assignment, this.framingView);
    const actions = this.element?.querySelector(".dp-submission-actions");
    if ( !actions ) return;
    actions.classList.toggle("is-place-disabled", !canPlace);
    for ( const button of actions.querySelectorAll("[data-action='openPlaceDialog'], [data-action='applyTransform']") ) {
      button.disabled = !canPlace;
    }
    const placementActions = actions.querySelector(".dp-placement-actions");
    if ( placementActions ) {
      if ( canPlace ) {
        placementActions.removeAttribute("data-tooltip");
      } else {
        placementActions.dataset.tooltip = game.i18n.localize("DRAWING-PROMPTS.manager.actions.saveFirst");
      }
    }
    const transformWrap = actions.querySelector("[data-action='applyTransform']")?.parentElement;
    if ( transformWrap ) {
      if ( canPlace ) transformWrap.removeAttribute("data-tooltip");
      else transformWrap.dataset.tooltip = game.i18n.localize("DRAWING-PROMPTS.transform.saveFirst");
    }
    const savedIndicator = this.element?.querySelector(".dp-saved-indicator");
    if ( savedIndicator && assignment && isSaveGateOpen(assignment) ) {
      const path = resolveFramingViewAssetPath(assignment, this.framingView)
        ?? assignment.primaryImagePath
        ?? "";
      if ( path ) {
        savedIndicator.dataset.tooltip = game.i18n.format("DRAWING-PROMPTS.manager.savedTooltip", { path });
      }
    }
  }

  /**
   * Update the review-mode preview frame without rerendering the full form.
   * Layout + image swap happen together after the bitmap is ready so Framing View
   * switches never flash a stretched prior image at the new aspect.
   * @param {string|null} src Preview image URL or data URL.
   * @param {{epoch?: number|null, framingView?: string|null}} [options] Optional guards / committed view.
   * @returns {Promise<void>}
   */
  async #setPreviewFrame(src, { epoch = null, framingView = null } = {}) {
    const frame = this.element?.querySelector(".is-review [data-dp-review-plate]")
      ?? this.element?.querySelector(".is-review .dp-preview-frame");
    if ( !frame ) return;
    if ( epoch != null && epoch !== this.#framingPreviewEpoch ) return;
    const commitView = framingView
      ?? normalizeFramingView(this.framingView, { hasSource: hasSourceBackground(this.activePrompt) });
    if ( src ) {
      const ready = await decodePreviewImage(src);
      if ( epoch != null && epoch !== this.#framingPreviewEpoch ) return;
      if ( !frame.isConnected ) return;

      let img = frame.querySelector("img");
      frame.querySelector(".dp-empty")?.remove();
      if ( !img ) {
        frame.replaceChildren();
        img = document.createElement("img");
        img.alt = game.i18n.localize("DRAWING-PROMPTS.manager.alt.assignmentPreview");
        frame.append(img);
      }
      // Commit aspect with the bitmap in one turn — ResizeObserver must not layout to the
      // toggle's Framing View while the prior live Prompt-canvas image is still showing.
      this.#committedReviewFramingView = commitView;
      if ( ready?.src ) img.src = ready.src;
      else img.src = src;
      this.#layoutReviewPlate();
      return;
    }
    frame.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "dp-empty";
    empty.textContent = game.i18n.localize("DRAWING-PROMPTS.manager.empty.noSnapshot");
    frame.append(empty);
    this.#committedReviewFramingView = commitView;
    this.#layoutReviewPlate();
  }

  /**
   * Update the preview image without rerendering the full form.
   * @param {string} dataUrl Snapshot data URL.
   * @returns {void}
   */
  #updatePreviewImage(dataUrl) {
    void this.#setPreviewFrame(dataUrl, {
      epoch: this.#framingPreviewEpoch,
      framingView: this.framingView
    });
  }

  /**
   * Start or stop the expired-row ticker.
   * @returns {void}
   */
  #refreshExpiryTicker() {
    const shouldTick = Boolean(
      this.activePrompt?.timerStatus === "running"
      && Number.isFinite(this.activePrompt.deadlineAt)
    );
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
    if ( !chip || !this.activePrompt ) return;
    const timer = formatTimerState(this.activePrompt.timerState, Date.now(), {
      left: game.i18n.localize("DRAWING-PROMPTS.manager.timer.left"),
      over: game.i18n.localize("DRAWING-PROMPTS.manager.timer.over")
    });
    chip.textContent = timer.text;
    chip.classList.toggle("is-overtime", timer.overtime);
    const summary = chip.closest(".dp-summary-timer");
    summary?.classList.toggle("is-overtime", timer.overtime);
    summary?.classList.toggle("is-paused", this.activePrompt.timerStatus === "paused");
  }

  /**
   * Build a compact signature for active assignment expiry styling.
   * @returns {string}
   */
  #expirySignature() {
    if ( this.activePrompt?.timerStatus !== "running" || !Number.isFinite(this.activePrompt.deadlineAt) ) return "";
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
 * Read a timer adjustment setting as nonnegative whole seconds.
 * @param {string} key Setting key.
 * @param {number} fallback Fallback seconds.
 * @returns {number}
 */
function timerSettingSeconds(key, fallback) {
  const seconds = Number(setting(key, fallback));
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : fallback;
}

/**
 * Test whether a draft timer is a nonnegative whole number of seconds.
 * @param {*} value Draft timer value.
 * @returns {boolean}
 */
function validTimerSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && Number.isInteger(seconds) && seconds >= 0;
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
 * Test whether a user document can upload files.
 * @param {User} user Foundry user.
 * @returns {boolean} Whether uploads are allowed.
 */
function userCanUploadFiles(user) {
  return Boolean(user?.can?.(FILES_UPLOAD_PERMISSION));
}

/**
 * Whether a framing ROI matches Prompt canvas aspect closely enough for isotropic Placed fill.
 * @param {{width?: number, height?: number}} framing Framing rect.
 * @param {number} canvasWidth Canvas width.
 * @param {number} canvasHeight Canvas height.
 * @returns {boolean}
 */
function framingMatchesCanvasAspect(framing, canvasWidth, canvasHeight) {
  const fw = Number(framing?.width);
  const fh = Number(framing?.height);
  const cw = Number(canvasWidth);
  const ch = Number(canvasHeight);
  if ( !(fw > 0 && fh > 0 && cw > 0 && ch > 0) ) return false;
  return Math.abs(fw / fh - cw / ch) < 1e-3;
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
 * Decode a preview URL into an Image so Framing View swaps can layout after the bitmap is ready.
 * @param {string} src Image URL or data URL.
 * @returns {Promise<HTMLImageElement|null>}
 */
function decodePreviewImage(src) {
  if ( !src ) return Promise.resolve(null);
  return new Promise(resolve => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    if ( img.complete && img.naturalWidth > 0 ) resolve(img);
  });
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
    [FIT_MODE.FIT_CANVAS]: "fitCanvas",
    [FIT_MODE.STRETCH]: "stretch",
    [FIT_MODE.PLACED]: "placed"
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
