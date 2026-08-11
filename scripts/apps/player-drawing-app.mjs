import { CANVAS_CHROME, INTERNAL, MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { CANVAS_CHROME_CSS_CLASSES, canvasChromeCssClass, normalizeCanvasChrome } from "../drawing/canvas-chrome.mjs";
import { DrawingEngine } from "../drawing/drawing-engine.mjs";
import {
  ZOOM_STEP,
  classifyWheelGesture,
  clampView,
  createFitView,
  cssTransform,
  isPanModifierActive,
  panView,
  shouldDrawingToolTakePointer,
  zoomView
} from "../drawing/player-navigation.mjs";
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
      setCanvasChrome: PlayerDrawingApp.#onSetCanvasChrome,
      clearLayer: PlayerDrawingApp.#onClearLayer,
      undo: PlayerDrawingApp.#onUndo,
      redo: PlayerDrawingApp.#onRedo,
      zoomIn: PlayerDrawingApp.#onZoomIn,
      zoomOut: PlayerDrawingApp.#onZoomOut,
      resetView: PlayerDrawingApp.#onResetView,
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
    this.#canvasChrome = initialCanvasChrome();
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
  #canvasChrome = CANVAS_CHROME.CHECKERBOARD;
  #unsubscribers = [];
  #wireScaledWarned = false;
  /** @type {{scale: number, panX: number, panY: number}|null} Ephemeral view; reset on open. */
  #navView = null;
  #navViewport = null;
  #navHandlers = null;
  #navResizeObserver = null;
  #spaceHeld = false;
  /** @type {{pointerId: number, lastX: number, lastY: number}|null} */
  #panDrag = null;

  /** @override */
  async _prepareContext(options) {
    const assignment = this.assignmentPayload.assignment;
    const prompt = this.assignmentPayload.prompt;
    return {
      assignment,
      prompt,
      mode: this.mode,
      isPreview: this.mode === "preview",
      hasTimer: this.mode === "preview" ? Number(prompt.timerSeconds) > 0 : prompt.timerStatus !== "none",
      timerText: this.#timerText(),
      backgroundError: this.#backgroundError,
      backgroundLoading: this.#backgroundState === "loading",
      activeTool: this.#activeTool,
      color: this.#color,
      brushSize: this.#brushSize,
      brushOpacity: this.#brushOpacity,
      brushOpacityPercent: formatPercent(this.#brushOpacity),
      canvasChrome: this.#canvasChrome,
      canvasChromeClass: canvasChromeCssClass(this.#canvasChrome),
      canvasChromeOptions: this.#canvasChromeOptions(),
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
    this.#ensureNavigation();
    this.#wireToolbarInputs();
    this.#refreshToolbarState();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if ( this.#timerId ) window.clearInterval(this.#timerId);
    this.#timerId = null;
    this.#destroyNavigation();
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
   * Attach ephemeral pan/zoom navigation to the player viewport (resets per open).
   * @returns {void}
   */
  #ensureNavigation() {
    const viewport = this.element?.querySelector(".dp-canvas-viewport");
    const canvas = this.element?.querySelector(".dp-display-canvas");
    if ( !viewport || !canvas || this.#backgroundError ) {
      this.#destroyNavigation();
      return;
    }

    if ( this.#navViewport !== viewport ) {
      this.#destroyNavigation({ keepView: true });
      this.#navViewport = viewport;
      this.#wireNavigation(viewport);
    }

    this.#sizeNavCanvas(canvas);
    if ( !this.#navView ) this.#resetNavigation();
    else this.#applyNavigation();
  }

  /**
   * Wire pointer/wheel/keyboard handlers for player navigation.
   * @param {HTMLElement} viewport Viewport element.
   * @returns {void}
   */
  #wireNavigation(viewport) {
    const onWheel = event => this.#onNavWheel(event);
    const onPointerDown = event => this.#onNavPointerDown(event);
    const onPointerMove = event => this.#onNavPointerMove(event);
    const onPointerUp = event => this.#onNavPointerUp(event);
    const onDblClick = event => {
      event.preventDefault();
      this.#resetNavigation();
    };
    const onKeyDown = event => {
      if ( event.code !== "Space" || event.repeat || !this.rendered ) return;
      const target = event.target;
      if ( target?.closest?.("input, textarea, select, [contenteditable='true']") ) return;
      this.#spaceHeld = true;
      if ( this.element?.contains(target) || target === document.body ) event.preventDefault();
    };
    const onKeyUp = event => {
      if ( event.code === "Space" ) this.#spaceHeld = false;
    };
    const onBlur = () => {
      this.#spaceHeld = false;
      this.#endPanDrag();
    };

    this.#navHandlers = { onWheel, onPointerDown, onPointerMove, onPointerUp, onDblClick, onKeyDown, onKeyUp, onBlur };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("pointerdown", onPointerDown, true);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("pointercancel", onPointerUp);
    viewport.addEventListener("dblclick", onDblClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    if ( typeof ResizeObserver !== "undefined" ) {
      this.#navResizeObserver = new ResizeObserver(() => this.#onNavViewportResize());
      this.#navResizeObserver.observe(viewport);
    }
  }

  /**
   * Tear down navigation listeners. Optionally keep the ephemeral view across rewires.
   * @param {{keepView?: boolean}} [options] Options.
   * @returns {void}
   */
  #destroyNavigation({ keepView = false } = {}) {
    this.#endPanDrag();
    const viewport = this.#navViewport;
    const handlers = this.#navHandlers;
    if ( viewport && handlers ) {
      viewport.removeEventListener("wheel", handlers.onWheel);
      viewport.removeEventListener("pointerdown", handlers.onPointerDown, true);
      viewport.removeEventListener("pointermove", handlers.onPointerMove);
      viewport.removeEventListener("pointerup", handlers.onPointerUp);
      viewport.removeEventListener("pointercancel", handlers.onPointerUp);
      viewport.removeEventListener("dblclick", handlers.onDblClick);
    }
    if ( handlers ) {
      window.removeEventListener("keydown", handlers.onKeyDown);
      window.removeEventListener("keyup", handlers.onKeyUp);
      window.removeEventListener("blur", handlers.onBlur);
    }
    this.#navResizeObserver?.disconnect();
    this.#navResizeObserver = null;
    this.#navHandlers = null;
    this.#navViewport = null;
    this.#spaceHeld = false;
    if ( !keepView ) this.#navView = null;
  }

  /**
   * Content and viewport sizes for the active navigation session.
   * @returns {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}|null}
   */
  #navSizes() {
    const viewport = this.#navViewport ?? this.element?.querySelector(".dp-canvas-viewport");
    if ( !viewport ) return null;
    const prompt = this.assignmentPayload.prompt;
    return {
      contentWidth: Math.max(1, Number(prompt.canvasWidth) || 1),
      contentHeight: Math.max(1, Number(prompt.canvasHeight) || 1),
      viewportWidth: Math.max(1, viewport.clientWidth || 1),
      viewportHeight: Math.max(1, viewport.clientHeight || 1)
    };
  }

  /**
   * Size the display canvas to Prompt canvas pixels (transform provides fit).
   * @param {HTMLCanvasElement} canvas Canvas element.
   * @returns {void}
   */
  #sizeNavCanvas(canvas) {
    const sizes = this.#navSizes();
    if ( !sizes ) return;
    canvas.style.width = `${sizes.contentWidth}px`;
    canvas.style.height = `${sizes.contentHeight}px`;
    canvas.style.transformOrigin = "0 0";
  }

  /**
   * Reset to the default fit-to-content view.
   * @returns {void}
   */
  #resetNavigation() {
    const sizes = this.#navSizes();
    if ( !sizes ) return;
    this.#navView = createFitView(sizes);
    this.#applyNavigation();
  }

  /**
   * Re-clamp and paint the current view after a viewport resize.
   * @returns {void}
   */
  #onNavViewportResize() {
    const sizes = this.#navSizes();
    if ( !sizes ) return;
    if ( !this.#navView ) this.#navView = createFitView(sizes);
    else this.#navView = clampView(this.#navView, sizes);
    this.#applyNavigation();
  }

  /**
   * Apply CSS transform for the ephemeral navigation state.
   * @returns {void}
   */
  #applyNavigation() {
    const canvas = this.element?.querySelector(".dp-display-canvas");
    const sizes = this.#navSizes();
    if ( !canvas || !sizes || !this.#navView ) return;
    this.#sizeNavCanvas(canvas);
    this.#navView = clampView(this.#navView, sizes);
    canvas.style.transform = cssTransform(this.#navView);
  }

  /**
   * Zoom by a multiplicative factor about the viewport center (or given point).
   * @param {number} factor Zoom factor.
   * @param {{focusX?: number, focusY?: number}} [focus] Optional focus in viewport coords.
   * @returns {void}
   */
  #zoomNavigation(factor, focus = {}) {
    const sizes = this.#navSizes();
    if ( !sizes || !this.#navView ) return;
    this.#navView = zoomView(this.#navView, sizes, {
      factor,
      focusX: focus.focusX,
      focusY: focus.focusY
    });
    this.#applyNavigation();
  }

  /**
   * Handle wheel / trackpad navigation gestures.
   * @param {WheelEvent} event Event.
   * @returns {void}
   */
  #onNavWheel(event) {
    const sizes = this.#navSizes();
    if ( !sizes || !this.#navView ) return;
    event.preventDefault();
    const gesture = classifyWheelGesture(event);
    const rect = this.#navViewport.getBoundingClientRect();
    if ( gesture.type === "zoom" ) {
      this.#navView = zoomView(this.#navView, sizes, {
        factor: gesture.factor,
        focusX: event.clientX - rect.left,
        focusY: event.clientY - rect.top
      });
    } else {
      this.#navView = panView(this.#navView, sizes, { dx: gesture.dx, dy: gesture.dy });
    }
    this.#applyNavigation();
  }

  /**
   * Start pan only when navigation modifiers win over drawing tools.
   * @param {PointerEvent} event Event.
   * @returns {void}
   */
  #onNavPointerDown(event) {
    if ( shouldDrawingToolTakePointer({ button: event.button, spaceHeld: this.#spaceHeld }) ) return;
    if ( !isPanModifierActive({ button: event.button, spaceHeld: this.#spaceHeld }) ) return;
    event.preventDefault();
    event.stopPropagation();
    this.#panDrag = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    this.#navViewport?.setPointerCapture?.(event.pointerId);
    this.#navViewport?.classList.add("is-panning");
  }

  /**
   * Continue an active pan drag.
   * @param {PointerEvent} event Event.
   * @returns {void}
   */
  #onNavPointerMove(event) {
    if ( !this.#panDrag || event.pointerId !== this.#panDrag.pointerId ) return;
    event.preventDefault();
    const sizes = this.#navSizes();
    if ( !sizes || !this.#navView ) return;
    const dx = event.clientX - this.#panDrag.lastX;
    const dy = event.clientY - this.#panDrag.lastY;
    this.#panDrag.lastX = event.clientX;
    this.#panDrag.lastY = event.clientY;
    this.#navView = panView(this.#navView, sizes, { dx, dy });
    this.#applyNavigation();
  }

  /**
   * End pan drag.
   * @param {PointerEvent} [event] Event.
   * @returns {void}
   */
  #onNavPointerUp(event) {
    if ( !this.#panDrag ) return;
    if ( event && event.pointerId !== this.#panDrag.pointerId ) return;
    this.#endPanDrag(event?.pointerId);
  }

  /**
   * Clear pan drag state.
   * @param {number} [pointerId] Pointer id to release.
   * @returns {void}
   */
  #endPanDrag(pointerId) {
    if ( !this.#panDrag ) return;
    const id = pointerId ?? this.#panDrag.pointerId;
    try {
      this.#navViewport?.releasePointerCapture?.(id);
    } catch ( _err ) {
      // Pointer may already be released.
    }
    this.#panDrag = null;
    this.#navViewport?.classList.remove("is-panning");
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
    const opts = {
      maxEdge: INTERNAL.SNAPSHOT_MAX_EDGE,
      quality: INTERNAL.SNAPSHOT_QUALITY
    };
    // Composite for Prompt-canvas live; overlay-only for Source Framing remap (matches dual Save).
    const snapshot = {
      composite: this.#engine.getCompositeSnapshot(opts),
      overlay: this.#engine.getOverlaySnapshot(opts)
    };
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
   * Apply a Canvas chrome preference (client setting + surface class).
   * @param {string} value Chrome choice.
   * @returns {void}
   */
  #setCanvasChrome(value) {
    this.#canvasChrome = normalizeCanvasChrome(value);
    void game.settings.set(MODULE_ID, SETTINGS.CANVAS_CHROME, this.#canvasChrome);
    this.#refreshToolbarState();
  }

  /**
   * Build Background swatch options (Canvas chrome preference).
   * @returns {{value: string, label: string, selected: boolean}[]}
   */
  #canvasChromeOptions() {
    return [
      { value: CANVAS_CHROME.BLACK, label: "DRAWING-PROMPTS.choices.canvasChrome.black", selected: this.#canvasChrome === CANVAS_CHROME.BLACK },
      { value: CANVAS_CHROME.WHITE, label: "DRAWING-PROMPTS.choices.canvasChrome.white", selected: this.#canvasChrome === CANVAS_CHROME.WHITE },
      {
        value: CANVAS_CHROME.CHECKERBOARD,
        label: "DRAWING-PROMPTS.choices.canvasChrome.checkerboard",
        selected: this.#canvasChrome === CANVAS_CHROME.CHECKERBOARD
      }
    ];
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
    for ( const button of root.querySelectorAll("[data-action='setCanvasChrome']") ) {
      const selected = button.dataset.chrome === this.#canvasChrome;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    const canvasBox = root.querySelector(".dp-canvas-box");
    if ( canvasBox ) {
      canvasBox.classList.remove(...CANVAS_CHROME_CSS_CLASSES);
      canvasBox.classList.add(canvasChromeCssClass(this.#canvasChrome));
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
   * @param {Event} _event Event.
   * @param {HTMLElement} target Action target.
   * @returns {Promise<void>}
   */
  static async #onSetCanvasChrome(_event, target) {
    this.#setCanvasChrome(target.dataset.chrome);
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
  static async #onZoomIn() {
    this.#zoomNavigation(ZOOM_STEP);
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onZoomOut() {
    this.#zoomNavigation(1 / ZOOM_STEP);
  }

  /**
   * @this {PlayerDrawingApp}
   * @returns {Promise<void>}
   */
  static async #onResetView() {
    this.#resetNavigation();
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
 * Resolve the initial Canvas chrome for this client.
 * @returns {string}
 */
function initialCanvasChrome() {
  return normalizeCanvasChrome(game.settings.get(MODULE_ID, SETTINGS.CANVAS_CHROME));
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
