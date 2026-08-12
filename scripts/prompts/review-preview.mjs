/**
 * Pure helpers for GM Assignment review Framing View previews (static seeds).
 * Domain: Framed background seed ladder + Canvas plate aspect for review.
 */

import { FRAMING_VIEW } from "../constants.mjs";
import { computeFullFramingRect } from "../drawing/prompt-framing.mjs";
import { normalizeFramingView } from "./dual-save.mjs";
import { resolvePromptFraming } from "./framed-delivery.mjs";

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
 * Full Framing image ladder (static review).
 * Order: saved `_full` → remapped preview → source image alone.
 * @param {object} [options] Ladder inputs.
 * @param {string|null} [options.savedFullPath] Saved Full Framing fullPath.
 * @param {string|null} [options.remappedSrc] Remapped ink-over-composition preview URL.
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
 * Prompt-canvas → Prompt W×H; Full Framing → composition plate (source ∪ framing).
 * @param {object} [options] Inputs.
 * @param {string} [options.framingView] Framing View id.
 * @param {{canvasWidth?: number, canvasHeight?: number, background?: object}|null} [options.prompt]
 *   Active prompt.
 * @param {boolean} [options.hasSource] Whether Full Framing is available.
 * @returns {{width: number, height: number}}
 */
export function resolveReviewPlateAspect({
  framingView = FRAMING_VIEW.PROMPT_CANVAS,
  prompt = null,
  hasSource = false
} = {}) {
  const view = normalizeFramingView(framingView, { hasSource });
  if ( view === FRAMING_VIEW.FULL && hasSource ) {
    const background = prompt?.background ?? {};
    const naturalWidth = Number(background.naturalWidth);
    const naturalHeight = Number(background.naturalHeight);
    if ( naturalWidth > 0 && naturalHeight > 0 ) {
      const fullRect = computeFullFramingRect({
        sourceWidth: naturalWidth,
        sourceHeight: naturalHeight,
        framing: resolvePromptFraming(prompt)
      });
      return {
        width: Math.max(1, Math.round(fullRect.width)),
        height: Math.max(1, Math.round(fullRect.height))
      };
    }
  }
  const width = Number(prompt?.canvasWidth);
  const height = Number(prompt?.canvasHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1
  };
}
