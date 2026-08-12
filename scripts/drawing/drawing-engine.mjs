import { FIT_MODE, INTERNAL } from "../constants.mjs";
import { computeBackgroundLayout } from "./background-layout.mjs";
import { canvasToEncodedImage } from "./export-service.mjs";
import { OperationLog } from "./operation-log.mjs";
import { BrushTool } from "./tools/brush-tool.mjs";
import { EraserTool } from "./tools/eraser-tool.mjs";
import { EyedropperTool } from "./tools/eyedropper-tool.mjs";
import { FillTool, floodFillRegion } from "./tools/fill-tool.mjs";

const FILL_TOLERANCE = 32;

/**
 * Pure browser-canvas drawing engine.
 */
export class DrawingEngine {
  #background = null;
  #fitMode;
  #bgCanvas;
  #drawCanvas;
  #bgCtx;
  #drawCtx;
  #displayCanvas = null;
  #displayCtx = null;
  #toolName = "brush";
  #color = "#000000";
  #brushSize = 8;
  #brushOpacity = 1;
  #tools;
  #opLog = new OperationLog();
  #checkpoints = [];
  #changeCallbacks = new Set();
  #colorCallbacks = new Set();
  #warningCallbacks = new Set();
  #dirty = false;
  #rafId = null;
  #pointerId = null;
  #currentStroke = null;
  #strokeBaseCanvas = null;
  #handlers = null;

