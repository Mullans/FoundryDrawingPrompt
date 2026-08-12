import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_SOURCE, FIT_MODE } from "../scripts/constants.mjs";
import {
  bakeFramedBackgroundRaster,
  defaultFramingForBackground,
  playerBackgroundPayload
} from "../scripts/drawing/framed-background.mjs";
import { computeFramingGeometry } from "../scripts/drawing/prompt-framing.mjs";
import { DrawingPrompt } from "../scripts/prompts/prompt-models.mjs";

test("defaultFramingForBackground is full source when natural size is known", () => {
  assert.deepEqual(defaultFramingForBackground({
    sourceType: BG_SOURCE.FILE,
    path: "maps/dungeon.webp",
    naturalWidth: 800,
    naturalHeight: 600
  }), { x: 0, y: 0, width: 800, height: 600 });
});

test("defaultFramingForBackground is null for blank prompts", () => {
  assert.equal(defaultFramingForBackground({
    sourceType: BG_SOURCE.BLANK,
    path: null,
    naturalWidth: null,
    naturalHeight: null
  }), null);
});

test("bakeFramedBackgroundRaster full-source fit-width matches legacy background layout", () => {
  const source = checkerSource(200, 100);
  const geometry = computeFramingGeometry({
    sourceWidth: 200,
    sourceHeight: 100,
    fitMode: FIT_MODE.FIT_WIDTH,
    canvasWidth: 800,
    canvasHeight: 600
  });
  const baked = bakeFramedBackgroundRaster({ source, geometry });

  assert.equal(baked.width, 800);
  assert.equal(baked.height, 600);
  // FIT_WIDTH on 200×100 into 800×600 → 800×400 centered vertically at y=100.
  assert.deepEqual(samplePixel(baked, 400, 50), [0, 0, 0, 0]);
  assert.deepEqual(samplePixel(baked, 400, 150), [255, 0, 0, 255]);
  assert.deepEqual(samplePixel(baked, 0, 150), [255, 0, 0, 255]);
  assert.deepEqual(samplePixel(baked, 799, 499), [255, 0, 0, 255]);
  assert.deepEqual(samplePixel(baked, 799, 549), [0, 0, 0, 0]);
});

test("bakeFramedBackgroundRaster crop exposes only the framed region", () => {
  const source = gradientSource(100, 100);
  const geometry = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing: { x: 25, y: 25, width: 50, height: 50 },
    fitMode: FIT_MODE.STRETCH,
    canvasWidth: 50,
    canvasHeight: 50
  });
  const baked = bakeFramedBackgroundRaster({ source, geometry });

  assert.deepEqual(samplePixel(baked, 0, 0), samplePixel(source, 25, 25));
  assert.deepEqual(samplePixel(baked, 49, 49), samplePixel(source, 74, 74));
});

test("playerBackgroundPayload never exposes the full source path or source natural size", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    canvasWidth: 640,
    canvasHeight: 480,
    sentAt: 1000,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/full-dungeon.webp",
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: 4096,
      naturalHeight: 3072,
      framing: { x: 0, y: 0, width: 4096, height: 3072 },
      framedPath: "drawing-prompts/staging/p1-framed.webp"
    }
  });

  const playerBg = playerBackgroundPayload(prompt);
  assert.equal(playerBg.path, "drawing-prompts/staging/p1-framed.webp");
  assert.notEqual(playerBg.path, prompt.background.path);
  assert.equal(playerBg.preFramed, true);
  assert.equal(playerBg.naturalWidth, 640);
  assert.equal(playerBg.naturalHeight, 480);
  assert.equal(playerBg.framing, undefined);
  assert.equal(playerBg.framedPath, undefined);
});

test("playerBackgroundPayload is blank when no framed asset exists", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p2",
    canvasWidth: 1024,
    canvasHeight: 768,
    background: {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: null,
      naturalHeight: null,
      framing: null,
      framedPath: null
    }
  });

  const playerBg = playerBackgroundPayload(prompt);
  assert.equal(playerBg.path, null);
  assert.equal(playerBg.sourceType, BG_SOURCE.BLANK);
  assert.equal(playerBg.preFramed, true);
});

/**
 * @param {number} width
 * @param {number} height
 */
function checkerSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for ( let y = 0; y < height; y++ ) {
    for ( let x = 0; x < width; x++ ) {
      const alpha = 255;
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = alpha;
    }
  }
  return { width, height, data };
}

/**
 * @param {number} width
 * @param {number} height
 */
function gradientSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for ( let y = 0; y < height; y++ ) {
    for ( let x = 0; x < width; x++ ) {
      const offset = (y * width + x) * 4;
      data[offset] = x;
      data[offset + 1] = y;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * @param {{width: number, height: number, data: Uint8ClampedArray}} image
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
function samplePixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [
    image.data[offset],
    image.data[offset + 1],
    image.data[offset + 2],
    image.data[offset + 3]
  ];
}
