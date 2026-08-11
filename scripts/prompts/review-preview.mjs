/**
 * Pure helpers for GM Assignment review Framing View previews (static seeds).
 * Domain: Framed background seed ladder + Canvas plate aspect for review.
 */

import { FRAMING_VIEW } from "../constants.mjs";
import { normalizeFramingView } from "./dual-save.mjs";

/**
 * First non-empty string/path among candidates.
 * @param {...(string|null|undefined)} candidates Sources.
 * @returns {string|null}
 */
export function firstPreviewSrc(...candidates) {
  for ( const value of candidates ) {
    if ( value == null ) continue;
    const text = String(value);
    if ( text.length ) return text;
  }
  return null;
}

/**
 * Prompt-canvas Framing View image ladder (static review).
 * Order: live → pending → saved primary → Framed background delivery.
 * @param {object} [options] Ladder inputs.
 * @param {string|null} [options.liveSrc] Live composite / session snapshot.
 * @param {string|null} [options.pendingSrc] Pending submission Prompt-canvas src.
 * @param {string|null} [options.savedPath] Saved primary image path.
 * @param {string|null} [options.framedPath] Prompt `background.framedPath`.
 * @returns {string|null}
 */
export function resolvePromptCanvasReviewSrc({
  liveSrc = null,
  pendingSrc = null,
  savedPath = null,
  framedPath = null
} = {}) {
  return firstPreviewSrc(liveSrc, pendingSrc, savedPath, framedPath);
}

/**
 * Source Framing image ladder (static review).
 * Order: saved `_full` → remapped preview → source image alone.
 * @param {object} [options] Ladder inputs.
 * @param {string|null} [options.savedFullPath] Saved Source Framing fullPath.
 * @param {string|null} [options.remappedSrc] Remapped ink-over-source preview URL.
 * @param {string|null} [options.sourcePath] Prompt source background path.
 * @returns {string|null}
 */
export function resolveSourceFramingReviewSrc({
  savedFullPath = null,
  remappedSrc = null,
  sourcePath = null
} = {}) {
  return firstPreviewSrc(savedFullPath, remappedSrc, sourcePath);
}

/**
 * Aspect box for a review Canvas plate under the active Framing View.
 * Prompt-canvas → Prompt W×H; Source Framing → source natural size when available.
 * @param {object} [options] Inputs.
 * @param {string} [options.framingView] Framing View id.
 * @param {{canvasWidth?: number, canvasHeight?: number, background?: object}|null} [options.prompt]
 *   Active prompt.
 * @param {boolean} [options.hasSource] Whether Source Framing is available.
 * @returns {{width: number, height: number}}
 */
export function resolveReviewPlateAspect({
  framingView = FRAMING_VIEW.PROMPT_CANVAS,
  prompt = null,
  hasSource = false
} = {}) {
  const view = normalizeFramingView(framingView, { hasSource });
  if ( view === FRAMING_VIEW.SOURCE ) {
    const naturalWidth = Number(prompt?.background?.naturalWidth);
    const naturalHeight = Number(prompt?.background?.naturalHeight);
    if ( naturalWidth > 0 && naturalHeight > 0 ) {
      return { width: naturalWidth, height: naturalHeight };
    }
  }
  const width = Number(prompt?.canvasWidth);
  const height = Number(prompt?.canvasHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1
  };
}
