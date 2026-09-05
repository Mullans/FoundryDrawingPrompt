import { INTERNAL } from "../constants.mjs";
import { estimateOpLogWireBytes } from "../prompts/wire-validation.mjs";

/**
 * Encode a canvas to a requested image format with PNG fallback.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Canvas.
 * @param {{format: string, quality?: number}} options Encoding options.
 * @returns {Promise<{blob: Blob, dataUrl: string, format: string}>}
 */
export async function canvasToEncodedImage(canvas, { format, quality } = {}) {
  const requestedFormat = format === "png" ? "png" : "webp";
  const requestedMime = mimeForFormat(requestedFormat);
  let blob = await canvasToBlob(canvas, requestedMime, quality);
  let resolvedFormat = requestedFormat;

  if ( !blob || blob.type !== requestedMime ) {
    resolvedFormat = "png";
    blob = await canvasToBlob(canvas, "image/png", quality);
  }

  if ( !blob ) throw new Error("Canvas image encoding failed.");
  return {
    blob,
    dataUrl: await blobToDataUrl(blob),
    format: resolvedFormat
  };
}

/**
 * Build a full-resolution submission payload from an engine.
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {{format: string, quality?: number}} options Export options.
 * @returns {Promise<{overlay: {dataUrl: string, format: string}, merged?: {dataUrl: string, format: string}, opLog: object, width: number, height: number}>}
 */
export async function buildFullSubmission(engine, { format, quality } = {}) {
  // Commit any rubber-band line draft so exported pixels and the op log stay aligned.
  engine.commitLineDraft?.();
  const hasBackground = engine.hasBackground;
  const [overlay, merged] = await Promise.all([
    engine.exportOverlay({ format, quality }),
    hasBackground ? engine.exportMerged({ format, quality }) : Promise.resolve(null)
  ]);
  const payload = {
    overlay: { dataUrl: overlay.dataUrl, format: overlay.format },
    ...(merged ? { merged: { dataUrl: merged.dataUrl, format: merged.format } } : {}),
    opLog: engine.getOpLog(),
    width: engine.width,
    height: engine.height
  };
  return payload;
}

/**
 * Build a socket-safe submission payload from an engine.
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {{format: string, quality?: number}} options Export options.
 * @returns {Promise<{overlay: {dataUrl: string, format: string}, merged?: {dataUrl: string, format: string}, opLog: object, width: number, height: number}>}
 */
export async function buildSubmission(engine, { format, quality } = {}) {
  const payload = await buildFullSubmission(engine, { format, quality });
  return enforceSubmissionWireLimit(engine, payload, { format, hasBackground: engine.hasBackground });
}

/**
 * Estimate submission wire size using data URL lengths as a base64 proxy.
 * @param {object} payload Submission payload.
 * @returns {number} Estimated bytes.
 */
export function estimateSubmissionWireSize(payload) {
  const images = String(payload?.overlay?.dataUrl ?? "").length
    + String(payload?.merged?.dataUrl ?? "").length;
  return images + estimateOpLogWireBytes(payload?.opLog);
}

/**
 * Choose the next compression/downscale step for an oversized submission.
 * @param {object} state Decision state.
 * @param {string} state.format Current wire format.
 * @param {number} state.size Current estimated wire size.
 * @param {number} state.maxBytes Maximum allowed bytes.
 * @param {number} state.qualityIndex Next WebP quality index.
 * @param {number} state.scale Current PNG scale.
 * @param {number} state.width Original width.
 * @param {number} state.height Original height.
 * @returns {{action: "done"}|{action: "quality", quality: number, qualityIndex: number}|{action: "downscale", scale: number, width: number, height: number}|{action: "oversized"}} Next step.
 */
export function nextWireSizeStep({
  format,
  size,
  maxBytes = INTERNAL.MAX_SUBMISSION_BYTES,
  qualityIndex = 0,
  scale = 1,
  width,
  height
}) {
  if ( Number(size) <= Number(maxBytes) ) return { action: "done" };
  if ( format !== "png" ) {
    const quality = INTERNAL.WIRE_QUALITY_STEPS[qualityIndex];
    if ( quality !== undefined ) return { action: "quality", quality, qualityIndex: qualityIndex + 1 };
    return { action: "oversized" };
  }

  const minOriginalEdge = Math.max(1, Math.min(Number(width) || 1, Number(height) || 1));
  const minScale = Math.min(1, 512 / minOriginalEdge);
  const currentScale = Number(scale || 1);
  const nextScale = Math.max(minScale, currentScale * INTERNAL.WIRE_DOWNSCALE_STEP);
  if ( nextScale < currentScale ) {
    return {
      action: "downscale",
      scale: nextScale,
      width: Math.max(1, Math.round(Number(width || 1) * nextScale)),
      height: Math.max(1, Math.round(Number(height || 1) * nextScale))
    };
  }
  return { action: "oversized" };
}

