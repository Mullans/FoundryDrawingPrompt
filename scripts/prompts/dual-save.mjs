import { BG_SOURCE } from "../constants.mjs";
import { bakeDualRasters, computeFramingGeometry, dualSaveFilenames } from "../drawing/prompt-framing.mjs";
import { canvasToEncodedImage } from "../drawing/export-service.mjs";
import { resolvePromptFraming } from "./framed-delivery.mjs";

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
 * @param {object} options Options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay Overlay RGBA buffer.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} options.prompt Prompt.
 * @param {string} [options.format="webp"] Output format.
 * @returns {Promise<{blob: Blob, format: string, width: number, height: number}>}
 */
export async function bakeAndEncodeSourceFraming({ overlay, prompt, format = "webp" } = {}) {
  const geometry = computeDualSaveGeometry(prompt);
  const { source } = bakeDualRasters({ geometry, overlay });
  const encoded = await encodeRgbaBuffer(source, format);
  return {
    blob: encoded.blob,
    format: encoded.format,
    width: source.width,
    height: source.height
  };
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
    img.addEventListener("error", () => reject(new Error("Overlay image load failed.")), { once: true });
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
