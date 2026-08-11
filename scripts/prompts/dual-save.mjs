import { BG_SOURCE, FRAMING_VIEW } from "../constants.mjs";
import { bakeDualRasters, computeFramingGeometry, dualSaveFilenames } from "../drawing/prompt-framing.mjs";
import { canvasToEncodedImage } from "../drawing/export-service.mjs";
import { resolvePromptFraming } from "./framed-delivery.mjs";
import { isSaveGateOpen } from "./transitions.mjs";

/**
 * Whether the prompt has a source image suitable for Source Framing dual Save.
 * @param {{background?: object}} prompt Prompt.
 * @returns {boolean}
 */
export function hasSourceBackground(prompt) {
  const background = prompt?.background ?? {};
  if ( !background.path || background.sourceType === BG_SOURCE.BLANK ) return false;
  const naturalWidth = Number(background.naturalWidth);
  const naturalHeight = Number(background.naturalHeight);
  return naturalWidth > 0 && naturalHeight > 0;
}

/**
 * Normalize a Framing View value. Falls back to Prompt canvas when Source Framing
 * is unavailable or the value is unknown.
 * @param {string|null|undefined} framingView Candidate view.
 * @param {{hasSource?: boolean}} [options] Context.
 * @returns {typeof FRAMING_VIEW[keyof typeof FRAMING_VIEW]}
 */
export function normalizeFramingView(framingView, { hasSource = false } = {}) {
  if ( framingView === FRAMING_VIEW.SOURCE && hasSource ) return FRAMING_VIEW.SOURCE;
  return FRAMING_VIEW.PROMPT_CANVAS;
}

/**
 * Resolve the pre-saved Place/Transform asset path for a Framing View.
 * Prompt canvas → primaryImagePath (`{basename}`); Source Framing → assets.fullPath (`{basename}_full`).
 * @param {import("./prompt-models.mjs").DrawingAssignment|null|undefined} assignment Assignment.
 * @param {string} framingView Framing View.
 * @returns {string|null}
 */
export function resolveFramingViewAssetPath(assignment, framingView) {
  if ( !assignment ) return null;
  if ( framingView === FRAMING_VIEW.SOURCE ) return assignment.assets?.fullPath ?? null;
  return assignment.primaryImagePath ?? null;
}

/**
 * Whether Place/Transform may use the given Framing View's saved raster.
 * Uses the single dual-Save gate; does not invent a per-view save state.
 * @param {import("./prompt-models.mjs").DrawingAssignment|null|undefined} assignment Assignment.
 * @param {string} framingView Framing View.
 * @returns {boolean}
 */
export function canPlaceFramingView(assignment, framingView) {
  return isSaveGateOpen(assignment) && Boolean(resolveFramingViewAssetPath(assignment, framingView));
}

/**
 * Framing geometry for dual Save remapping into source space.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} prompt Prompt.
 * @returns {ReturnType<typeof computeFramingGeometry>}
 */
export function computeDualSaveGeometry(prompt) {
  const background = prompt?.background ?? {};
  return computeFramingGeometry({
    sourceWidth: background.naturalWidth,
    sourceHeight: background.naturalHeight,
    framing: resolvePromptFraming(prompt),
    fitMode: background.fitMode,
    canvasWidth: prompt.canvasWidth,
    canvasHeight: prompt.canvasHeight
  });
}

/**
 * Resolve the `_full` leaf filename for a saved drawing slug.
 * @param {string} slug Saved drawing slug.
 * @param {string} extension Image extension.
 * @returns {string}
 */
export function resolveFullFilename(slug, extension) {
  return dualSaveFilenames(slug, extension).source;
}

/**
 * Clear persisted Framing View image paths and re-arm the Save gate.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {void}
 */
export function clearFramingViewAssets(assignment) {
  if ( !assignment?.assets ) return;
  assignment.assets.overlayPath = null;
  assignment.assets.mergedPath = null;
  assignment.assets.fullPath = null;
  assignment.savedSubmissionTs = null;
}

/**
 * Whether a submission invalidation should drop saved Framing View assets.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {boolean}
 */
export function hasSavedFramingViewAssets(assignment) {
  return Boolean(assignment?.primaryImagePath || assignment?.assets?.fullPath);
}

/**
 * Resolve the Prompt canvas size a Submission overlay should occupy when baking
 * Source Framing. Prefer original (pre-wire-scale) dimensions so transit
 * downscales still map as if drawn on the full Prompt canvas.
 * @param {object|null|undefined} submission Submission payload.
 * @param {{canvasWidth?: number, canvasHeight?: number}|null|undefined} prompt Prompt.
 * @returns {{width: number, height: number}}
 */
