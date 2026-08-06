/**
 * Ephemeral player navigation (pan/zoom) for the Prompt canvas surface.
 * Pure math only — never mutates Prompt Framing, Fit mode, or delivered Framed background.
 */

/** Relative zoom cap vs the current fit scale (zoom in). */
export const MAX_RELATIVE_ZOOM = 16;

/** Multiplicative step for zoom button controls. */
export const ZOOM_STEP = 1.25;

/**
 * Compute the default fit view for content inside a viewport.
 * @param {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}} sizes Sizes.
 * @returns {{scale: number, panX: number, panY: number}}
 */
export function createFitView(sizes) {
  const { contentWidth, contentHeight, viewportWidth, viewportHeight } = normalizeSizes(sizes);
  const scale = fitScale(contentWidth, contentHeight, viewportWidth, viewportHeight);
  return clampView({ scale, panX: 0, panY: 0 }, sizes);
}

/**
 * Clamp scale and pan so the player cannot leave the Prompt canvas extent.
 * @param {{scale: number, panX: number, panY: number}} view View.
 * @param {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}} sizes Sizes.
 * @returns {{scale: number, panX: number, panY: number}}
 */
export function clampView(view, sizes) {
  const { contentWidth, contentHeight, viewportWidth, viewportHeight } = normalizeSizes(sizes);
  const minScale = fitScale(contentWidth, contentHeight, viewportWidth, viewportHeight);
  const maxScale = minScale * MAX_RELATIVE_ZOOM;
  const scale = clamp(Number(view?.scale) || minScale, minScale, maxScale);

  const contentW = contentWidth * scale;
  const contentH = contentHeight * scale;

  let panX = Number(view?.panX) || 0;
  let panY = Number(view?.panY) || 0;

  if ( contentW <= viewportWidth ) panX = (viewportWidth - contentW) / 2;
  else panX = clamp(panX, viewportWidth - contentW, 0);

  if ( contentH <= viewportHeight ) panY = (viewportHeight - contentH) / 2;
  else panY = clamp(panY, viewportHeight - contentH, 0);

  return { scale, panX, panY };
}

/**
 * Zoom about a focus point in viewport coordinates.
 * @param {{scale: number, panX: number, panY: number}} view View.
 * @param {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}} sizes Sizes.
 * @param {{factor: number, focusX?: number, focusY?: number}} options Zoom options.
 * @returns {{scale: number, panX: number, panY: number}}
 */
export function zoomView(view, sizes, { factor, focusX, focusY } = {}) {
  const { viewportWidth, viewportHeight } = normalizeSizes(sizes);
  const current = clampView(view, sizes);
  const zoomFactor = Math.max(0.01, Number(factor) || 1);
  const fx = Number.isFinite(Number(focusX)) ? Number(focusX) : viewportWidth / 2;
  const fy = Number.isFinite(Number(focusY)) ? Number(focusY) : viewportHeight / 2;
  const contentX = (fx - current.panX) / current.scale;
  const contentY = (fy - current.panY) / current.scale;
  const nextScale = current.scale * zoomFactor;
  return clampView(
    {
      scale: nextScale,
      panX: fx - contentX * nextScale,
      panY: fy - contentY * nextScale
    },
    sizes
  );
}

/**
 * Pan by viewport pixels.
 * @param {{scale: number, panX: number, panY: number}} view View.
 * @param {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}} sizes Sizes.
 * @param {{dx: number, dy: number}} delta Delta.
 * @returns {{scale: number, panX: number, panY: number}}
 */
export function panView(view, sizes, { dx = 0, dy = 0 } = {}) {
  const current = clampView(view, sizes);
  return clampView(
    {
      scale: current.scale,
      panX: current.panX + Number(dx || 0),
      panY: current.panY + Number(dy || 0)
    },
    sizes
  );
}

/**
 * CSS transform string for the content surface (origin top-left).
 * @param {{scale: number, panX: number, panY: number}} view View.
 * @returns {string}
 */
export function cssTransform(view) {
  const scale = Number(view?.scale) || 1;
  const panX = Number(view?.panX) || 0;
  const panY = Number(view?.panY) || 0;
  return `translate(${panX}px, ${panY}px) scale(${scale})`;
}

