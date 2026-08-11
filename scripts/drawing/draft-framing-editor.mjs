import { FIT_MODE } from "../constants.mjs";
import { computeFramingGeometry, defaultPromptFraming } from "./prompt-framing.mjs";

/** Minimum Prompt Framing edge length in source pixels. */
export const MIN_FRAMING_EDGE = 1;

/** Maximum Prompt Framing edge length in source pixels. */
export const MAX_FRAMING_EDGE = 65536;

/** Multiplicative step for framing zoom button controls. */
export const FRAMING_ZOOM_STEP = 1.25;

/**
 * Resolve the draft Prompt Framing rect for a background descriptor.
 * @param {{path?: string|null, naturalWidth?: number|null, naturalHeight?: number|null, framing?: {x?: number, y?: number, width?: number, height?: number}|null}} background
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function resolveDraftFraming(background = {}) {
  const naturalWidth = Number(background.naturalWidth);
  const naturalHeight = Number(background.naturalHeight);
  if ( !background.path || !(naturalWidth > 0 && naturalHeight > 0) ) return null;
  if ( isValidFraming(background.framing) ) return normalizeFraming(background.framing);
  return defaultPromptFraming(naturalWidth, naturalHeight);
}

/**
 * Reset Prompt Framing to the full source image.
 * @param {number} sourceWidth Natural source width.
 * @param {number} sourceHeight Natural source height.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function resetFraming(sourceWidth, sourceHeight) {
  return defaultPromptFraming(sourceWidth, sourceHeight);
}

/**
 * Resolve Prompt Framing after the GM changes Fit mode in the draft select.
 * Non-Placed modes reset to full-source framing; same mode or Placed keeps framing.
 * Pure helper so UI `input`→`change` ordering can be tested without ApplicationV2.
 * @param {{path?: string|null, naturalWidth?: number|null, naturalHeight?: number|null, framing?: object|null}} background Draft background.
 * @param {string} previousFitMode Fit mode before the select change.
 * @param {string} nextFitMode Fit mode after the select change.
 * @returns {{x: number, y: number, width: number, height: number}|null} Framing to apply, or null to leave unchanged.
 */
export function framingAfterFitModeSelect(background, previousFitMode, nextFitMode) {
  if ( nextFitMode === previousFitMode ) return null;
  if ( nextFitMode === FIT_MODE.PLACED ) return null;
  const naturalWidth = Number(background?.naturalWidth);
  const naturalHeight = Number(background?.naturalHeight);
  if ( !background?.path || !(naturalWidth > 0 && naturalHeight > 0) ) return null;
  return defaultPromptFraming(naturalWidth, naturalHeight);
}