/**
 * Re-encode or downscale a submission payload until it fits the socket budget.
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {object} initialPayload Initial payload.
 * @param {{format?: string, hasBackground?: boolean}} options Export options.
 * @returns {Promise<object>} Wire-safe payload or marked best effort.
 */
async function enforceSubmissionWireLimit(engine, initialPayload, { format, hasBackground } = {}) {
  let payload = initialPayload;
  let strategyFormat = submissionFormat(payload, format);
  let qualityIndex = 0;
  let scale = 1;

  for ( let attempts = 0; attempts < INTERNAL.WIRE_QUALITY_STEPS.length + 16; attempts++ ) {
    const step = nextWireSizeStep({
      format: strategyFormat,
      size: estimateSubmissionWireSize(payload),
      maxBytes: INTERNAL.MAX_SUBMISSION_BYTES,
      qualityIndex,
      scale,
      width: initialPayload.width,
      height: initialPayload.height
    });

    if ( step.action === "done" ) return payload;
    if ( step.action === "oversized" ) {
      const trimmed = trimOpLogForWire(payload);
      if ( estimateSubmissionWireSize(trimmed) <= INTERNAL.MAX_SUBMISSION_BYTES ) return trimmed;
      return { ...trimmed, wireOversized: true, opLogTruncated: trimmed.opLog !== payload.opLog };
    }

    if ( step.action === "quality" ) {
      qualityIndex = step.qualityIndex;
      payload = await rebuildSubmissionImages(engine, payload, {
        format: "webp",
        quality: step.quality,
        hasBackground
      });
      strategyFormat = submissionFormat(payload, "webp");
      continue;
    }

    scale = step.scale;
    payload = await rebuildSubmissionImages(engine, payload, {
      format: "png",
      scale,
      hasBackground,
      width: step.width,
      height: step.height,
      originalWidth: initialPayload.width,
      originalHeight: initialPayload.height
    });
    strategyFormat = "png";
  }

  return { ...payload, wireOversized: true, opLogTruncated: Boolean(payload.opLog) };
}

/**
 * Drop redo tail from an op-log so wire size can fit under the cap.
 * @param {object} payload Submission payload.
 * @returns {object} Payload with trimmed op-log when possible.
 */
function trimOpLogForWire(payload) {
  const opLog = payload?.opLog;
  if ( !opLog || typeof opLog !== "object" ) return payload;
  const pointer = Number(opLog.pointer);
  const operations = Array.isArray(opLog.operations) ? opLog.operations : null;
  if ( !operations?.length || !Number.isFinite(pointer) ) return payload;
  return {
    ...payload,
    opLog: {
      ...opLog,
      operations: operations.slice(0, Math.max(0, pointer + 1))
    }
  };
}

/**
 * Rebuild submission image fields while preserving operation log data.
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {object} payload Existing payload.
 * @param {object} options Export options.
 * @returns {Promise<object>} Rebuilt payload.
 */
async function rebuildSubmissionImages(engine, payload, options) {
  const [overlay, merged] = await Promise.all([
    engine.exportOverlay(options),
    options.hasBackground ? engine.exportMerged(options) : Promise.resolve(null)
  ]);
  return {
    ...payload,
    overlay: { dataUrl: overlay.dataUrl, format: overlay.format },
    ...(merged ? { merged: { dataUrl: merged.dataUrl, format: merged.format } } : {}),
    ...(options.scale && options.scale < 1 ? {
      width: options.width,
      height: options.height,
      originalWidth: options.originalWidth,
      originalHeight: options.originalHeight,
      wireScaled: true
    } : {})
  };
}

/**
 * Resolve the compression strategy from actual encoded formats.
 * @param {object} payload Submission payload.
 * @param {string} requestedFormat Requested export format.
 * @returns {"webp"|"png"} Strategy format.
 */
function submissionFormat(payload, requestedFormat) {
  if ( requestedFormat === "png" ) return "png";
  if ( payload?.overlay?.format === "png" || payload?.merged?.format === "png" ) return "png";
  return "webp";
}

/**
 * Convert a canvas to a Blob.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Canvas.
 * @param {string} mime MIME type.
 * @param {number} [quality] Quality.
 * @returns {Promise<Blob|null>}
 */
async function canvasToBlob(canvas, mime, quality) {
  if ( typeof canvas.convertToBlob === "function" ) {
    try {
      return await canvas.convertToBlob({ type: mime, quality });
    } catch (_err) {
      return null;
    }
  }
  return new Promise(resolve => canvas.toBlob(resolve, mime, quality));
}

/**
 * Convert a Blob to a data URL.
 * @param {Blob} blob Blob.
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert format to MIME.
 * @param {string} format Format.
 * @returns {string}
 */
function mimeForFormat(format) {
  return format === "png" ? "image/png" : "image/webp";
}
