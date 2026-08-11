import { FIT_MODE } from "../constants.mjs";
import { defaultPromptFraming } from "./prompt-framing.mjs";

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
 * Pan Prompt Framing by viewport pixel delta.
 * @param {{x: number, y: number, width: number, height: number}} framing Current framing.
 * @param {{dxDisplay: number, dyDisplay: number, viewportWidth: number, viewportHeight: number}} delta Pan delta.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function panFraming(framing, { dxDisplay = 0, dyDisplay = 0, viewportWidth, viewportHeight } = {}) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const frame = normalizeFraming(framing);
  const scaleX = frame.width / vw;
  const scaleY = frame.height / vh;
  return normalizeFraming({
    x: frame.x - Number(dxDisplay || 0) * scaleX,
    y: frame.y - Number(dyDisplay || 0) * scaleY,
    width: frame.width,
    height: frame.height
  });
}

/**
 * Zoom Prompt Framing about a viewport focus point.
 * @param {{x: number, y: number, width: number, height: number}} framing Current framing.
 * @param {{factor: number, focusX?: number, focusY?: number, viewportWidth: number, viewportHeight: number}} options Zoom options.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function zoomFraming(framing, { factor, focusX, focusY, viewportWidth, viewportHeight } = {}) {
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
  return normalizeFraming({
    x: sourceX - fx * width,
    y: sourceY - fy * height,
    width,
    height
  });
}

/**
 * Draw the Prompt Framing editor viewport: source image positioned within the framing rect.
 * @param {CanvasRenderingContext2D} context Target context.
 * @param {CanvasImageSource} img Loaded source image.
 * @param {{x: number, y: number, width: number, height: number}} framing Prompt Framing rect.
 * @param {number} sourceWidth Natural source width.
 * @param {number} sourceHeight Natural source height.
 * @param {number} viewportWidth Viewport width.
 * @param {number} viewportHeight Viewport height.
 * @returns {void}
 */
export function drawFramingEditor(context, img, framing, sourceWidth, sourceHeight, viewportWidth, viewportHeight) {
  const vw = positive(viewportWidth, 1);
  const vh = positive(viewportHeight, 1);
  const sw = positive(sourceWidth, 1);
  const sh = positive(sourceHeight, 1);
  const frame = normalizeFraming(framing);
  context.clearRect(0, 0, vw, vh);
  const destX = -frame.x / frame.width * vw;
  const destY = -frame.y / frame.height * vh;
  const destW = sw / frame.width * vw;
  const destH = sh / frame.height * vh;
  context.drawImage(img, 0, 0, sw, sh, destX, destY, destW, destH);
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