/**
 * Expand or shrink framing so width/height matches Prompt canvas aspect, keeping the center fixed.
 * @param {{x?: number, y?: number, width?: number, height?: number}} framing Current framing.
 * @param {number} canvasWidth Prompt canvas width.
 * @param {number} canvasHeight Prompt canvas height.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function lockFramingToCanvasAspect(framing, canvasWidth, canvasHeight) {
  const frame = normalizeFraming(framing);
  const cw = positive(canvasWidth, 1);
  const ch = positive(canvasHeight, 1);
  const aspect = cw / ch;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  let width = frame.width;
  let height = frame.height;
  if ( width / height > aspect ) {
    // Too wide for canvas aspect: grow height.
    height = width / aspect;
  } else {
    // Too tall (or already matching): grow width.
    width = height * aspect;
  }
  width = clampEdge(width);
  height = clampEdge(height);
  // Reconcile if edge clamp broke the aspect (e.g. one side hit MAX).
  if ( Math.abs(width / height - aspect) > 1e-9 ) {
    if ( width / height > aspect ) height = clampEdge(width / aspect);
    else width = clampEdge(height * aspect);
  }
  return normalizeFraming({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  });
}

/**
 * Build the initial Placed-mode Prompt Framing ROI: canvas-aspect crop that contains the
 * current framing (or full source), like a Fit Canvas start window.
 * @param {object} options Options.
 * @param {number} options.sourceWidth Natural source width.
 * @param {number} options.sourceHeight Natural source height.
 * @param {{x?: number, y?: number, width?: number, height?: number}|null} [options.framing] Current framing.
 * @param {number} options.canvasWidth Prompt canvas width.
 * @param {number} options.canvasHeight Prompt canvas height.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function framingForPlacedStart({
  sourceWidth,
  sourceHeight,
  framing = null,
  canvasWidth,
  canvasHeight
} = {}) {
  const source = isValidFraming(framing)
    ? normalizeFraming(framing)
    : defaultPromptFraming(sourceWidth, sourceHeight);
  const cw = positive(canvasWidth, 1);
  const ch = positive(canvasHeight, 1);
  const aspect = cw / ch;
  // Smallest canvas-aspect box that fully contains `source`.
  const width = clampEdge(Math.max(source.width, source.height * aspect));
  const height = clampEdge(width / aspect);
  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  return normalizeFraming({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height
  });
}

/**
 * Pan Prompt Framing by viewport pixel delta.
 * When both canvasWidth and canvasHeight are provided, re-locks to canvas aspect after pan.
 * @param {{x: number, y: number, width: number, height: number}} framing Current framing.
 * @param {{
 *   dxDisplay: number, dyDisplay: number, viewportWidth: number, viewportHeight: number,
 *   canvasWidth?: number, canvasHeight?: number
 * }} delta Pan delta.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function panFraming(framing, {
  dxDisplay = 0,
  dyDisplay = 0,
  viewportWidth,
  viewportHeight,
  canvasWidth,
  canvasHeight
} = {}) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const frame = normalizeFraming(framing);
  const scaleX = frame.width / vw;
  const scaleY = frame.height / vh;
  const panned = normalizeFraming({
    x: frame.x - Number(dxDisplay || 0) * scaleX,
    y: frame.y - Number(dyDisplay || 0) * scaleY,
    width: frame.width,
    height: frame.height
  });
  if ( hasCanvasDims(canvasWidth, canvasHeight) ) {
    return lockFramingToCanvasAspect(panned, canvasWidth, canvasHeight);
  }
  return panned;
}

/**
 * Zoom Prompt Framing about a viewport focus point.
 * When both canvasWidth and canvasHeight are provided, re-locks to canvas aspect after zoom.
 * @param {{x: number, y: number, width: number, height: number}} framing Current framing.
 * @param {{
 *   factor: number, focusX?: number, focusY?: number, viewportWidth: number, viewportHeight: number,
 *   canvasWidth?: number, canvasHeight?: number
 * }} options Zoom options.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function zoomFraming(framing, {
  factor,
  focusX,
  focusY,
  viewportWidth,
  viewportHeight,
  canvasWidth,
  canvasHeight
} = {}) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const frame = normalizeFraming(framing);
  const fx = clamp(Number.isFinite(Number(focusX)) ? Number(focusX) / vw : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(Number(focusY)) ? Number(focusY) / vh : 0.5, 0, 1);
  const sourceX = frame.x + fx * frame.width;
  const sourceY = frame.y + fy * frame.height;
  const zoomFactor = Math.max(0.01, Number(factor) || 1);
  const width = clampEdge(frame.width / zoomFactor);
  const height = clampEdge(frame.height / zoomFactor);
  const zoomed = normalizeFraming({
    x: sourceX - fx * width,
    y: sourceY - fy * height,
    width,
    height
  });
  if ( hasCanvasDims(canvasWidth, canvasHeight) ) {
    return lockFramingToCanvasAspect(zoomed, canvasWidth, canvasHeight);
  }
  return zoomed;
}

/**
 * @param {unknown} canvasWidth
 * @param {unknown} canvasHeight
 * @returns {boolean}
 */
function hasCanvasDims(canvasWidth, canvasHeight) {
  return Number.isFinite(Number(canvasWidth)) && Number.isFinite(Number(canvasHeight))
    && Number(canvasWidth) > 0 && Number(canvasHeight) > 0;
}

