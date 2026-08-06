import { CANVAS_CHROME } from "../constants.mjs";

const CHROME_VALUES = new Set(Object.values(CANVAS_CHROME));

const CHROME_CSS = Object.freeze({
  [CANVAS_CHROME.WHITE]: "dp-chrome-white",
  [CANVAS_CHROME.BLACK]: "dp-chrome-black",
  [CANVAS_CHROME.CHECKERBOARD]: "dp-chrome-checkerboard"
});

/** All Canvas chrome surface CSS classes (for bulk classList remove). */
export const CANVAS_CHROME_CSS_CLASSES = Object.freeze(Object.values(CHROME_CSS));

/**
 * Normalize a stored or UI chrome value to a known Canvas chrome option.
 * Unknown or empty values fall back to the client default (checkerboard).
 * @param {unknown} value Raw setting or control value.
 * @returns {string} One of {@link CANVAS_CHROME} values.
 */
export function normalizeCanvasChrome(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return CHROME_VALUES.has(text) ? text : CANVAS_CHROME.CHECKERBOARD;
}

/**
 * CSS class applied under the player drawing surface for a chrome value.
 * Class is display-only; export paths never sample this layer.
 * @param {unknown} value Raw chrome value.
 * @returns {string} Class name, e.g. `dp-chrome-checkerboard`.
 */
export function canvasChromeCssClass(value) {
  return CHROME_CSS[normalizeCanvasChrome(value)];
}
