import { INTERNAL, MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { DrawingEngine } from "../drawing/drawing-engine.mjs";
import { buildFullSubmission, buildSubmission } from "../drawing/export-service.mjs";
import { loadBackgroundImage } from "../foundry/background-source-service.mjs";
import { canStageUploads, stageSubmissionImages } from "../prompts/asset-service.mjs";
import { updateStatus } from "../prompts/client-store.mjs";
import { emit, isSocketReady } from "../socket.mjs";
import { createLeadingTrailingThrottle } from "../utils/throttle.mjs";
import { formatClock, formatTimerState } from "../utils/timer-chip.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Player drawing window for an assignment.
 */
export class PlayerDrawingApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #registry = new Map();

  static DEFAULT_OPTIONS = {
    id: "drawing-prompts-player-{id}",
    classes: ["drawing-prompts", "drawing-prompts-player"],
    tag: "section",
    window: {
      title: "DRAWING-PROMPTS.player.title",
      icon: "fa-solid fa-paintbrush",
      resizable: true,
      positioned: true
    },
    position: { width: 820, height: 720 },
    actions: {
      setTool: PlayerDrawingApp.#onSetTool,
      clearLayer: PlayerDrawingApp.#onClearLayer,
      undo: PlayerDrawingApp.#onUndo,
      redo: PlayerDrawingApp.#onRedo,
      submit: PlayerDrawingApp.#onSubmit,
      reject: PlayerDrawingApp.#onReject,
      closeWindow: PlayerDrawingApp.#onCloseWindow
    }
  };

  static PARTS = {
    body: {
      template: "modules/drawing-prompts/templates/player-drawing-app.hbs"
    }
  };

  /**
   * Open or focus a drawing app.
   * @param {object} assignmentPayload Assignment payload.
   * @param {object} [options] Options.
   * @param {"live"|"preview"} [options.mode="live"] App mode.
   * @returns {Promise<PlayerDrawingApp>}
   */
  static async open(assignmentPayload, { mode = "live" } = {}) {
    const assignmentId = assignmentPayload.assignment.id;
    let app = this.#registry.get(assignmentId);
    if ( app ) {
      app.assignmentPayload = assignmentPayload;
      await app.render({ force: true });
      app.bringToFront();
      return app;
    }
    app = new this({ assignmentPayload, mode });
    this.#registry.set(assignmentId, app);
    await app.render({ force: true });
    app.bringToFront();
    return app;
  }

  /**
   * Apply a GM timer update to an open assignment window.
   * @param {string} assignmentId Assignment id.
   * @param {object} timerState Canonical timer state.
   * @returns {Promise<void>}
   */
  static async updateTimer(assignmentId, timerState) {
    const app = this.#registry.get(assignmentId);
    if ( !app ) return;
    const wasVisible = app.assignmentPayload.prompt.timerStatus !== "none";
    Object.assign(app.assignmentPayload.prompt, timerState);
    const isVisible = app.assignmentPayload.prompt.timerStatus !== "none";
    if ( wasVisible !== isVisible ) await app.render({ force: true });
    else app.#startTimer();
  }

  /**
   * Close a window for an assignment if it exists.
   * @param {string} assignmentId Assignment id.
   * @param {object} [options] Options.
   * @param {boolean} [options.silent=false] Suppress close socket emission.
   * @returns {Promise<void>}
   */
  static async closeAssignment(assignmentId, { silent = false } = {}) {
    const app = this.#registry.get(assignmentId);
    if ( !app ) return;
    if ( silent ) app.#closeReason = "remote";
    await app.close();
  }

  /**
   * Send an immediate snapshot for an open assignment window.
   * @param {string} assignmentId Assignment id.
   * @returns {Promise<void>}
   */
  static async sendSnapshotForAssignment(assignmentId) {
    const app = this.#registry.get(assignmentId);
    if ( app ) await app.#sendSnapshot();
  }

  /**
   * @param {object} options Constructor options.
   * @param {object} options.assignmentPayload Assignment payload.
   * @param {"live"|"preview"} options.mode App mode.
   */
  constructor({ assignmentPayload, mode = "live" } = {}) {
    super();
    this.assignmentPayload = assignmentPayload;
    this.mode = mode;
    this.#background = assignmentPayload.prompt.background ?? {};
    this.#color = initialBrushColor();
  }

  #background;
  #backgroundState = "idle";
  #backgroundError = null;
  #closeReason = null;
  #openedEmitted = false;
  #timerId = null;
  #engine = null;
  #engineReadyPromise = null;
  #snapshotThrottle = null;
  #activeTool = "brush";
  #color = "#000000";
  #brushSize = 8;
  #brushOpacity = 1;
  #unsubscribers = [];
  #wireScaledWarned = false;

  /** @override */
  async _prepareContext(options) {
    const assignment = this.assignmentPayload.assignment;
    const prompt = this.assignmentPayload.prompt;
    const width = Math.max(1, Number(prompt.canvasWidth) || 1);
    const height = Math.max(1, Number(prompt.canvasHeight) || 1);
    return {
      assignment,
      prompt,
      mode: this.mode,
      isPreview: this.mode === "preview",
      hasTimer: this.mode === "preview" ? Number(prompt.timerSeconds) > 0 : prompt.timerStatus !== "none",
      timerText: this.#timerText(),
      canvasStyle: `aspect-ratio: ${width} / ${height};`,
      backgroundError: this.#backgroundError,
      backgroundLoading: this.#backgroundState === "loading",
      activeTool: this.#activeTool,
      color: this.#color,
      brushSize: this.#brushSize,
      brushOpacity: this.#brushOpacity,
      brushOpacityPercent: formatPercent(this.#brushOpacity),
      canUndo: this.#engine?.canUndo ?? false,
      canRedo: this.#engine?.canRedo ?? false,
      toolButtons: this.#toolButtons()
    };
  }

  /** @override */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    if ( this.mode !== "live" || this.#openedEmitted ) return;
    this.#openedEmitted = true;
    await emit.assignmentOpened(this.assignmentPayload.prompt.gmUserId, this.assignmentPayload.assignment.id, game.user.id);
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#startTimer();
    await this.#ensureEngine();
    this.#wireToolbarInputs();
    this.#refreshToolbarState();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( this.#timerId ) window.clearInterval(this.#timerId);
    this.#timerId = null;
    this.#destroyEngine();
    this.constructor.#registry.delete(this.assignmentPayload.assignment.id);

    if ( this.mode === "live" && !this.#closeReason ) {
      emit.playerWindowClosed(this.assignmentPayload.prompt.gmUserId, this.assignmentPayload.assignment.id, game.user.id);
    }
    this.#closeReason = null;
  }

  /**
   * Confirm and submit the exported drawing.
   * @returns {Promise<void>}
   */
  async #submit() {
    if ( this.mode === "preview" ) return;
    if ( !this.#engine ) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.player.errors.engineUnavailable"));
      return;
    }
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.player.submit.title" },
      content: game.i18n.localize("DRAWING-PROMPTS.player.submit.confirm"),
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;

    const format = game.settings.get(MODULE_ID, SETTINGS.EXPORT_FORMAT) || "webp";
    const quality = Number(game.settings.get(MODULE_ID, SETTINGS.WEBP_QUALITY) ?? 0.9);
    let submissionPayload;
    try {
      submissionPayload = canStageUploads()
        ? await this.#buildStagedSubmissionPayload({ format, quality })
        : await buildSubmission(this.#engine, { format, quality });
    } catch (_err) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.player.errors.exportFailed"));
      return;
    }
    if ( submissionPayload.wireScaled && !this.#wireScaledWarned ) {
      this.#wireScaledWarned = true;
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.player.warnings.wireScaled"));
    }
    this.#closeReason = "submit";
    await emit.drawingSubmitted(this.assignmentPayload.prompt.gmUserId, this.assignmentPayload.assignment.id, game.user.id, submissionPayload);
    updateStatus(this.assignmentPayload.assignment.id, STATUS.SUBMITTED);
    await this.close();
  }

  /**
   * Build a staged payload, falling back to the socket lane if upload is rejected.
   * @param {{format: string, quality: number}} options Export options.
   * @returns {Promise<object>} Submission payload.
   */
  async #buildStagedSubmissionPayload({ format, quality }) {
    const fullSubmission = await buildFullSubmission(this.#engine, { format, quality });
    try {
      const staged = await stageSubmissionImages(this.assignmentPayload.assignment.id, fullSubmission);
      return {
        mode: "staged",
        staged,
        opLog: fullSubmission.opLog,
        width: fullSubmission.width,
        height: fullSubmission.height,
        formats: {
          overlay: fullSubmission.overlay?.format ?? format,
          merged: fullSubmission.merged?.format ?? null
        }
      };
    } catch (err) {
      console.warn("drawing-prompts | staged submission upload failed; falling back to socket lane", err);
      return buildSubmission(this.#engine, { format, quality });
    }
  }

  /**
   * Confirm and reject the assignment.
   * @returns {Promise<void>}
   */
  async #reject() {
    if ( this.mode === "preview" ) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.player.reject.title" },
      content: game.i18n.localize("DRAWING-PROMPTS.player.reject.confirm"),
      yes: { label: "DRAWING-PROMPTS.player.reject.yes", icon: "fa-solid fa-ban" },
      rejectClose: false,
      modal: true
    });
    if ( !confirmed ) return;
    this.#closeReason = "reject";
    await emit.drawingRejected(this.assignmentPayload.prompt.gmUserId, this.assignmentPayload.assignment.id, game.user.id, null);
    updateStatus(this.assignmentPayload.assignment.id, STATUS.REJECTED);
    await this.close();
  }

  /**
   * Ensure a drawing engine exists and is attached to the current canvas element.
   * @returns {Promise<void>}
   */
  async #ensureEngine() {
    const canvas = this.element?.querySelector(".dp-display-canvas");
    if ( !canvas || this.#backgroundError ) return;
    if ( this.#engineReadyPromise ) {
      await this.#engineReadyPromise;
      this.#engine?.attach(canvas);
      return;
    }
    if ( this.#engine ) {
      this.#engine.attach(canvas);
      return;
    }
    this.#engineReadyPromise = this.#createEngine(canvas).finally(() => {
      this.#engineReadyPromise = null;
    });
    await this.#engineReadyPromise;
  }

  /**
   * Create the drawing engine.
   * @param {HTMLCanvasElement} canvas Display canvas.
   * @returns {Promise<void>}
   */
  async #createEngine(canvas) {
    const prompt = this.assignmentPayload.prompt;
    let background = null;

    if ( this.#background?.path ) {
      this.#backgroundState = "loading";
      try {
        const loaded = await loadBackgroundImage(this.#background.path);
        this.#backgroundState = "loaded";
        background = {
          img: loaded.img,
          naturalWidth: loaded.naturalWidth,
          naturalHeight: loaded.naturalHeight
        };
      } catch (err) {
        this.#backgroundState = "failed";
        this.#backgroundError = err.code === "tainted"
          ? game.i18n.localize("DRAWING-PROMPTS.background.errors.tainted")
          : game.i18n.localize("DRAWING-PROMPTS.background.errors.loadFailed");
        await this.render({ parts: ["body"] });
        return;
      }
    }

    const engine = new DrawingEngine({
      width: prompt.canvasWidth,
      height: prompt.canvasHeight,
      background,
      fitMode: this.#background?.fitMode
    });
    engine.setTool(this.#activeTool);
    engine.setColor(this.#color);
    engine.setBrushSize(this.#brushSize);
    engine.setBrushOpacity(this.#brushOpacity);
    this.#unsubscribers = [
      engine.onChange(() => {
        this.#refreshToolbarState();
        this.#queueSnapshot();
      }),
      engine.onColorSampled(hex => this.#applySampledColor(hex)),
      engine.onWarning(key => ui.notifications.warn(game.i18n.localize(key)))
    ];
    this.#engine = engine;
    engine.attach(canvas);
  }

  /**
   * Destroy the current engine and subscriptions.
   * @returns {void}
   */
  #destroyEngine() {
    this.#snapshotThrottle?.cancel();
    this.#snapshotThrottle = null;
    for ( const unsubscribe of this.#unsubscribers ) unsubscribe();
    this.#unsubscribers = [];
    this.#engine?.destroy();
    this.#engine = null;
  }

  /**
   * Queue a throttled live-preview snapshot.
   * @returns {void}
   */
  #queueSnapshot() {
    if ( !this.#canSendSnapshots() ) return;
    this.#snapshotThrottle ??= createLeadingTrailingThrottle(() => this.#sendSnapshot(), {
      intervalMs: INTERNAL.SNAPSHOT_THROTTLE_MS
    });
    this.#snapshotThrottle();
  }

  /**
   * Send a snapshot immediately.
   * @returns {Promise<void>}
   */
  async #sendSnapshot() {
    if ( !this.#canSendSnapshots() || !this.#engine ) return;
    const snapshot = this.#engine.getCompositeSnapshot({
      maxEdge: INTERNAL.SNAPSHOT_MAX_EDGE,
      quality: INTERNAL.SNAPSHOT_QUALITY
    });
    await emit.drawingSnapshot(
      this.assignmentPayload.prompt.gmUserId,
      this.assignmentPayload.assignment.id,
      game.user.id,
      snapshot
    );
  }

  /**
   * Test whether live snapshot transmission is currently allowed.
   * @returns {boolean}
   */
  #canSendSnapshots() {
    return this.mode === "live"
      && Boolean(this.#engine)
      && isSocketReady()
      && Boolean(game.settings.get(MODULE_ID, SETTINGS.LIVE_PREVIEW));
  }

  /**
   * Wire color and size inputs after render.
   * @returns {void}
   */
  #wireToolbarInputs() {
    const colorInput = this.element?.querySelector(".dp-color-input");
    colorInput?.addEventListener("input", event => {
      this.#color = event.currentTarget.value;
      this.#engine?.setColor(this.#color);
      void game.settings.set(MODULE_ID, SETTINGS.LAST_BRUSH_COLOR, this.#color);
    });
    const sizeInput = this.element?.querySelector(".dp-size-input");
    sizeInput?.addEventListener("input", event => {
      this.#brushSize = Number(event.currentTarget.value);
      this.#engine?.setBrushSize(this.#brushSize);
      this.#refreshToolbarState();
    });
    const opacityInput = this.element?.querySelector(".dp-opacity-input");
    opacityInput?.addEventListener("input", event => {
      this.#brushOpacity = Number(event.currentTarget.value);
      this.#engine?.setBrushOpacity(this.#brushOpacity);
      this.#refreshToolbarState();
    });
  }

  /**
   * Select a tool.
   * @param {string} tool Tool name.
   * @returns {void}
   */
  #selectTool(tool) {
    if ( !["brush", "eraser", "fill", "eyedropper"].includes(tool) ) return;
    this.#activeTool = tool;
    this.#engine?.setTool(tool);
    this.#refreshToolbarState();
  }

  /**
   * Refresh toolbar DOM state without forcing an AppV2 rerender.
   * @returns {void}
   */
  #refreshToolbarState() {
    const root = this.element;
    if ( !root ) return;
    for ( const button of root.querySelectorAll("[data-tool]") ) {
      const active = button.dataset.tool === this.#activeTool;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    const undo = root.querySelector("[data-action='undo']");
    if ( undo ) undo.disabled = !this.#engine?.canUndo;
    const redo = root.querySelector("[data-action='redo']");
    if ( redo ) redo.disabled = !this.#engine?.canRedo;
    const sizeValue = root.querySelector(".dp-size-value");
    if ( sizeValue ) sizeValue.textContent = String(this.#brushSize);
    const opacityValue = root.querySelector(".dp-opacity-value");
    if ( opacityValue ) opacityValue.textContent = formatPercent(this.#brushOpacity);
    const colorInput = root.querySelector(".dp-color-input");
    if ( colorInput && colorInput.value !== this.#color ) colorInput.value = this.#color;
    const opacityInput = root.querySelector(".dp-opacity-input");
    if ( opacityInput && Number(opacityInput.value) !== this.#brushOpacity ) opacityInput.value = String(this.#brushOpacity);
    const canvas = root.querySelector(".dp-display-canvas");
    if ( canvas ) {
      canvas.classList.remove("tool-brush", "tool-eraser", "tool-fill", "tool-eyedropper");
      canvas.classList.add(`tool-${this.#activeTool}`);
    }
  }

  /**
   * Apply an eyedropper color sample to app state and controls.
   * @param {string} hex Sampled color.
   * @returns {void}
   */
  #applySampledColor(hex) {
    this.#color = hex;
    this.#engine?.setColor(hex);
    void game.settings.set(MODULE_ID, SETTINGS.LAST_BRUSH_COLOR, this.#color);
    this.#refreshToolbarState();
  }

  /**
   * Build tool button context.
   * @returns {object[]}
   */
  #toolButtons() {
    return [
      { name: "brush", icon: "fa-solid fa-paintbrush", label: "DRAWING-PROMPTS.player.tools.brush", active: this.#activeTool === "brush" },
      { name: "eraser", icon: "fa-solid fa-eraser", label: "DRAWING-PROMPTS.player.tools.eraser", active: this.#activeTool === "eraser" },
      { name: "fill", icon: "fa-solid fa-fill-drip", label: "DRAWING-PROMPTS.player.tools.fill", active: this.#activeTool === "fill" },
      { name: "eyedropper", icon: "fa-solid fa-eye-dropper", label: "DRAWING-PROMPTS.player.tools.eyedropper", active: this.#activeTool === "eyedropper" }
    ];
  }

  /**
   * Start or refresh the timer display.
   * @returns {void}
   */
  #startTimer() {
    if ( this.#timerId ) window.clearInterval(this.#timerId);
    this.#timerId = null;
    if ( !this.element?.querySelector(".dp-timer-value") ) return;
    const update = () => {
      const el = this.element?.querySelector(".dp-timer-value");
      if ( el ) el.textContent = this.#timerText();
    };
    update();
    if ( this.mode === "preview" || this.assignmentPayload.prompt.timerStatus !== "running" ) return;
    this.#timerId = window.setInterval(update, 1000);
  }

  /**
   * Get display text for the timer.
   * @returns {string}
   */
  #timerText() {
    const prompt = this.assignmentPayload.prompt;
    if ( this.mode === "preview" ) return formatClock(Number(prompt.timerSeconds ?? 0) * 1000);
    return formatTimerState(prompt, Date.now(), { left: "", over: "" }).text.trim();
  }

  /**
   * @this {PlayerDrawingApp}
   * @param {Event} _event Event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<void>}
   */
  static async #onSetTool(_event, target) {
    this.#selectTool(target.dataset.tool);
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onClearLayer() {
    if ( !this.#engine ) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "DRAWING-PROMPTS.player.clear.title" },
      content: game.i18n.localize("DRAWING-PROMPTS.player.clear.confirm"),
      rejectClose: false,
      modal: true
    });
    if ( confirmed ) this.#engine.clearLayer();
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onUndo() {
    this.#engine?.undo();
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onRedo() {
    this.#engine?.redo();
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onSubmit() {
    return this.#submit();
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onReject() {
    return this.#reject();
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onCloseWindow() {
    return this.close();
  }
}

/**
 * Format opacity as a rounded percent.
 * @param {number} value Opacity.
 * @returns {string}
 */
function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

/**
 * Resolve the initial brush color for this client.
 * @returns {string}
 */
function initialBrushColor() {
  return normalizeHex(game.settings.get(MODULE_ID, SETTINGS.LAST_BRUSH_COLOR))
    ?? normalizeHex(game.user?.color)
    ?? "#000000";
}

/**
 * Normalize CSS hex to #rrggbb.
 * @param {string} value Value.
 * @returns {string|null}
 */
function normalizeHex(value) {
  const text = String(value ?? "").trim();
  if ( /^#[0-9a-fA-F]{6}$/.test(text) ) return text.toLowerCase();
  if ( /^#[0-9a-fA-F]{3}$/.test(text) ) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return null;
}
