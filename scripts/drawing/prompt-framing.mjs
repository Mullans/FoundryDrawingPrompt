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
 * Full Framing plate in source-pixel space: axis-aligned union of the natural
 * source rect and Prompt Framing (pad outside the source expands the plate).
 *
 * @param {object} options
 * @param {number} options.sourceWidth Natural source width.
 * @param {number} options.sourceHeight Natural source height.
 * @param {{x: number, y: number, width: number, height: number}|null} [options.framing]
 *   Prompt Framing in source space (defaults to full source).
 * @returns {{x: number, y: number, width: number, height: number}}
 *   Integer AABB; source sits at offsets `(-x, -y)` within the plate.
 */
export function computeFullFramingRect({ sourceWidth, sourceHeight, framing = null } = {}) {
  const sw = positiveNumber(sourceWidth, 1);
  const sh = positiveNumber(sourceHeight, 1);
  const frame = normalizeFraming(framing, sw, sh);
  const left = Math.min(0, frame.x);
  const top = Math.min(0, frame.y);
  const right = Math.max(sw, frame.x + frame.width);
  const bottom = Math.max(sh, frame.y + frame.height);
  const x = Math.floor(left);
  const y = Math.floor(top);
  const maxX = Math.ceil(right);
  const maxY = Math.ceil(bottom);
  return {
    x,
    y,
    width: Math.max(1, maxX - x),
    height: Math.max(1, maxY - y)
  };
}

/**
 * Pure Prompt Framing + Fit geometry: framed placement on the Prompt canvas,
 * source AABB relative to that canvas, Full Framing union plate, and maps either way.
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
 *   fullRect: {x: number, y: number, width: number, height: number},
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
  const fullRect = computeFullFramingRect({ sourceWidth: sw, sourceHeight: sh, framing: frame });

  return {
    framing: frame,
    framedPlacement,
    sourceOnCanvas,
    fullRect,
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
 * Map a Prompt canvas point into Full Framing plate space.
 * @param {ReturnType<typeof computeFramingGeometry>} geometry Framing geometry.
 * @param {number} x Prompt canvas x.
 * @param {number} y Prompt canvas y.
 * @returns {{x: number, y: number}}
 */
