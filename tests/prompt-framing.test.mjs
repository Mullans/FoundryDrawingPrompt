import assert from "node:assert/strict";
import { test } from "node:test";

import { FIT_MODE } from "../scripts/constants.mjs";
import {
  bakeDualRasters,
  computeFramingGeometry,
  defaultPromptFraming,
  dualSaveFilenames,
  mapPromptToSource,
  mapSourceToPrompt
} from "../scripts/drawing/prompt-framing.mjs";

test("defaultPromptFraming is the full source image rect", () => {
  assert.deepEqual(defaultPromptFraming(2048, 1024), {
    x: 0,
    y: 0,
    width: 2048,
    height: 1024
  });
});

test("computeFramingGeometry full-source default + center places framed region at natural size", () => {
  const geometry = computeFramingGeometry({
    sourceWidth: 200,
    sourceHeight: 100,
    fitMode: FIT_MODE.CENTER,
    canvasWidth: 800,
    canvasHeight: 600
  });

  assert.deepEqual(geometry.framing, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(geometry.framedPlacement, { dx: 300, dy: 250, dw: 200, dh: 100 });
  assert.deepEqual(geometry.sourceOnCanvas, { x: 300, y: 250, width: 200, height: 100 });
});

test("computeFramingGeometry zoom-in crop: source AABB expands relative to framed placement", () => {
  // Source 100×100, crop center 50×50, stretch onto 100×100 prompt canvas.
  const geometry = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing: { x: 25, y: 25, width: 50, height: 50 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 100,
    canvasHeight: 100
  });

  assert.deepEqual(geometry.framedPlacement, { dx: 0, dy: 0, dw: 100, dh: 100 });
  // scale = 2; source origin is 25 framed-units left/up of framing origin.
  assert.deepEqual(geometry.sourceOnCanvas, { x: -50, y: -50, width: 200, height: 200 });
});

test("computeFramingGeometry zoom-out pad: source AABB sits inset on the prompt canvas", () => {
  // Framing extends 50px outside a 100×100 source on every side → 200×200 region.
  const geometry = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing: { x: -50, y: -50, width: 200, height: 200 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 200,
    canvasHeight: 200
  });

  assert.deepEqual(geometry.framedPlacement, { dx: 0, dy: 0, dw: 200, dh: 200 });
  assert.deepEqual(geometry.sourceOnCanvas, { x: 50, y: 50, width: 100, height: 100 });
});

test("fit modes place the framed region (not full source) into the prompt canvas", () => {
  const framing = { x: 10, y: 20, width: 40, height: 20 };
  const base = {
    sourceWidth: 100,
    sourceHeight: 80,
    framing,
    canvasWidth: 200,
    canvasHeight: 100
  };

  assert.deepEqual(
    computeFramingGeometry({ ...base, fitMode: FIT_MODE.CENTER }).framedPlacement,
    { dx: 80, dy: 40, dw: 40, dh: 20 }
  );
  assert.deepEqual(
    computeFramingGeometry({ ...base, fitMode: FIT_MODE.FIT_WIDTH }).framedPlacement,
    { dx: 0, dy: 0, dw: 200, dh: 100 }
  );
  assert.deepEqual(
    computeFramingGeometry({ ...base, fitMode: FIT_MODE.FIT_HEIGHT }).framedPlacement,
    { dx: 0, dy: 0, dw: 200, dh: 100 }
  );
  // framed 40×20 into 200×100 canvas: min(5, 5) → 200×100 centered
  assert.deepEqual(
    computeFramingGeometry({ ...base, fitMode: FIT_MODE.FIT_CANVAS }).framedPlacement,
    { dx: 0, dy: 0, dw: 200, dh: 100 }
  );
  assert.deepEqual(
    computeFramingGeometry({ ...base, fitMode: FIT_MODE.STRETCH }).framedPlacement,
    { dx: 0, dy: 0, dw: 200, dh: 100 }
  );

  // FIT_CANVAS shrinks a tall framed region to fit height first.
  const tall = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing: { x: 0, y: 0, width: 40, height: 80 },
    fitMode: FIT_MODE.FIT_CANVAS,
    canvasWidth: 200,
    canvasHeight: 100
  });
  assert.deepEqual(tall.framedPlacement, { dx: 75, dy: 0, dw: 50, dh: 100 });
});

test("Prompt↔source maps round-trip and match source AABB model", () => {
  const geometry = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing: { x: 25, y: 25, width: 50, height: 50 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 100,
    canvasHeight: 100
  });

  // Framed-region center → source center.
  assert.deepEqual(mapPromptToSource(geometry, 50, 50), { x: 50, y: 50 });
  assert.deepEqual(mapSourceToPrompt(geometry, 50, 50), { x: 50, y: 50 });

  // Prompt origin is framing origin in source space.
  assert.deepEqual(mapPromptToSource(geometry, 0, 0), { x: 25, y: 25 });
  // Source origin lands at the AABB top-left on the canvas.
  assert.deepEqual(mapSourceToPrompt(geometry, 0, 0), { x: -50, y: -50 });
  assert.deepEqual(mapSourceToPrompt(geometry, 0, 0), {
    x: geometry.sourceOnCanvas.x,
    y: geometry.sourceOnCanvas.y
  });

  const source = mapPromptToSource(geometry, 12.5, 37.5);
  const back = mapSourceToPrompt(geometry, source.x, source.y);
  assert.ok(Math.abs(back.x - 12.5) < 1e-9);
  assert.ok(Math.abs(back.y - 37.5) < 1e-9);
});

