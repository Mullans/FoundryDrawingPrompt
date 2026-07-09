/**
 * Paint bucket tool.
 */
export class FillTool {
  /**
   * Fill a bounded region.
   * @param {{x: number, y: number}} pt Logical point.
   * @param {object} engineCtx Engine tool context.
   * @returns {void}
   */
  onPointerDown(pt, engineCtx) {
    engineCtx.fill(pt);
  }

  /** @returns {void} */
  onPointerMove() {}

  /** @returns {void} */
  onPointerUp() {}
}

/**
 * Scanline flood fill over an RGBA buffer.
 * Mutates data by painting matching pixels and returns a mask of painted pixels.
 * @param {Uint8ClampedArray} data RGBA image data.
 * @param {number} width Width in pixels.
 * @param {number} height Height in pixels.
 * @param {{x: number, y: number}} seed Seed point.
 * @param {{r: number, g: number, b: number, a: number}} color Replacement color.
 * @param {number} tolerance Per-channel tolerance.
 * @returns {{pixelsFilled: number, mask: Uint8Array}}
 */
export function floodFillRegion(data, width, height, seed, color, tolerance) {
  const mask = new Uint8Array(width * height);
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if ( sx < 0 || sy < 0 || sx >= width || sy >= height ) return { pixelsFilled: 0, mask };

  const seedOffset = (sy * width + sx) * 4;
  const target = [
    data[seedOffset],
    data[seedOffset + 1],
    data[seedOffset + 2],
    data[seedOffset + 3]
  ];
  const replacement = [
    clampChannel(color.r),
    clampChannel(color.g),
    clampChannel(color.b),
    clampChannel(color.a)
  ];
  const stack = [[sx, sy]];
  let pixelsFilled = 0;

  while ( stack.length ) {
    const [startX, y] = stack.pop();
    let x = startX;
    while ( x >= 0 && !mask[y * width + x] && matches(data, y * width + x, target, tolerance) ) x--;
    x++;

    let spanAbove = false;
    let spanBelow = false;
    for ( ; x < width && !mask[y * width + x] && matches(data, y * width + x, target, tolerance); x++ ) {
      const index = y * width + x;
      const offset = index * 4;
      mask[index] = 1;
      data[offset] = replacement[0];
      data[offset + 1] = replacement[1];
      data[offset + 2] = replacement[2];
      data[offset + 3] = replacement[3];
      pixelsFilled++;

      if ( y > 0 ) {
        const above = (y - 1) * width + x;
        if ( !spanAbove && !mask[above] && matches(data, above, target, tolerance) ) {
          stack.push([x, y - 1]);
          spanAbove = true;
        } else if ( spanAbove && (mask[above] || !matches(data, above, target, tolerance)) ) {
          spanAbove = false;
        }
      }

      if ( y < height - 1 ) {
        const below = (y + 1) * width + x;
        if ( !spanBelow && !mask[below] && matches(data, below, target, tolerance) ) {
          stack.push([x, y + 1]);
          spanBelow = true;
        } else if ( spanBelow && (mask[below] || !matches(data, below, target, tolerance)) ) {
          spanBelow = false;
        }
      }
    }
  }

  return { pixelsFilled, mask };
}

/**
 * Test a pixel against the target color.
 * @param {Uint8ClampedArray} data Data.
 * @param {number} index Pixel index.
 * @param {number[]} target Target RGBA.
 * @param {number} tolerance Tolerance.
 * @returns {boolean}
 */
function matches(data, index, target, tolerance) {
  const offset = index * 4;
  return Math.abs(data[offset] - target[0]) <= tolerance
    && Math.abs(data[offset + 1] - target[1]) <= tolerance
    && Math.abs(data[offset + 2] - target[2]) <= tolerance
    && Math.abs(data[offset + 3] - target[3]) <= tolerance;
}

/**
 * Clamp a channel to byte range.
 * @param {number} value Channel.
 * @returns {number}
 */
function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}
