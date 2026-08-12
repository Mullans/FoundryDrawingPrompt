import { BG_SOURCE, FIT_MODE } from "../constants.mjs";
import { canvasToEncodedImage } from "./export-service.mjs";
import { computeFramingGeometry, defaultPromptFraming, mapPromptToSource } from "./prompt-framing.mjs";

/**
 * Resolve default Prompt Framing from a background descriptor.
 * @param {{sourceType?: string, path?: string|null, naturalWidth?: number|null, naturalHeight?: number|null}} background
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function defaultFramingForBackground(background = {}) {
  const path = background.path ?? null;
  const sourceType = background.sourceType ?? BG_SOURCE.BLANK;
  if ( !path || sourceType === BG_SOURCE.BLANK ) return null;
  const naturalWidth = Number(background.naturalWidth);
  const naturalHeight = Number(background.naturalHeight);
  if ( !(naturalWidth > 0 && naturalHeight > 0) ) return null;
  return defaultPromptFraming(naturalWidth, naturalHeight);
}

/**
 * Build the player-safe background payload for one prompt.
 * Full source paths and source natural dimensions never leave the GM client.
 * @param {import("../prompts/prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {{sourceType: string, path: string|null, fitMode: string, preFramed: true, naturalWidth: number|null, naturalHeight: number|null}}
 */
export function playerBackgroundPayload(prompt) {
  const framedPath = prompt.background?.framedPath ?? null;
  if ( !framedPath ) {
    return {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      fitMode: FIT_MODE.STRETCH,
      preFramed: true,
      naturalWidth: null,
      naturalHeight: null
    };
  }
  return {
    sourceType: BG_SOURCE.FILE,
    path: framedPath,
    fitMode: FIT_MODE.STRETCH,
    preFramed: true,
    naturalWidth: prompt.canvasWidth,
    naturalHeight: prompt.canvasHeight
  };
}

/**
 * Bake a canvas-sized Framed background raster from a source RGBA buffer.
 * @param {object} options Bake options.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.source Source RGBA buffer.
 * @param {ReturnType<typeof computeFramingGeometry>} options.geometry Framing geometry.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function bakeFramedBackgroundRaster({ source, geometry } = {}) {
  const width = geometry.canvasWidth;
  const height = geometry.canvasHeight;
  const data = new Uint8ClampedArray(width * height * 4);
  const sourceWidth = Number(source?.width) || 0;
  const sourceHeight = Number(source?.height) || 0;
  const sourceData = source?.data;
  if ( !sourceData ) return { width, height, data };

  for ( let py = 0; py < height; py++ ) {
    for ( let px = 0; px < width; px++ ) {
      const mapped = mapPromptToSource(geometry, px, py);
      const sx = Math.floor(mapped.x);
      const sy = Math.floor(mapped.y);
      const destOffset = (py * width + px) * 4;
      if ( sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight ) continue;
      const srcOffset = (sy * sourceWidth + sx) * 4;
      data[destOffset] = sourceData[srcOffset];
      data[destOffset + 1] = sourceData[srcOffset + 1];
      data[destOffset + 2] = sourceData[srcOffset + 2];
      data[destOffset + 3] = sourceData[srcOffset + 3];
    }
  }

  return { width, height, data };
}

/**
 * Draw a Framed background onto a 2D canvas context.
 * @param {CanvasRenderingContext2D} context Target context.
 * @param {CanvasImageSource} img Loaded source image.
 * @param {ReturnType<typeof computeFramingGeometry>} geometry Framing geometry.
 * @returns {void}
 */
export function drawFramedBackground(context, img, geometry) {
  const { framing, framedPlacement } = geometry;
  context.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
  context.drawImage(
    img,
    framing.x,
    framing.y,
    framing.width,
    framing.height,
    framedPlacement.dx,
    framedPlacement.dy,
    framedPlacement.dw,
    framedPlacement.dh
  );
}

/**
 * Bake a canvas-sized Framed background from a loaded image.
 * @param {object} options Bake options.
 * @param {HTMLImageElement|CanvasImageSource} options.img Loaded source image.
 * @param {number} options.naturalWidth Source natural width.
 * @param {number} options.naturalHeight Source natural height.
 * @param {{x: number, y: number, width: number, height: number}|null} [options.framing] Prompt Framing.
 * @param {string} options.fitMode Fit mode.
 * @param {number} options.canvasWidth Prompt canvas width.
 * @param {number} options.canvasHeight Prompt canvas height.
 * @returns {HTMLCanvasElement}
 */
export function bakeFramedBackgroundCanvas({
  img,
  naturalWidth,
  naturalHeight,
  framing = null,
  fitMode,
  canvasWidth,
  canvasHeight
} = {}) {
  const geometry = computeFramingGeometry({
    sourceWidth: naturalWidth,
    sourceHeight: naturalHeight,
    framing,
    fitMode,
    canvasWidth,
    canvasHeight
  });
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  drawFramedBackground(canvas.getContext("2d"), img, geometry);
  return canvas;
}

/**
 * Encode a baked Framed background canvas for upload.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas Baked canvas.
 * @param {{format?: string, quality?: number}} [options] Encoding options.
 * @returns {Promise<{blob: Blob, format: string}>}
 */
export async function encodeFramedBackground(canvas, { format = "webp", quality } = {}) {
  const encoded = await canvasToEncodedImage(canvas, { format, quality });
  return { blob: encoded.blob, format: encoded.format };
}
