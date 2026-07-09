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
 * Build a socket submission payload from an engine.
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {{format: string, quality?: number}} options Export options.
 * @returns {Promise<{overlay: {dataUrl: string, format: string}, merged?: {dataUrl: string, format: string}, opLog: object, width: number, height: number}>}
 */
export async function buildSubmission(engine, { format, quality } = {}) {
  const hasBackground = engine.hasBackground;
  const [overlay, merged] = await Promise.all([
    engine.exportOverlay({ format, quality }),
    hasBackground ? engine.exportMerged({ format, quality }) : Promise.resolve(null)
  ]);
  return {
    overlay: { dataUrl: overlay.dataUrl, format: overlay.format },
    ...(merged ? { merged: { dataUrl: merged.dataUrl, format: merged.format } } : {}),
    opLog: engine.getOpLog(),
    width: engine.width,
    height: engine.height
  };
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
