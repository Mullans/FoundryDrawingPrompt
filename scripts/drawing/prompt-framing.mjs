import { computeBackgroundLayout } from "./background-layout.mjs";

/**
 * Default Prompt Framing: the full source image in source pixel space.
 * @param {number} sourceWidth Natural source width.
 * @param {number} sourceHeight Natural source height.
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function defaultPromptFraming(sourceWidth, sourceHeight) {
  const width = positiveNumber(sourceWidth, 1);
  const height = positiveNumber(sourceHeight, 1);
  return { x: 0, y: 0, width, height };
}

/**
 * Pure Prompt Framing + Fit geometry: framed placement on the Prompt canvas,
 * source AABB relative to that canvas, and linear maps either way.
 *
 * @param {object} options
 * @param {number} options.sourceWidth Natural source width.
 * @param {number} options.sourceHeight Natural source height.
 * @param {{x: number, y: number, width: number, height: number}|null} [options.framing]
 *   Axis-aligned Prompt Framing rect in source space (may extend outside).
 *   Defaults to the full source.
 * @param {string} options.fitMode Fit mode applied to the framed region size.
 * @param {number} options.canvasWidth Prompt canvas width.
 * @param {number} options.canvasHeight Prompt canvas height.
 * @returns {{
 *   framing: {x: number, y: number, width: number, height: number},
 *   framedPlacement: {dx: number, dy: number, dw: number, dh: number},
 *   sourceOnCanvas: {x: number, y: number, width: number, height: number},
 *   scaleX: number,
 *   scaleY: number,
 *   sourceWidth: number,
 *   sourceHeight: number,
 *   canvasWidth: number,
 *   canvasHeight: number
 * }}
 */
export function computeFramingGeometry({
  sourceWidth,
  sourceHeight,
  framing = null,
  fitMode,
  canvasWidth,
  canvasHeight
} = {}) {
  const sw = positiveNumber(sourceWidth, 1);
  const sh = positiveNumber(sourceHeight, 1);
  const cw = positiveNumber(canvasWidth, 1);
  const ch = positiveNumber(canvasHeight, 1);
  const frame = normalizeFraming(framing, sw, sh);
  const framedPlacement = computeBackgroundLayout(cw, ch, frame.width, frame.height, fitMode);
  const scaleX = framedPlacement.dw / frame.width;
  const scaleY = framedPlacement.dh / frame.height;
  const sourceOnCanvas = {
    x: framedPlacement.dx - frame.x * scaleX,
    y: framedPlacement.dy - frame.y * scaleY,
    width: sw * scaleX,
    height: sh * scaleY
  };

  return {
    framing: frame,
    framedPlacement,
    sourceOnCanvas,
    scaleX,
    scaleY,
    sourceWidth: sw,
    sourceHeight: sh,
    canvasWidth: cw,
    canvasHeight: ch
  };
}

/**
 * Map a Prompt canvas point into source image space.
 * @param {ReturnType<typeof computeFramingGeometry>} geometry Framing geometry.
 * @param {number} x Prompt canvas x.
 * @param {number} y Prompt canvas y.
 * @returns {{x: number, y: number}}
 */
export function mapPromptToSource(geometry, x, y) {
  const { framing, framedPlacement, scaleX, scaleY } = geometry;
  return {
    x: framing.x + (Number(x) - framedPlacement.dx) / scaleX,
    y: framing.y + (Number(y) - framedPlacement.dy) / scaleY
  };
}

/**
 * Map a source image point into Prompt canvas space.
 * @param {ReturnType<typeof computeFramingGeometry>} geometry Framing geometry.
 * @param {number} x Source x.
 * @param {number} y Source y.
 * @returns {{x: number, y: number}}
 */
export function mapSourceToPrompt(geometry, x, y) {
  const { framing, framedPlacement, scaleX, scaleY } = geometry;
  return {
    x: framedPlacement.dx + (Number(x) - framing.x) * scaleX,
    y: framedPlacement.dy + (Number(y) - framing.y) * scaleY
  };
}

/**
 * Basename set for dual Save outputs. `_full` / `_source` are always before the extension.
 * @param {string} name Basename with optional extension, or a path (leaf used).
 * @param {string} [extension] Extension when `name` has none (default webp).
 * @returns {{promptCanvas: string, source: string, sourceOverlay: string}}
 *   Prompt-canvas primary, Source Framing `_full`, and source-space overlay leaves.
 */
export function dualSaveFilenames(name, extension) {
  const leaf = String(name ?? "").split(/[\\/]/).pop() || "drawing";
  const dot = leaf.lastIndexOf(".");
  let stem;
  let ext;
  if ( extension !== undefined && extension !== null && String(extension).length ) {
    stem = leaf;
    ext = String(extension);
  } else if ( dot > 0 ) {
    stem = leaf.slice(0, dot);
    ext = leaf.slice(dot + 1);
  } else {
    stem = leaf;
    ext = "webp";
  }
  ext = normalizeExtension(ext);
  stem = stem || "drawing";
  return {
    promptCanvas: `${stem}.${ext}`,
    source: `${stem}_full.${ext}`,
    sourceOverlay: `${stem}_source.${ext}`
  };
}