export function mapPromptToFull(geometry, x, y) {
  const source = mapPromptToSource(geometry, x, y);
  const fullRect = geometry.fullRect ?? computeFullFramingRect({
    sourceWidth: geometry.sourceWidth,
    sourceHeight: geometry.sourceHeight,
    framing: geometry.framing
  });
  return {
    x: source.x - fullRect.x,
    y: source.y - fullRect.y
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
 *   Prompt-canvas primary, Full Framing `_full`, and full-plate overlay leaves.
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
 * Prompt-facing output is canvas-sized; Full Framing (`source` key) is the composition
 * plate sized to fullRect (union of natural source and Prompt Framing) with remapped ink.
 * Pad-outside-source ink is retained on that plate.
 * When `sourceUnderlay` is provided, the natural source is drawn under remapped ink at
 * offsets `(-fullRect.x, -fullRect.y)`; otherwise the plate is transparent + ink.
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
export function initFullPlateFromUnderlay(geometry, sourceUnderlay = null) {
  const sourceWidth = geometry.sourceWidth;
  const sourceHeight = geometry.sourceHeight;
  const fullRect = geometry.fullRect ?? computeFullFramingRect({
    sourceWidth,
    sourceHeight,
    framing: geometry.framing
  });
  const fullWidth = Math.max(1, Math.round(fullRect.width));
  const fullHeight = Math.max(1, Math.round(fullRect.height));
  const source = {
    width: fullWidth,
    height: fullHeight,
    data: new Uint8ClampedArray(fullWidth * fullHeight * 4)
  };

  if ( sourceUnderlay?.data ) {
    const underW = Number(sourceUnderlay.width) || sourceWidth;
    const underH = Number(sourceUnderlay.height) || sourceHeight;
    const copyW = Math.min(underW, sourceWidth);
    const copyH = Math.min(underH, sourceHeight);
    const ox = -fullRect.x;
    const oy = -fullRect.y;
    for ( let sy = 0; sy < copyH; sy++ ) {
      const dy = sy + oy;
      if ( dy < 0 || dy >= fullHeight ) continue;
      for ( let sx = 0; sx < copyW; sx++ ) {
        const dx = sx + ox;
        if ( dx < 0 || dx >= fullWidth ) continue;
        const srcOffset = (sy * underW + sx) * 4;
        const destOffset = (dy * fullWidth + dx) * 4;
        source.data[destOffset] = sourceUnderlay.data[srcOffset];
        source.data[destOffset + 1] = sourceUnderlay.data[srcOffset + 1];
        source.data[destOffset + 2] = sourceUnderlay.data[srcOffset + 2];
        source.data[destOffset + 3] = sourceUnderlay.data[srcOffset + 3];
      }
    }
  }

  return source;
}

/**
 * Source-over composite of same-size RGBA buffers (ink onto an existing plate).
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} base Base plate (mutated).
 * @param {{width: number, height: number, data: Uint8ClampedArray|Uint8Array}} ink Ink RGBA at identical dimensions.
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
export function compositeSameSizeSourceOver(base, ink) {
  const width = Number(base?.width) || 1;
  const height = Number(base?.height) || 1;
  const inkData = ink?.data;
  if ( !inkData ) return base;
  for ( let i = 0; i < width * height; i++ ) {
    const offset = i * 4;
    const alpha = inkData[offset + 3];
    if ( !alpha ) continue;
    compositeSourceOver(base.data, offset, inkData[offset], inkData[offset + 1], inkData[offset + 2], alpha);
  }
  return base;
}

export function bakeDualRasters({ geometry, overlay, sourceUnderlay = null } = {}) {
  const canvasWidth = geometry.canvasWidth;
  const canvasHeight = geometry.canvasHeight;
  const sourceWidth = geometry.sourceWidth;
  const sourceHeight = geometry.sourceHeight;
  const fullRect = geometry.fullRect ?? computeFullFramingRect({
    sourceWidth,
    sourceHeight,
    framing: geometry.framing
  });
  const fullWidth = Math.max(1, Math.round(fullRect.width));
  const fullHeight = Math.max(1, Math.round(fullRect.height));
  const promptCanvas = copyRgbaBuffer(overlay, canvasWidth, canvasHeight);
  const source = initFullPlateFromUnderlay(geometry, sourceUnderlay);

  const overlayWidth = Number(overlay?.width) || canvasWidth;
  const overlayHeight = Number(overlay?.height) || canvasHeight;
  // Wire-scaled overlays are smaller than the Prompt canvas; map in canvas space
  // so Full Framing remapping stays correct after compress/downscale for transit.
  const toCanvasX = canvasWidth / Math.max(1, overlayWidth);
  const toCanvasY = canvasHeight / Math.max(1, overlayHeight);
  const data = overlay?.data;
  if ( !data ) return { promptCanvas, source };

  // Area splat into Full Framing plate: each overlay pixel covers a canvas rect;
  // map corners into plate (source − fullRect origin) and fill covered pixels.
  for ( let py = 0; py < overlayHeight; py++ ) {
    for ( let px = 0; px < overlayWidth; px++ ) {
      const srcOffset = (py * overlayWidth + px) * 4;
      const alpha = data[srcOffset + 3];
      if ( !alpha ) continue;

      const c0x = px * toCanvasX;
      const c1x = (px + 1) * toCanvasX;
      const c0y = py * toCanvasY;
      const c1y = (py + 1) * toCanvasY;
      const corners = [
        mapPromptToFull(geometry, c0x, c0y),
        mapPromptToFull(geometry, c1x, c0y),
        mapPromptToFull(geometry, c0x, c1y),
        mapPromptToFull(geometry, c1x, c1y)
      ];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for ( const corner of corners ) {
        if ( corner.x < minX ) minX = corner.x;
        if ( corner.x > maxX ) maxX = corner.x;
        if ( corner.y < minY ) minY = corner.y;
        if ( corner.y > maxY ) maxY = corner.y;
      }

      const fx0 = Math.max(0, Math.floor(minX));
      const fx1 = Math.min(fullWidth - 1, Math.ceil(maxX) - 1);
      const fy0 = Math.max(0, Math.floor(minY));
      const fy1 = Math.min(fullHeight - 1, Math.ceil(maxY) - 1);

      let xStart = fx0;
      let xEnd = fx1;
      let yStart = fy0;
      let yEnd = fy1;
      if ( xStart > xEnd || yStart > yEnd ) {
        const center = mapPromptToFull(
          geometry,
          (px + 0.5) * toCanvasX - 0.5,
          (py + 0.5) * toCanvasY - 0.5
        );
        const fx = Math.round(center.x);
        const fy = Math.round(center.y);
        if ( fx < 0 || fy < 0 || fx >= fullWidth || fy >= fullHeight ) continue;
        xStart = xEnd = fx;
        yStart = yEnd = fy;
      }

      const r = data[srcOffset];
      const g = data[srcOffset + 1];
      const b = data[srcOffset + 2];
      for ( let fy = yStart; fy <= yEnd; fy++ ) {
        for ( let fx = xStart; fx <= xEnd; fx++ ) {
          const destOffset = (fy * fullWidth + fx) * 4;
          compositeSourceOver(source.data, destOffset, r, g, b, alpha);
        }
      }
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