/**
 * Map a client pointer into logical Prompt canvas coordinates.
 * @param {object} options Options.
 * @param {number} options.clientX Client X.
 * @param {number} options.clientY Client Y.
 * @param {{left: number, top: number, width: number, height: number}} options.viewportRect Viewport rect.
 * @param {{scale: number, panX: number, panY: number}} options.view View.
 * @param {number} options.contentWidth Content width.
 * @param {number} options.contentHeight Content height.
 * @returns {{x: number, y: number}}
 */
export function mapViewportClientToLogical({
  clientX,
  clientY,
  viewportRect,
  view,
  contentWidth,
  contentHeight
}) {
  const cw = positive(contentWidth, 1);
  const ch = positive(contentHeight, 1);
  const scale = Math.max(1e-6, Number(view?.scale) || 1);
  const panX = Number(view?.panX) || 0;
  const panY = Number(view?.panY) || 0;
  const vx = Number(clientX) - Number(viewportRect?.left || 0);
  const vy = Number(clientY) - Number(viewportRect?.top || 0);
  return {
    x: clamp((vx - panX) / scale, 0, cw - 1e-9),
    y: clamp((vy - panY) / scale, 0, ch - 1e-9)
  };
}

/**
 * Whether middle button or space+primary is requesting pan.
 * @param {{button: number, spaceHeld: boolean}} options Options.
 * @returns {boolean}
 */
export function isPanModifierActive({ button, spaceHeld }) {
  return Number(button) === 1 || (Number(button) === 0 && Boolean(spaceHeld));
}

/**
 * Drawing tools win: plain primary pointer draws rather than pans.
 * @param {{button: number, spaceHeld: boolean}} options Options.
 * @returns {boolean}
 */
export function shouldDrawingToolTakePointer({ button, spaceHeld }) {
  return Number(button) === 0 && !spaceHeld;
}

/**
 * Classify a wheel event into pan or zoom.
 * Pinch / modifier-scroll → zoom. Shift → horizontal pan.
 * Two-finger trackpad (any horizontal delta) → pan both axes.
 * Pure vertical wheel (mouse or vertical trackpad) → zoom.
 * @param {{deltaX?: number, deltaY?: number, deltaMode?: number, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean}} event Wheel-like event.
 * @returns {{type: "zoom", factor: number}|{type: "pan", dx: number, dy: number}}
 */
export function classifyWheelGesture({
  deltaX = 0,
  deltaY = 0,
  deltaMode: _deltaMode = 0,
  ctrlKey = false,
  metaKey = false,
  shiftKey = false
} = {}) {
  if ( ctrlKey || metaKey ) {
    return { type: "zoom", factor: wheelZoomFactor(deltaY) };
  }
  if ( shiftKey ) {
    const horizontal = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    return { type: "pan", dx: -Number(horizontal || 0), dy: 0 };
  }
  // Horizontal component → trackpad two-finger pan; pure vertical → wheel zoom.
  if ( Math.abs(Number(deltaX) || 0) > 0.5 ) {
    return { type: "pan", dx: -Number(deltaX || 0), dy: -Number(deltaY || 0) };
  }
  return { type: "zoom", factor: wheelZoomFactor(deltaY) };
}

/**
 * Convert wheel deltaY into a zoom factor (scroll down / pinch-out => zoom out).
 * @param {number} deltaY Wheel delta Y.
 * @returns {number}
 */
export function wheelZoomFactor(deltaY) {
  return Math.exp(-Number(deltaY || 0) * 0.002);
}

/**
 * Fit scale so content is fully visible inside the viewport.
 * @param {number} contentWidth Content width.
 * @param {number} contentHeight Content height.
 * @param {number} viewportWidth Viewport width.
 * @param {number} viewportHeight Viewport height.
 * @returns {number}
 */
function fitScale(contentWidth, contentHeight, viewportWidth, viewportHeight) {
  return Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
}

/**
 * Normalize size inputs to positive dimensions.
 * @param {object} sizes Sizes.
 * @returns {{contentWidth: number, contentHeight: number, viewportWidth: number, viewportHeight: number}}
 */
function normalizeSizes(sizes = {}) {
  return {
    contentWidth: positive(sizes.contentWidth, 1),
    contentHeight: positive(sizes.contentHeight, 1),
    viewportWidth: positive(sizes.viewportWidth, 1),
    viewportHeight: positive(sizes.viewportHeight, 1)
  };
}

/**
 * Positive finite number helper.
 * @param {number} value Value.
 * @param {number} fallback Fallback.
 * @returns {number}
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Clamp a number into an inclusive range.
 * @param {number} value Value.
 * @param {number} min Min.
 * @param {number} max Max.
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