/**
 * Dual raster bake from a synthetic Prompt-canvas overlay (RGBA buffer).
 * Prompt-facing output is canvas-sized; `_full` is source natural size with remapped ink.
 * Pad-outside-source ink is omitted from the `_full` raster.
 * When `sourceUnderlay` is provided, `_full` starts as that source image and ink is
 * composited on top with source-over alpha; otherwise `_full` is transparent + ink.
 *
 * @param {object} options
 * @param {ReturnType<typeof computeFramingGeometry>} options.geometry Framing geometry.
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} options.overlay
 *   Overlay in Prompt canvas coordinates (width/height should match the canvas).
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}|null} [options.sourceUnderlay]
 *   Optional source-image RGBA at natural size (drawn under remapped ink).
 * @returns {{
 *   promptCanvas: {width: number, height: number, data: Uint8ClampedArray},
 *   source: {width: number, height: number, data: Uint8ClampedArray}
 * }}
 */
export function bakeDualRasters({ geometry, overlay, sourceUnderlay = null } = {}) {
  const canvasWidth = geometry.canvasWidth;
  const canvasHeight = geometry.canvasHeight;
  const sourceWidth = geometry.sourceWidth;
  const sourceHeight = geometry.sourceHeight;
  const promptCanvas = copyRgbaBuffer(overlay, canvasWidth, canvasHeight);
  const source = sourceUnderlay
    ? copyRgbaBuffer(sourceUnderlay, sourceWidth, sourceHeight)
    : {
      width: sourceWidth,
      height: sourceHeight,
      data: new Uint8ClampedArray(sourceWidth * sourceHeight * 4)
    };

  const overlayWidth = Number(overlay?.width) || canvasWidth;
  const overlayHeight = Number(overlay?.height) || canvasHeight;
  // Wire-scaled overlays are smaller than the Prompt canvas; map in canvas space
  // so Source Framing remapping stays correct after compress/downscale for transit.
  const toCanvasX = canvasWidth / Math.max(1, overlayWidth);
  const toCanvasY = canvasHeight / Math.max(1, overlayHeight);
  const data = overlay?.data;
  if ( !data ) return { promptCanvas, source };

  for ( let py = 0; py < overlayHeight; py++ ) {
    for ( let px = 0; px < overlayWidth; px++ ) {
      const srcOffset = (py * overlayWidth + px) * 4;
      const alpha = data[srcOffset + 3];
      if ( !alpha ) continue;

      const canvasX = (px + 0.5) * toCanvasX - 0.5;
      const canvasY = (py + 0.5) * toCanvasY - 0.5;
      const mapped = mapPromptToSource(geometry, canvasX, canvasY);
      const sx = Math.round(mapped.x);
      const sy = Math.round(mapped.y);
      if ( sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight ) continue;

      const destOffset = (sy * sourceWidth + sx) * 4;
      compositeSourceOver(
        source.data,
        destOffset,
        data[srcOffset],
        data[srcOffset + 1],
        data[srcOffset + 2],
        alpha
      );
    }
  }

  return { promptCanvas, source };
}

/**
 * Source-over composite of one opaque-or-translucent pixel onto an RGBA buffer.
 * @param {Uint8ClampedArray} dest Destination buffer.
 * @param {number} destOffset Byte offset of the destination pixel.
 * @param {number} sr Source red.
 * @param {number} sg Source green.
 * @param {number} sb Source blue.
 * @param {number} sa Source alpha (0–255).
 * @returns {void}
 */
function compositeSourceOver(dest, destOffset, sr, sg, sb, sa) {
  if ( sa >= 255 ) {
    dest[destOffset] = sr;
    dest[destOffset + 1] = sg;
    dest[destOffset + 2] = sb;
    dest[destOffset + 3] = 255;
    return;
  }
  const srcA = sa / 255;
  const dstA = dest[destOffset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if ( outA <= 0 ) {
    dest[destOffset] = 0;
    dest[destOffset + 1] = 0;
    dest[destOffset + 2] = 0;
    dest[destOffset + 3] = 0;
    return;
  }
  const invSrcA = 1 - srcA;
  dest[destOffset] = Math.round((sr * srcA + dest[destOffset] * dstA * invSrcA) / outA);
  dest[destOffset + 1] = Math.round((sg * srcA + dest[destOffset + 1] * dstA * invSrcA) / outA);
  dest[destOffset + 2] = Math.round((sb * srcA + dest[destOffset + 2] * dstA * invSrcA) / outA);
  dest[destOffset + 3] = Math.round(outA * 255);
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}|null} framing
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function normalizeFraming(framing, sourceWidth, sourceHeight) {
  if ( !framing || typeof framing !== "object" ) {
    return defaultPromptFraming(sourceWidth, sourceHeight);
  }
  const width = positiveNumber(framing.width, sourceWidth);
  const height = positiveNumber(framing.height, sourceHeight);
  return {
    x: finiteNumber(framing.x, 0),
    y: finiteNumber(framing.y, 0),
    width,
    height
  };
}

/**
 * @param {{width?: number, height?: number, data?: ArrayLike<number>}|null} source
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
function copyRgbaBuffer(source, width, height) {
  const out = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
  };
  if ( !source?.data ) return out;
  const srcWidth = Number(source.width) || width;
  const srcHeight = Number(source.height) || height;
  const copyW = Math.min(width, srcWidth);
  const copyH = Math.min(height, srcHeight);
  for ( let y = 0; y < copyH; y++ ) {
    for ( let x = 0; x < copyW; x++ ) {
      const srcOffset = (y * srcWidth + x) * 4;
      const destOffset = (y * width + x) * 4;
      out.data[destOffset] = source.data[srcOffset];
      out.data[destOffset + 1] = source.data[srcOffset + 1];
      out.data[destOffset + 2] = source.data[srcOffset + 2];
      out.data[destOffset + 3] = source.data[srcOffset + 3];
    }
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {string} extension
 * @returns {string}
 */
function normalizeExtension(extension) {
  return String(extension || "webp")
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") || "webp";
}
