import { BG_SOURCE, FRAMING_VIEW } from "../constants.mjs";
import {
  bakeDualRasters,
  compositeSameSizeSourceOver,
  dualSaveFilenames,
  initFullPlateFromUnderlay,
  splatOverlayInk
} from "../drawing/prompt-framing.mjs";
import { canvasToEncodedImage } from "../drawing/export-service.mjs";
import { computeDualSaveGeometry } from "./framing-delivery.mjs";
import { isSaveGateOpen } from "./transitions.mjs";

export { computeDualSaveGeometry };

/**
 * Whether the prompt has a source image suitable for Full Framing dual Save.
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
 * Normalize a Framing View value. Falls back to Prompt canvas when Full Framing
 * is unavailable or the value is unknown. Accepts legacy wire value `"source"`.
 * @param {string|null|undefined} framingView Candidate view.
 * @param {{hasSource?: boolean}} [options] Context.
 * @returns {typeof FRAMING_VIEW[keyof typeof FRAMING_VIEW]}
 */
export function normalizeFramingView(framingView, { hasSource = false } = {}) {
  if ( hasSource && (framingView === FRAMING_VIEW.FULL || framingView === "source") ) {
    return FRAMING_VIEW.FULL;
  }
  return FRAMING_VIEW.PROMPT_CANVAS;
}

/**
 * Whether a Framing View remaps player ink live and therefore needs overlay-only
 * (ink) snapshot bytes. Prompt canvas renders the composite snapshot as-is.
 * @param {string|null|undefined} framingView Candidate view.
 * @param {{hasSource?: boolean}} [options] Context.
 * @returns {boolean}
 */
export function framingViewNeedsLiveOverlay(framingView, { hasSource = false } = {}) {
  return normalizeFramingView(framingView, { hasSource }) === FRAMING_VIEW.FULL;
}

/**
 * Resolve the pre-saved Place/Transform asset path for a Framing View.
 * Prompt canvas → primaryImagePath (`{basename}`); Full Framing → assets.fullPath (`{basename}_full`).
 * @param {import("./prompt-models.mjs").DrawingAssignment|null|undefined} assignment Assignment.
 * @param {string} framingView Framing View.
 * @returns {string|null}
 */