/**
 * Scale Framed-background placement from logical Prompt canvas space onto the editor plate.
 * Matches bake destination when the plate is aspect-true to canvas W×H.
 * @param {object} options Options.
 * @param {ReturnType<typeof computeFramingGeometry>} options.geometry Framing + Fit geometry (logical canvas).
 * @param {number} options.viewportWidth Plate width in CSS/display pixels.
 * @param {number} options.viewportHeight Plate height in CSS/display pixels.
 * @returns {{
 *   sourceX: number, sourceY: number, sourceW: number, sourceH: number,
 *   destX: number, destY: number, destW: number, destH: number,
 *   scaleX: number, scaleY: number
 * }}
 */
export function resolveFramingEditorDrawRect({ geometry, viewportWidth, viewportHeight } = {}) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const cw = positive(geometry?.canvasWidth, 1);
  const ch = positive(geometry?.canvasHeight, 1);
  const framing = geometry?.framing ?? { x: 0, y: 0, width: 1, height: 1 };
  const placement = geometry?.framedPlacement ?? { dx: 0, dy: 0, dw: cw, dh: ch };
  const scaleX = vw / cw;
  const scaleY = vh / ch;
  return {
    sourceX: framing.x,
    sourceY: framing.y,
    sourceW: framing.width,
    sourceH: framing.height,
    destX: placement.dx * scaleX,
    destY: placement.dy * scaleY,
    destW: placement.dw * scaleX,
    destH: placement.dh * scaleY,
    scaleX,
    scaleY
  };
}

/**
 * Draw the Prompt Framing editor viewport: same framing + Fit placement as Framed background bake,
 * scaled from logical canvas W×H onto the aspect-true plate (WYSIWYG for send).
 * @param {CanvasRenderingContext2D} context Target context.
 * @param {CanvasImageSource} img Loaded source image.
 * @param {object} options Draw options.
 * @param {{x: number, y: number, width: number, height: number}} options.framing Prompt Framing rect.
 * @param {number} options.sourceWidth Natural source width.
 * @param {number} options.sourceHeight Natural source height.
 * @param {string} options.fitMode Fit mode (Center, Stretch, Placed, etc.).
 * @param {number} options.canvasWidth Draft Prompt canvas width.
 * @param {number} options.canvasHeight Draft Prompt canvas height.
 * @param {number} options.viewportWidth Plate viewport width.
 * @param {number} options.viewportHeight Plate viewport height.
 * @returns {void}
 */
export function drawFramingEditor(context, img, {
  framing,
  sourceWidth,
  sourceHeight,
  fitMode,
  canvasWidth,
  canvasHeight,
  viewportWidth,
  viewportHeight
} = {}) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const geometry = computeFramingGeometry({
    sourceWidth,
    sourceHeight,
    framing,
    fitMode,
    canvasWidth,
    canvasHeight
  });
  const rect = resolveFramingEditorDrawRect({
    geometry,
    viewportWidth: vw,
    viewportHeight: vh
  });
  context.clearRect(0, 0, vw, vh);
  context.drawImage(
    img,
    rect.sourceX,
    rect.sourceY,
    rect.sourceW,
    rect.sourceH,
    rect.destX,
    rect.destY,
    rect.destW,
    rect.destH
  );
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}|null|undefined} framing
 * @returns {boolean}
 */
function isValidFraming(framing) {
  if ( !framing || typeof framing !== "object" ) return false;
  const width = Number(framing.width);
  const height = Number(framing.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}} framing
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function normalizeFraming(framing) {
  return {
    x: finiteNumber(framing?.x, 0),
    y: finiteNumber(framing?.y, 0),
    width: clampEdge(framing?.width),
    height: clampEdge(framing?.height)
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampEdge(value) {
  const number = Number(value);
  if ( !Number.isFinite(number) || number <= 0 ) return MIN_FRAMING_EDGE;
  return clamp(number, MIN_FRAMING_EDGE, MAX_FRAMING_EDGE);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