  /**
   * @param {{width: number, height: number, background?: {img: HTMLImageElement, naturalWidth: number, naturalHeight: number}|null, fitMode: string}} options Options.
   */
  constructor({ width, height, background = null, fitMode } = {}) {
    this.width = Math.max(1, Math.floor(Number(width) || 1));
    this.height = Math.max(1, Math.floor(Number(height) || 1));
    this.#background = background;
    this.#fitMode = fitMode || FIT_MODE.FIT_CANVAS;
    this.#bgCanvas = createCanvas(this.width, this.height);
    this.#drawCanvas = createCanvas(this.width, this.height);
    this.#bgCtx = this.#bgCanvas.getContext("2d", { willReadFrequently: true });
    this.#drawCtx = this.#drawCanvas.getContext("2d", { willReadFrequently: true });
    this.#tools = {
      brush: new BrushTool(),
      eraser: new EraserTool(),
      fill: new FillTool(),
      eyedropper: new EyedropperTool()
    };
    this.#renderBackground();
  }

  /**
   * Attach to the player display canvas (Canvas plate) and install pointer events.
   * Drawing tools only hit this element; Display stage pan/zoom is wired separately.
   * @param {HTMLCanvasElement} displayCanvasEl Display canvas.
   * @returns {void}
   */
  attach(displayCanvasEl) {
    if ( this.#displayCanvas === displayCanvasEl ) return;
    this.detach();
    this.#displayCanvas = displayCanvasEl;
    this.#displayCtx = displayCanvasEl.getContext("2d");
    this.#resizeDisplayBacking();
    this.#handlers = {
      pointerdown: event => this.#onPointerDown(event),
      pointermove: event => this.#onPointerMove(event),
      pointerup: event => this.#onPointerUp(event),
      pointercancel: event => this.#onPointerUp(event),
      resize: () => this.#resizeDisplayBacking()
    };
    displayCanvasEl.addEventListener("pointerdown", this.#handlers.pointerdown);
    displayCanvasEl.addEventListener("pointermove", this.#handlers.pointermove);
    displayCanvasEl.addEventListener("pointerup", this.#handlers.pointerup);
    displayCanvasEl.addEventListener("pointercancel", this.#handlers.pointercancel);
    globalThis.window?.addEventListener?.("resize", this.#handlers.resize);
    this.#markDirty();
  }

  /**
   * Detach from the current display canvas.
   * @returns {void}
   */
  detach() {
    if ( this.#displayCanvas && this.#handlers ) {
      this.#displayCanvas.removeEventListener("pointerdown", this.#handlers.pointerdown);
      this.#displayCanvas.removeEventListener("pointermove", this.#handlers.pointermove);
      this.#displayCanvas.removeEventListener("pointerup", this.#handlers.pointerup);
      this.#displayCanvas.removeEventListener("pointercancel", this.#handlers.pointercancel);
      globalThis.window?.removeEventListener?.("resize", this.#handlers.resize);
    }
    this.#displayCanvas = null;
    this.#displayCtx = null;
    this.#handlers = null;
    this.#pointerId = null;
  }

  /**
   * Destroy the engine.
   * @returns {void}
   */
  destroy() {
    this.detach();
    if ( this.#rafId !== null ) globalThis.cancelAnimationFrame?.(this.#rafId);
    this.#rafId = null;
    this.#checkpoints.length = 0;
    this.#changeCallbacks.clear();
    this.#colorCallbacks.clear();
    this.#warningCallbacks.clear();
  }

  /**
   * Set the active tool.
   * @param {"brush"|"eraser"|"fill"|"eyedropper"} name Tool name.
   * @returns {void}
   */
  setTool(name) {
    if ( this.#tools[name] ) this.#toolName = name;
  }

  /**
   * Set the active color.
   * @param {string} cssHex CSS hex color.
   * @returns {void}
   */
  setColor(cssHex) {
    this.#color = normalizeHex(cssHex) ?? this.#color;
  }

  /**
   * Get the active color.
   * @returns {string}
   */
  getColor() {
    return this.#color;
  }

  /**
   * Whether the engine has a real background image.
   * @returns {boolean}
   */
  get hasBackground() {
    return Boolean(this.#background?.img);
  }

  /**
   * Set brush size in logical pixels.
   * @param {number} px Size.
   * @returns {void}
   */
  setBrushSize(px) {
    this.#brushSize = Math.max(1, Math.min(128, Math.round(Number(px) || 1)));
  }

  /**
   * Set brush opacity.
   * @param {number} opacity Opacity from 0.05 to 1.
   * @returns {void}
   */
  setBrushOpacity(opacity) {
    const value = Number(opacity);
    this.#brushOpacity = Math.max(0.05, Math.min(1, Number.isFinite(value) ? value : 1));
  }

  /**
   * Undo one operation when the checkpoint window permits it.
   * @returns {boolean}
   */
  undo() {
    if ( !this.canUndo ) return false;
    const pointer = this.#opLog.undo();
    if ( pointer === null ) return false;
    this.#restoreToPointer(pointer);
    this.#emitChange();
    return true;
  }

  /**
   * Redo one operation.
   * @returns {boolean}
   */
  redo() {
    const pointer = this.#opLog.redo();
    if ( pointer === null ) return false;
    this.#restoreToPointer(pointer);
    this.#emitChange();
    return true;
  }

  /**
   * Clear the foreground drawing layer.
   * @returns {void}
   */
  clearLayer() {
    this.#drawCtx.clearRect(0, 0, this.width, this.height);
    this.#commitOperation({ id: operationId(), type: "clear", ts: Date.now() });
    this.#markDirty();
  }

  /**
   * Whether undo is available within the retained checkpoint window.
   * @returns {boolean}
   */
  get canUndo() {
    return this.#opLog.pointer > this.#minimumUndoPointer();
  }

  /**
   * Whether redo is available.
   * @returns {boolean}
   */
  get canRedo() {
    return this.#opLog.canRedo;
  }

  /**
   * Subscribe to visible drawing, committed operation, or history changes.
   * @param {Function} callback Callback.
   * @returns {Function} Unsubscribe function.
   */
  onChange(callback) {
    this.#changeCallbacks.add(callback);
    return () => this.#changeCallbacks.delete(callback);
  }

  /**
   * Subscribe to eyedropper color samples.
   * @param {Function} callback Callback.
   * @returns {Function} Unsubscribe function.
   */
  onColorSampled(callback) {
    this.#colorCallbacks.add(callback);
    return () => this.#colorCallbacks.delete(callback);
  }

  /**
   * Subscribe to non-fatal engine warnings.
   * @param {Function} callback Callback.
   * @returns {Function} Unsubscribe function.
   */
  onWarning(callback) {
    this.#warningCallbacks.add(callback);
    return () => this.#warningCallbacks.delete(callback);
  }

  /**
   * Build a downscaled composited data URL.
   * @param {{maxEdge: number, quality?: number, type?: string}} options Snapshot options.
   * @returns {string}
   */
  getCompositeSnapshot({ maxEdge, quality, type = "image/webp" } = {}) {
    const canvas = this.#snapshotCanvas(maxEdge);
    const context = canvas.getContext("2d");
    context.drawImage(this.#bgCanvas, 0, 0, canvas.width, canvas.height);
    context.drawImage(this.#drawCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  }

  /**
   * Build a downscaled overlay-only (ink) data URL with transparent background.
   * Used for Full Framing live remap — same ink layer dual Save bakes, not bg+ink.
   * @param {{maxEdge: number, quality?: number, type?: string}} options Snapshot options.
   * @returns {string}
   */
  getOverlaySnapshot({ maxEdge, quality, type = "image/webp" } = {}) {
    const canvas = this.#snapshotCanvas(maxEdge);
    canvas.getContext("2d").drawImage(this.#drawCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(type, quality);
  }

  /**
   * Create a downscaled snapshot canvas sized by max edge.
   * @param {number} maxEdge Max edge length in pixels.
   * @returns {HTMLCanvasElement|OffscreenCanvas}
   */
  #snapshotCanvas(maxEdge) {
    const scale = Math.min(1, Number(maxEdge || Math.max(this.width, this.height)) / Math.max(this.width, this.height));
    return createCanvas(Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale)));
  }

  /**
   * Export the foreground overlay only.
   * @param {{format: string, quality?: number, scale?: number}} options Export options.
   * @returns {Promise<{blob: Blob, dataUrl: string, format: string}>}
   */
  async exportOverlay({ format, quality, scale = 1 } = {}) {
    const canvas = this.#scaledExportCanvas(scale);
    canvas.getContext("2d").drawImage(this.#drawCanvas, 0, 0, canvas.width, canvas.height);
    return canvasToEncodedImage(canvas, { format, quality });
  }

  /**
   * Export a flattened background plus foreground image.
   * @param {{format: string, quality?: number, scale?: number}} options Export options.
   * @returns {Promise<{blob: Blob, dataUrl: string, format: string}>}
   */
  async exportMerged({ format, quality, scale = 1 } = {}) {
    const canvas = this.#scaledExportCanvas(scale);
    const context = canvas.getContext("2d");
    context.drawImage(this.#bgCanvas, 0, 0, canvas.width, canvas.height);
    context.drawImage(this.#drawCanvas, 0, 0, canvas.width, canvas.height);
    return canvasToEncodedImage(canvas, { format, quality });
  }

  /**
   * Create an export canvas at a bounded scale.
   * @param {number} scale Requested export scale.
   * @returns {HTMLCanvasElement|OffscreenCanvas} Export canvas.
   */
  #scaledExportCanvas(scale) {
    const resolvedScale = Math.max(0.01, Math.min(1, Number(scale) || 1));
    return createCanvas(
      Math.max(1, Math.round(this.width * resolvedScale)),
      Math.max(1, Math.round(this.height * resolvedScale))
    );
  }

  /**
   * Return a serializable operation log.
   * @returns {{ops: object[], pointer: number}}
   */
  getOpLog() {
    return this.#opLog.toJSON();
  }

  /**
   * Replace the draw layer from a serialized operation log.
   * @param {{ops?: object[], pointer?: number}} serialized Serialized log.
   * @returns {void}
   */
  loadOpLog(serialized) {
    this.#opLog = OperationLog.fromSerialized(serialized);
    this.#checkpoints = [];
    this.#currentStroke = null;
    this.#strokeBaseCanvas = null;
    this.#restoreToPointer(this.#opLog.pointer);
    this.#emitChange();
  }

  /**
   * Replace the draw layer from raw RGBA pixels (overlay-only restore).
   * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} rgba Pixel buffer.
   * @returns {void}
   */
  loadOverlayRgba({ width, height, data }) {
    const w = Math.max(1, Math.floor(Number(width) || 1));
    const h = Math.max(1, Math.floor(Number(height) || 1));
    this.#drawCtx.clearRect(0, 0, this.width, this.height);
    if ( w === this.width && h === this.height ) {
      this.#drawCtx.putImageData(new ImageData(data, w, h), 0, 0);
    } else {
      const canvas = createCanvas(w, h);
      canvas.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
      this.#drawCtx.drawImage(canvas, 0, 0, this.width, this.height);
    }
    this.#opLog = new OperationLog();
    this.#checkpoints = [];
    this.#currentStroke = null;
    this.#strokeBaseCanvas = null;
    this.#markDirty();
    this.#emitChange();
  }

  /**
   * Begin a stroke operation.
   * @param {"stroke"|"erase"} type Operation type.
   * @param {{x: number, y: number}} pt Point.
   * @returns {void}
   */
  beginStroke(type, pt) {
    this.#strokeBaseCanvas = createCanvas(this.width, this.height);
    this.#strokeBaseCanvas.getContext("2d").drawImage(this.#drawCanvas, 0, 0);
    this.#currentStroke = {
      type,
      color: this.#color,
      size: this.#brushSize,
      opacity: type === "stroke" ? this.#brushOpacity : 1,
      points: [pt]
    };
    this.#renderCurrentStroke();
    this.#emitChange();
  }

  /**
   * Extend the active stroke.
   * @param {{x: number, y: number}} pt Point.
   * @returns {void}
   */
  extendStroke(pt) {
    if ( !this.#currentStroke ) return;
    const last = this.#currentStroke.points.at(-1);
    if ( Math.hypot(pt.x - last.x, pt.y - last.y) < 0.5 ) return;
    this.#currentStroke.points.push(pt);
    this.#renderCurrentStroke();
    this.#emitChange();
  }

  /**
   * Commit the active stroke.
   * @param {{x: number, y: number}} pt Final point.
   * @returns {void}
   */
  commitStroke(pt) {
    if ( !this.#currentStroke ) return;
    this.extendStroke(pt);
    const op = {
      id: operationId(),
      type: this.#currentStroke.type,
      ts: Date.now(),
      size: this.#currentStroke.size,
      points: this.#currentStroke.points.map(point => ({ x: point.x, y: point.y }))
    };
    if ( op.type === "stroke" ) {
      op.color = this.#currentStroke.color;
      op.opacity = this.#currentStroke.opacity;
    }
    this.#currentStroke = null;
    this.#strokeBaseCanvas = null;
    this.#commitOperation(op);
  }

  /**
   * Render the full in-progress stroke over its pre-stroke layer.
   * @returns {void}
   */
  #renderCurrentStroke() {
    if ( !this.#currentStroke || !this.#strokeBaseCanvas ) return;
    this.#drawCtx.clearRect(0, 0, this.width, this.height);
    this.#drawCtx.drawImage(this.#strokeBaseCanvas, 0, 0);
    renderStroke(this.#drawCtx, this.#currentStroke);
  }

  /**
   * Fill a composite-bounded region on the foreground layer.
   * @param {{x: number, y: number}} pt Seed point.
   * @returns {boolean}
   */
  fill(pt) {
    if ( this.width > INTERNAL.MAX_CANVAS_DIM || this.height > INTERNAL.MAX_CANVAS_DIM ) {
      this.#emitWarning("DRAWING-PROMPTS.player.errors.canvasTooLarge");
      return false;
    }

    const composite = this.#compositeImageData();
    const rgba = hexToRgba(this.#color);
    const result = floodFillRegion(composite.data, this.width, this.height, pt, rgba, FILL_TOLERANCE);
    if ( !result.pixelsFilled ) return false;

    const drawImageData = this.#drawCtx.getImageData(0, 0, this.width, this.height);
    for ( let i = 0; i < result.mask.length; i++ ) {
      if ( !result.mask[i] ) continue;
      const offset = i * 4;
      drawImageData.data[offset] = rgba.r;
      drawImageData.data[offset + 1] = rgba.g;
      drawImageData.data[offset + 2] = rgba.b;
      drawImageData.data[offset + 3] = rgba.a;
    }
    this.#drawCtx.putImageData(drawImageData, 0, 0);
    this.#commitOperation({
      id: operationId(),
      type: "fill",
      ts: Date.now(),
      seed: { x: Math.floor(pt.x), y: Math.floor(pt.y) },
      color: this.#color,
      tolerance: FILL_TOLERANCE
    });
    this.#markDirty();
    return true;
  }

  /**
   * Sample the composited canvas.
   * @param {{x: number, y: number}} pt Point.
   * @returns {string|null}
   */
  sampleColor(pt) {
    const x = Math.max(0, Math.min(this.width - 1, Math.floor(pt.x)));
    const y = Math.max(0, Math.min(this.height - 1, Math.floor(pt.y)));
    const canvas = createCanvas(this.width, this.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(this.#bgCanvas, 0, 0);
    context.drawImage(this.#drawCanvas, 0, 0);
    const data = context.getImageData(x, y, 1, 1).data;
    const hex = rgbToHex(data[0], data[1], data[2]);
    this.setColor(hex);
    for ( const callback of this.#colorCallbacks ) callback(hex);
    return hex;
  }

  /**
   * Render immutable background once per fit mode.
   * @returns {void}
   */
  #renderBackground() {
    this.#bgCtx.clearRect(0, 0, this.width, this.height);
    const img = this.#background?.img;
    if ( !img ) return;
    const naturalWidth = Number(this.#background.naturalWidth || img.naturalWidth || this.width);
    const naturalHeight = Number(this.#background.naturalHeight || img.naturalHeight || this.height);
    const rect = computeBackgroundLayout(this.width, this.height, naturalWidth, naturalHeight, this.#fitMode);
    this.#bgCtx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh);
  }

  /**
   * Pointer down handler.
   * @param {PointerEvent} event Event.
   * @returns {void}
   */
  #onPointerDown(event) {
    if ( this.#pointerId !== null ) return;
    event.preventDefault();
    this.#pointerId = event.pointerId;
    this.#displayCanvas.setPointerCapture?.(event.pointerId);
    this.#tools[this.#toolName].onPointerDown(this.#eventPoint(event), this.#toolContext());
  }

  /**
   * Pointer move handler.
   * @param {PointerEvent} event Event.
   * @returns {void}
   */
  #onPointerMove(event) {
    if ( event.pointerId !== this.#pointerId ) return;
    event.preventDefault();
    this.#tools[this.#toolName].onPointerMove(this.#eventPoint(event), this.#toolContext());
  }

  /**
   * Pointer up or cancel handler.
   * @param {PointerEvent} event Event.
   * @returns {void}
   */
  #onPointerUp(event) {
    if ( event.pointerId !== this.#pointerId ) return;
    event.preventDefault();
    this.#tools[this.#toolName].onPointerUp(this.#eventPoint(event), this.#toolContext());
    this.#displayCanvas.releasePointerCapture?.(event.pointerId);
    this.#pointerId = null;
  }

  /**
   * Convert a pointer event to logical coordinates.
   * @param {PointerEvent} event Event.
   * @returns {{x: number, y: number}}
   */
  #eventPoint(event) {
    return mapClientPointToLogical({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: this.#displayCanvas.getBoundingClientRect(),
      width: this.width,
      height: this.height
    });
  }

  /**
   * Build the tool context.
   * @returns {object}
   */
  #toolContext() {
    return {
      beginStroke: (type, pt) => this.beginStroke(type, pt),
      extendStroke: pt => this.extendStroke(pt),
      commitStroke: pt => this.commitStroke(pt),
      fill: pt => this.fill(pt),
      sampleColor: pt => this.sampleColor(pt)
    };
  }

  /**
   * Commit an operation and manage checkpoints.
   * @param {object} op Operation.
   * @returns {void}
   */
  #commitOperation(op) {
    this.#opLog.append(op);
    this.#checkpoints = this.#checkpoints.filter(checkpoint => checkpoint.opCount <= this.#opLog.pointer);
    if ( this.#opLog.pointer % INTERNAL.SNAPSHOT_EVERY_OPS === 0 ) this.#storeCheckpoint();
    this.#emitChange();
  }

  /**
   * Store a draw-layer checkpoint.
   * @returns {void}
   */
  #storeCheckpoint() {
    const canvas = createCanvas(this.width, this.height);
    canvas.getContext("2d").drawImage(this.#drawCanvas, 0, 0);
    this.#checkpoints.push({ opCount: this.#opLog.pointer, canvas });
    while ( this.#checkpoints.length > INTERNAL.MAX_CHECKPOINTS ) this.#checkpoints.shift();
  }

  /**
   * Restore draw layer to an operation pointer.
   * @param {number} pointer Pointer.
   * @returns {void}
   */
  #restoreToPointer(pointer) {
    this.#drawCtx.clearRect(0, 0, this.width, this.height);
    const checkpoint = [...this.#checkpoints].reverse().find(item => item.opCount <= pointer);
    let start = 0;
    if ( checkpoint ) {
      this.#drawCtx.drawImage(checkpoint.canvas, 0, 0);
      start = checkpoint.opCount;
    }
    const ops = this.#opLog.ops.slice(start, pointer);
    for ( const op of ops ) this.#applyOperation(op);
    this.#markDirty();
  }

  /**
   * Apply an operation during local replay.
   * @param {object} op Operation.
   * @returns {void}
   */
  #applyOperation(op) {
    if ( op.type === "clear" ) {
      this.#drawCtx.clearRect(0, 0, this.width, this.height);
      return;
    }
    if ( op.type === "stroke" || op.type === "erase" ) {
      renderStroke(this.#drawCtx, op);
      return;
    }
    if ( op.type === "fill" ) {
      this.#applyFillOperation(op);
    }
  }

  /**
   * Apply a fill operation without changing the operation log.
   * @param {object} op Fill operation.
   * @returns {void}
   */
  #applyFillOperation(op) {
    const composite = this.#compositeImageData();
    const rgba = hexToRgba(op.color);
    const result = floodFillRegion(composite.data, this.width, this.height, op.seed, rgba, op.tolerance ?? FILL_TOLERANCE);
    if ( !result.pixelsFilled ) return;

    const drawImageData = this.#drawCtx.getImageData(0, 0, this.width, this.height);
    for ( let i = 0; i < result.mask.length; i++ ) {
      if ( !result.mask[i] ) continue;
      const offset = i * 4;
      drawImageData.data[offset] = rgba.r;
      drawImageData.data[offset + 1] = rgba.g;
      drawImageData.data[offset + 2] = rgba.b;
      drawImageData.data[offset + 3] = rgba.a;
    }
    this.#drawCtx.putImageData(drawImageData, 0, 0);
  }

  /**
   * Return composited image data.
   * @returns {ImageData}
   */
  #compositeImageData() {
    const canvas = createCanvas(this.width, this.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(this.#bgCanvas, 0, 0);
    context.drawImage(this.#drawCanvas, 0, 0);
    return context.getImageData(0, 0, this.width, this.height);
  }

  /**
   * Resize display backing store for DPR while logical size remains stable.
   * @returns {void}
   */
  #resizeDisplayBacking() {
    if ( !this.#displayCanvas ) return;
    const dpr = Math.max(1, globalThis.window?.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.round(this.width * dpr));
    const backingHeight = Math.max(1, Math.round(this.height * dpr));
    if ( this.#displayCanvas.width !== backingWidth ) this.#displayCanvas.width = backingWidth;
    if ( this.#displayCanvas.height !== backingHeight ) this.#displayCanvas.height = backingHeight;
    this.#markDirty();
  }

  /**
   * Mark display composite dirty.
   * @returns {void}
   */
  #markDirty() {
    this.#dirty = true;
    if ( this.#rafId !== null ) return;
    this.#rafId = globalThis.requestAnimationFrame?.(() => this.#renderDisplay()) ?? null;
    if ( this.#rafId === null ) this.#renderDisplay();
  }

  /**
   * Composite to display canvas.
   * @returns {void}
   */
  #renderDisplay() {
    this.#rafId = null;
    if ( !this.#dirty || !this.#displayCtx || !this.#displayCanvas ) return;
    this.#dirty = false;
    const dpr = Math.max(1, globalThis.window?.devicePixelRatio || 1);
    this.#displayCtx.save();
    this.#displayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#displayCtx.clearRect(0, 0, this.width, this.height);
    this.#displayCtx.drawImage(this.#bgCanvas, 0, 0);
    this.#displayCtx.drawImage(this.#drawCanvas, 0, 0);
    this.#displayCtx.restore();
  }

  /**
   * Emit a change event.
   * @returns {void}
   */
  #emitChange() {
    this.#markDirty();
    for ( const callback of this.#changeCallbacks ) callback(this);
  }

  /**
   * Emit a warning key.
   * @param {string} key Localization key.
   * @returns {void}
   */
  #emitWarning(key) {
    for ( const callback of this.#warningCallbacks ) callback(key);
  }

  /**
   * Minimum pointer that undo may reach.
   * @returns {number}
   */
  #minimumUndoPointer() {
    if ( !this.#checkpoints.length ) return 0;
    const oldest = this.#checkpoints[0].opCount;
    return oldest <= INTERNAL.SNAPSHOT_EVERY_OPS ? 0 : oldest;
  }
}

/**
 * Map a client point to logical canvas coordinates.
 * @param {{clientX: number, clientY: number, rect: {left: number, top: number, width: number, height: number}, width: number, height: number}} options Options.
 * @returns {{x: number, y: number}}
 */
export function mapClientPointToLogical({ clientX, clientY, rect, width, height }) {
  const x = ((clientX - rect.left) / Math.max(1, rect.width)) * width;
  const y = ((clientY - rect.top) / Math.max(1, rect.height)) * height;
  return {
    x: clamp(x, 0, width - 1),
    y: clamp(y, 0, height - 1)
  };
}

/**
 * Create a canvas-like object.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
function createCanvas(width, height) {
  if ( globalThis.document?.createElement ) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

/**
 * Render a stroke or erase operation.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} context Context.
 * @param {object} op Operation.
 * @returns {void}
 */
function renderStroke(context, op) {
  const points = op.points ?? [];
  if ( !points.length ) return;
  context.save();
  context.globalCompositeOperation = op.type === "erase" ? "destination-out" : "source-over";
  context.globalAlpha = op.type === "erase" ? 1 : Math.max(0.05, Math.min(1, Number(op.opacity ?? 1)));
  context.strokeStyle = op.color ?? "#000000";
  context.fillStyle = op.color ?? "#000000";
  context.lineWidth = Math.max(1, Number(op.size) || 1);
  context.lineCap = "round";
  context.lineJoin = "round";

  if ( points.length === 1 ) {
    const radius = context.lineWidth / 2;
    context.beginPath();
    context.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for ( let i = 1; i < points.length - 1; i++ ) {
    const midpoint = {
      x: (points[i].x + points[i + 1].x) / 2,
      y: (points[i].y + points[i + 1].y) / 2
    };
    context.quadraticCurveTo(points[i].x, points[i].y, midpoint.x, midpoint.y);
  }
  const last = points.at(-1);
  context.lineTo(last.x, last.y);
  context.stroke();
  context.restore();
}

/**
 * Convert a hex color to RGBA.
 * @param {string} hex Hex color.
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function hexToRgba(hex) {
  const normalized = normalizeHex(hex) ?? "#000000";
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
    a: 255
  };
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

/**
 * Convert RGB to hex.
 * @param {number} r Red.
 * @param {number} g Green.
 * @param {number} b Blue.
 * @returns {string}
 */
function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(value => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Clamp a number.
 * @param {number} value Value.
 * @param {number} min Min.
 * @param {number} max Max.
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generate an operation id.
 * @returns {string}
 */
function operationId() {
  return globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