test("dualSaveFilenames puts _full before the extension", () => {
  assert.deepEqual(dualSaveFilenames("art.webp"), {
    promptCanvas: "art.webp",
    source: "art_full.webp"
  });
  assert.deepEqual(dualSaveFilenames("hero", "png"), {
    promptCanvas: "hero.png",
    source: "hero_full.png"
  });
  assert.deepEqual(dualSaveFilenames("path/with.dots/name.WEBP"), {
    promptCanvas: "name.webp",
    source: "name_full.webp"
  });
});

test("bakeDualRasters: prompt-facing is canvas-sized; _full remaps marker into source space", () => {
  // Source 4×4, framing center 2×2 crop, stretch onto 4×4 prompt canvas → scale 2.
  const geometry = computeFramingGeometry({
    sourceWidth: 4,
    sourceHeight: 4,
    framing: { x: 1, y: 1, width: 2, height: 2 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 4,
    canvasHeight: 4
  });

  // Overlay: unique marker at prompt (1, 1) → source (1.5, 1.5) after map.
  // mapPromptToSource(1,1): local = (1-0)*(2/4) = 0.5; source = 1+0.5 = 1.5
  const overlay = blankRgba(4, 4);
  setPixel(overlay, 4, 1, 1, [255, 0, 0, 255]); // marker at prompt (1,1)

  const { promptCanvas, source } = bakeDualRasters({ geometry, overlay });

  assert.equal(promptCanvas.width, 4);
  assert.equal(promptCanvas.height, 4);
  assert.equal(source.width, 4);
  assert.equal(source.height, 4);
  assert.deepEqual(getPixel(promptCanvas, 4, 1, 1), [255, 0, 0, 255]);

  // Continuous map (1,1) → (1.5, 1.5). Bake writes to nearest integer pixel.
  const expected = mapPromptToSource(geometry, 1, 1);
  assert.deepEqual(expected, { x: 1.5, y: 1.5 });
  const sx = Math.round(expected.x);
  const sy = Math.round(expected.y);
  assert.deepEqual(getPixel(source, 4, sx, sy), [255, 0, 0, 255]);
  // Marker must not remain at prompt coords on the source raster.
  assert.notDeepEqual(getPixel(source, 4, 1, 1), [255, 0, 0, 255]);
});

test("bakeDualRasters pad-beyond-source: ink outside source AABB is dropped from _full", () => {
  // Framing includes 1px pad; stretch onto 6×6 canvas; source 4×4 centered.
  const geometry = computeFramingGeometry({
    sourceWidth: 4,
    sourceHeight: 4,
    framing: { x: -1, y: -1, width: 6, height: 6 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 6,
    canvasHeight: 6
  });
  assert.deepEqual(geometry.sourceOnCanvas, { x: 1, y: 1, width: 4, height: 4 });

  const overlay = blankRgba(6, 6);
  // Outside source: prompt (0,0) → source (-1,-1)
  setPixel(overlay, 6, 0, 0, [0, 255, 0, 255]);
  // Inside source: prompt (1,1) → source (0,0)
  setPixel(overlay, 6, 1, 1, [0, 0, 255, 255]);

  const { source } = bakeDualRasters({ geometry, overlay });
  assert.equal(source.width, 4);
  assert.equal(source.height, 4);
  assert.deepEqual(getPixel(source, 4, 0, 0), [0, 0, 255, 255]);
  // Green outside-source marker never lands on the natural-size raster.
  for ( let y = 0; y < 4; y++ ) {
    for ( let x = 0; x < 4; x++ ) {
      assert.notDeepEqual(getPixel(source, 4, x, y), [0, 255, 0, 255]);
    }
  }
});

/**
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number, data: Uint8ClampedArray}}
 */
function blankRgba(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * @param {{data: Uint8ClampedArray}} image
 * @param {number} width
 * @param {number} x
 * @param {number} y
 * @param {number[]} rgba
 */
function setPixel(image, width, x, y, rgba) {
  const offset = (y * width + x) * 4;
  image.data[offset] = rgba[0];
  image.data[offset + 1] = rgba[1];
  image.data[offset + 2] = rgba[2];
  image.data[offset + 3] = rgba[3];
}

/**
 * @param {{data: Uint8ClampedArray}} image
 * @param {number} width
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
function getPixel(image, width, x, y) {
  const offset = (y * width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ];
}