export function resolveSubmissionOverlaySize(submission, prompt) {
  const width = Number(submission?.originalWidth ?? submission?.width ?? prompt?.canvasWidth);
  const height = Number(submission?.originalHeight ?? submission?.height ?? prompt?.canvasHeight);
  return {
    width: Number.isFinite(width) && width > 0 ? Math.floor(width) : 1,
    height: Number.isFinite(height) && height > 0 ? Math.floor(height) : 1
  };
}

/**
 * Bake and encode the Source Framing raster from a Prompt-canvas overlay buffer.
 * Composites remapped ink over the prompt's source image when available (natural W×H).
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA buffer.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} [options.format="webp"] Output format.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} [options.sourceUnderlay]
 *   Optional pre-decoded source RGBA; when omitted, loads from `prompt.background.path`.
 * @returns {Promise<{blob: Blob, format: string, width: number, height: number}>}
 */
export async function bakeAndEncodeSourceFraming({
  overlay,
  prompt,
  format = "webp",
  sourceUnderlay = null
} = {}) {
  const geometry = computeDualSaveGeometry(prompt);
  const underlay = sourceUnderlay ?? await loadSourceUnderlayRgba(prompt);
  const { source } = bakeDualRasters({ geometry, overlay, sourceUnderlay: underlay });
  const encoded = await encodeRgbaBuffer(source, format);
  return {
    blob: encoded.blob,
    format: encoded.format,
    width: source.width,
    height: source.height
  };
}

/**
 * Build a Source Framing preview data URL from a Prompt-canvas **overlay** source.
 * Reuses dual-Save geometry/remap — not a second save path. Input must be ink-only
 * (transparent outside strokes), not a merged/composite raster. Output is source
 * image + remapped ink (same bake as `_full`).
 * @param {object} options Options.
 * @param {string} options.src Overlay image URL or data URL.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {object|null|undefined} [options.submission] Optional submission for original size.
 * @returns {Promise<string|null>} Encoded data URL, or null when remap is unavailable.
 */
export async function buildSourceFramingPreviewDataUrl({ src, prompt, submission = null } = {}) {
  if ( !src || !hasSourceBackground(prompt) ) return null;
  const size = resolveSubmissionOverlaySize(submission, prompt);
  const [overlay, sourceUnderlay] = await Promise.all([
    decodeImageToRgba(src, size.width, size.height),
    loadSourceUnderlayRgba(prompt)
  ]);
  const baked = await bakeAndEncodeSourceFraming({
    overlay,
    prompt,
    format: "webp",
    sourceUnderlay
  });
  return blobToDataUrl(baked.blob);
}

/**
 * Decode the prompt's source background into an RGBA buffer at natural size.
 * Uses the same CORS/taint-safe Image load path as overlay decode.
 * @param {{background?: object}|null|undefined} prompt Prompt.
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}|null>}
 */
export async function loadSourceUnderlayRgba(prompt) {
  if ( !hasSourceBackground(prompt) ) return null;
  const background = prompt.background;
  const path = background.path;
  const width = Math.floor(Number(background.naturalWidth));
  const height = Math.floor(Number(background.naturalHeight));
  try {
    return await decodeImageToRgba(path, width, height);
  } catch (err) {
    console.warn("drawing-prompts | Source Framing underlay load failed", err);
    return null;
  }
}

/**
 * Pick the overlay-only image source from a pending submission (dual-Save bake input).
 * Prefers staged overlay path or inline overlay data URL — never merged/composite.
 * @param {object|null|undefined} submission Submission payload.
 * @returns {string|null} Overlay path or data URL, or null.
 */
export function pickSubmissionOverlaySrc(submission) {
  if ( !submission ) return null;
  if ( submission.mode === "staged" ) return submission.staged?.overlayPath || null;
  return submission.overlay?.dataUrl || null;
}

/**
 * Pick the Prompt-canvas preview source from a pending submission (prefers merged).
 * @param {object|null|undefined} submission Submission payload.
 * @returns {string|null} Merged or overlay path/data URL, or null.
 */
export function pickSubmissionPromptCanvasSrc(submission) {
  if ( !submission ) return null;
  if ( submission.mode === "staged" ) {
    return submission.staged?.mergedPath || submission.staged?.overlayPath || null;
  }
  return submission.merged?.dataUrl || submission.overlay?.dataUrl || null;
}

/**
 * @param {Blob} blob Image blob.
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode an image source into an RGBA buffer at the given canvas size.
 * @param {string} src Image URL or data URL.
 * @param {number} width Target width.
 * @param {number} height Target height.
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}>}
 */
export async function decodeImageToRgba(src, width, height) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", () => reject(new Error("Image load failed.")), { once: true });
    img.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(img, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

/**
 * Encode an RGBA buffer to a compressed image blob.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} buffer RGBA buffer.
 * @param {string} format Output format.
 * @returns {Promise<{blob: Blob, format: string}>}
 */
export async function encodeRgbaBuffer({ width, height, data }, format) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return canvasToEncodedImage(canvas, { format });
}