export function resolveFramingViewAssetPath(assignment, framingView) {
  if ( !assignment ) return null;
  if ( framingView === FRAMING_VIEW.FULL || framingView === "source" ) {
    return assignment.assets?.fullPath ?? null;
  }
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
 * Resolve Place tile pixel size for the selected Framing View.
 * Prompt canvas → saved tileWidth/Height (canvas-sized); Full Framing → composition plate size.
 * @param {object} prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {string} framingView Framing View.
 * @param {{width?: number, height?: number}|null} [promptCanvasFallback] Fallback W×H for Prompt view.
 * @returns {{width: number, height: number}}
 */
export function resolveTileDimensionsForFramingView(
  prompt,
  assignment,
  framingView,
  promptCanvasFallback = null
) {
  const view = normalizeFramingView(framingView, { hasSource: hasSourceBackground(prompt) });
  if ( view === FRAMING_VIEW.FULL ) {
    let width = Number(assignment?.assets?.fullTileWidth) || 0;
    let height = Number(assignment?.assets?.fullTileHeight) || 0;
    if ( !(width > 0 && height > 0) && hasSourceBackground(prompt) ) {
      const geometry = computeDualSaveGeometry(prompt);
      width = geometry.fullRect.width;
      height = geometry.fullRect.height;
    }
    if ( width > 0 && height > 0 ) {
      return { width: Math.round(width), height: Math.round(height) };
    }
  }
  const width = Number(assignment?.assets?.tileWidth)
    || Number(promptCanvasFallback?.width)
    || Number(prompt?.canvasWidth)
    || 1;
  const height = Number(assignment?.assets?.tileHeight)
    || Number(promptCanvasFallback?.height)
    || Number(prompt?.canvasHeight)
    || 1;
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
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
 * Resolve the source-space overlay leaf filename for a saved drawing slug.
 * @param {string} slug Saved drawing slug.
 * @param {string} extension Image extension.
 * @returns {string}
 */
export function resolveSourceOverlayFilename(slug, extension) {
  return dualSaveFilenames(slug, extension).sourceOverlay;
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
  assignment.assets.sourceOverlayPath = null;
  assignment.savedSubmissionTs = null;
}

/**
 * Whether a submission invalidation should drop saved Framing View assets.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {boolean}
 */
export function hasSavedFramingViewAssets(assignment) {
  return Boolean(
    assignment?.primaryImagePath
    || assignment?.assets?.fullPath
    || assignment?.assets?.sourceOverlayPath
  );
}

/**
 * Whether the prompt has a Prompt-canvas background (Framed or source path) that
 * implies a merged (ink + prompt image) Save output.
 * @param {{background?: object}|null|undefined} prompt Prompt.
 * @returns {boolean}
 */
export function hasPromptCanvasBackground(prompt) {
  const background = prompt?.background ?? {};
  if ( background.sourceType === BG_SOURCE.BLANK ) return false;
  return Boolean(background.framedPath || background.path);
}

/**
 * Whether Save should write a merged Prompt-canvas primary.
 * True when the submission already carries merged bytes/paths, or when the
 * prompt has a Framed/prompt background that requires rematerializing merged.
 * @param {object|null|undefined} submission Submission payload.
 * @param {{background?: object}|null|undefined} prompt Prompt.
 * @returns {boolean}
 */
export function shouldWriteMergedSubmission(submission, prompt) {
  if ( !submission ) return false;
  if ( submission.mode === "staged" ) {
    if ( submission.staged?.mergedPath ) return true;
  } else if ( submission.merged?.dataUrl ) {
    return true;
  }
  return hasPromptCanvasBackground(prompt);
}

/**
 * Resolve the Prompt canvas size a Submission overlay should occupy when baking
 * Full Framing. Prefer original (pre-wire-scale) dimensions so transit
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
 * Bake and encode the Full Framing raster from a Prompt-canvas overlay buffer.
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
  const encoded = await bakeAndEncodeSourceSpaceRaster({
    overlay,
    prompt,
    format,
    sourceUnderlay,
    includeUnderlay: true
  });
  return encoded;
}

/**
 * Bake and encode the durable source-space overlay (remapped ink only, no underlay).
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA buffer.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} [options.format="webp"] Output format.
 * @returns {Promise<{blob: Blob, format: string, width: number, height: number}>}
 */
export async function bakeAndEncodeSourceOverlay({ overlay, prompt, format = "webp" } = {}) {
  return bakeAndEncodeSourceSpaceRaster({
    overlay,
    prompt,
    format,
    sourceUnderlay: null,
    includeUnderlay: false
  });
}

/**
 * Bake and encode both durable source-space rasters from one overlay load.
 * `_full` includes the source underlay; `_source` is remapped ink only.
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA buffer.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} [options.format="webp"] Output format.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} [options.sourceUnderlay]
 *   Optional pre-decoded source RGBA; when omitted, loads from `prompt.background.path`.
 * @returns {Promise<{
 *   full: {blob: Blob, format: string, width: number, height: number},
 *   sourceOverlay: {blob: Blob, format: string, width: number, height: number}
 * }>}
 */
export async function bakeAndEncodeSourceSpaceAssets({
  overlay,
  prompt,
  format = "webp",
  sourceUnderlay = null
} = {}) {
  const geometry = computeDualSaveGeometry(prompt);
  const underlay = sourceUnderlay ?? await loadSourceUnderlayRgba(prompt);
  const { source: inkOnly } = bakeDualRasters({ geometry, overlay, sourceUnderlay: null });
  const fullBuffer = compositeSameSizeSourceOver(
    initFullPlateFromUnderlay(geometry, underlay),
    inkOnly
  );
  const [sourceOverlay, full] = await Promise.all([
    encodeRgbaBuffer(inkOnly, format),
    encodeRgbaBuffer(fullBuffer, format)
  ]);
  return {
    full: {
      blob: full.blob,
      format: full.format,
      width: fullBuffer.width,
      height: fullBuffer.height
    },
    sourceOverlay: {
      blob: sourceOverlay.blob,
      format: sourceOverlay.format,
      width: inkOnly.width,
      height: inkOnly.height
    }
  };
}

/**
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} options.format Output format.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} options.sourceUnderlay
 *   Pre-decoded underlay, or null.
 * @param {boolean} options.includeUnderlay Whether to composite the source underlay.
 * @returns {Promise<{blob: Blob, format: string, width: number, height: number}>}
 */
async function bakeAndEncodeSourceSpaceRaster({
  overlay,
  prompt,
  format,
  sourceUnderlay,
  includeUnderlay
}) {
  const geometry = computeDualSaveGeometry(prompt);
  const underlay = includeUnderlay
    ? (sourceUnderlay ?? await loadSourceUnderlayRgba(prompt))
    : null;
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
 * Composite a Prompt-canvas overlay onto an underlay (source-over).
 * Used when Save must rematerialize merged (ink + prompt image) from overlay + Framed bg.
 * Equal dimensions composite pixel for pixel; a wire-scaled overlay is remapped through
 * the shared area splat first, so it neither leaves holes when scaled up nor stacks alpha
 * when scaled down. Malformed buffers degrade to an underlay copy instead of throwing.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} underlay Underlay RGBA.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} overlay Overlay RGBA.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function compositeOverlayOntoUnderlay(underlay, overlay) {
  const overlayWidth = pixelDimension(overlay?.width);
  const overlayHeight = pixelDimension(overlay?.height);
  const width = pixelDimension(underlay?.width) || overlayWidth || 1;
  const height = pixelDimension(underlay?.height) || overlayHeight || 1;
  const merged = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
  copyRgbaBytes(merged.data, underlay?.data);
  if ( !overlay?.data || !overlayWidth || !overlayHeight ) return merged;
  if ( overlayWidth === width && overlayHeight === height ) {
    return compositeSameSizeSourceOver(merged, overlay);
  }

  const scaleX = width / overlayWidth;
  const scaleY = height / overlayHeight;
  return compositeSameSizeSourceOver(merged, splatOverlayInk({
    plate: merged,
    overlay,
    mapPoint: (x, y) => ({ x: x * scaleX, y: y * scaleY })
  }));
}

/**
 * Bake and encode a Prompt-canvas merged raster (Framed/prompt background + ink).
 * Prefers `background.framedPath` so the underlay matches what the player saw.
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} [options.format="webp"] Output format.
 * @returns {Promise<{blob: Blob, format: string, width: number, height: number}|null>}
 */
export async function bakeAndEncodePromptCanvasMerged({ overlay, prompt, format = "webp" } = {}) {
  if ( !hasPromptCanvasBackground(prompt) ) return null;
  const background = prompt.background ?? {};
  const underlayPath = background.framedPath || background.path;
  if ( !underlayPath ) return null;
  const width = Math.max(1, Math.floor(Number(prompt.canvasWidth) || Number(overlay?.width) || 1));
  const height = Math.max(1, Math.floor(Number(prompt.canvasHeight) || Number(overlay?.height) || 1));
  let underlay;
  try {
    underlay = await decodeImageToRgba(underlayPath, width, height);
  } catch (err) {
    console.warn("drawing-prompts | Prompt-canvas merged underlay load failed", err);
    return null;
  }
  const merged = compositeOverlayOntoUnderlay(underlay, overlay);
  const encoded = await encodeRgbaBuffer(merged, format);
  return {
    blob: encoded.blob,
    format: encoded.format,
    width: merged.width,
    height: merged.height
  };
}

/**
 * Normalize a declared buffer dimension to a whole pixel count.
 * @param {unknown} value Declared width or height.
 * @returns {number} Positive integer, or 0 when unusable.
 */
function pixelDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * Copy as many RGBA bytes as both buffers allow; the remainder stays transparent.
 * Tolerates buffers whose length disagrees with their declared dimensions.
 * @param {Uint8ClampedArray} dest Destination bytes.
 * @param {ArrayLike<number>|null|undefined} source Source bytes.
 * @returns {void}
 */
function copyRgbaBytes(dest, source) {
  if ( !source ) return;
  const length = Math.min(dest.length, Number(source.length) || 0);
  if ( length === Number(source.length) ) {
    dest.set(source);
    return;
  }
  for ( let i = 0; i < length; i++ ) dest[i] = source[i];
}

/**
 * Build a Full Framing preview data URL from a Prompt-canvas **overlay** source.
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
    console.warn("drawing-prompts | Full Framing underlay load failed", err);
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
