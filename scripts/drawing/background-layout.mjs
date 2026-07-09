import { FIT_MODE } from "../constants.mjs";

/**
 * Compute the destination rectangle for drawing a background image onto a canvas.
 * @param {number} canvasW Logical canvas width.
 * @param {number} canvasH Logical canvas height.
 * @param {number} naturalW Natural image width.
 * @param {number} naturalH Natural image height.
 * @param {string} fitMode Background fit mode.
 * @returns {{dx: number, dy: number, dw: number, dh: number}} Destination rectangle.
 */
export function computeBackgroundLayout(canvasW, canvasH, naturalW, naturalH, fitMode) {
  const canvasWidth = positiveNumber(canvasW, 1);
  const canvasHeight = positiveNumber(canvasH, 1);
  const imageWidth = positiveNumber(naturalW, canvasWidth);
  const imageHeight = positiveNumber(naturalH, canvasHeight);

  if ( fitMode === FIT_MODE.STRETCH ) {
    return { dx: 0, dy: 0, dw: canvasWidth, dh: canvasHeight };
  }

  let dw = imageWidth;
  let dh = imageHeight;
  if ( fitMode === FIT_MODE.FIT_WIDTH ) {
    dw = canvasWidth;
    dh = imageHeight * (canvasWidth / imageWidth);
  } else if ( fitMode === FIT_MODE.FIT_HEIGHT ) {
    dh = canvasHeight;
    dw = imageWidth * (canvasHeight / imageHeight);
  }

  return {
    dx: (canvasWidth - dw) / 2,
    dy: (canvasHeight - dh) / 2,
    dw,
    dh
  };
}

/**
 * Return a positive finite number or fallback.
 * @param {number} value Value.
 * @param {number} fallback Fallback.
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
