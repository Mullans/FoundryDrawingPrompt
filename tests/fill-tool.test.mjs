import assert from "node:assert/strict";
import { test } from "node:test";

import { floodFillRegion } from "../scripts/drawing/tools/fill-tool.mjs";

test("floodFillRegion fills only the contiguous matching region", () => {
  const pixels = rgbaGrid([
    ["w", "w", "b", "w"],
    ["w", "b", "b", "w"],
    ["w", "w", "w", "w"]
  ]);

  const result = floodFillRegion(pixels, 4, 3, { x: 0, y: 0 }, { r: 255, g: 0, b: 0, a: 255 }, 0);

  assert.equal(result.pixelsFilled, 9);
  assert.deepEqual(colorsAt(pixels, 4), [
    ["r", "r", "b", "r"],
    ["r", "b", "b", "r"],
    ["r", "r", "r", "r"]
  ]);
});

test("floodFillRegion uses RGBA channel tolerance", () => {
  const pixels = new Uint8ClampedArray([
    100, 100, 100, 255,
    110, 100, 100, 255,
    140, 100, 100, 255
  ]);

  const result = floodFillRegion(pixels, 3, 1, { x: 0, y: 0 }, { r: 0, g: 128, b: 255, a: 255 }, 16);

  assert.equal(result.pixelsFilled, 2);
  assert.deepEqual([...pixels], [
    0, 128, 255, 255,
    0, 128, 255, 255,
    140, 100, 100, 255
  ]);
});

function rgbaGrid(rows) {
  const colors = {
    w: [255, 255, 255, 255],
    b: [0, 0, 0, 255]
  };
  return new Uint8ClampedArray(rows.flatMap(row => row.flatMap(cell => colors[cell])));
}

function colorsAt(data, width) {
  const labels = [];
  for ( let y = 0; y < data.length / 4 / width; y++ ) {
    const row = [];
    for ( let x = 0; x < width; x++ ) {
      const offset = (y * width + x) * 4;
      const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]},${data[offset + 3]}`;
      row.push({
        "255,255,255,255": "w",
        "0,0,0,255": "b",
        "255,0,0,255": "r"
      }[key] ?? "?");
    }
    labels.push(row);
  }
  return labels;
}
