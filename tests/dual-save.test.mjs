import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_SOURCE, FIT_MODE, STATUS } from "../scripts/constants.mjs";
import { bakeDualRasters, mapPromptToSource } from "../scripts/drawing/prompt-framing.mjs";
import { DrawingAssignment } from "../scripts/prompts/prompt-models.mjs";
import {
  clearFramingViewAssets,
  computeDualSaveGeometry,
  hasSavedFramingViewAssets,
  hasSourceBackground,
  resolveFullFilename,
  resolveSubmissionOverlaySize
} from "../scripts/prompts/dual-save.mjs";
import { isSaveGateOpen } from "../scripts/prompts/transitions.mjs";
import { uniqueDrawingAssetFilenames } from "../scripts/prompts/naming-service.mjs";

test("hasSourceBackground is false for blank prompts and true for file sources with natural size", () => {
  assert.equal(hasSourceBackground({ background: { sourceType: BG_SOURCE.BLANK, path: null } }), false);
  assert.equal(hasSourceBackground({
    background: { sourceType: BG_SOURCE.FILE, path: "maps/dungeon.webp", naturalWidth: 800, naturalHeight: 600 }
  }), true);
  assert.equal(hasSourceBackground({
    background: { sourceType: BG_SOURCE.FILE, path: "maps/dungeon.webp", naturalWidth: null, naturalHeight: 600 }
  }), false);
});

test("resolveFullFilename puts _full before the extension", () => {
  assert.equal(resolveFullFilename("hero-ada", "webp"), "hero-ada_full.webp");
  assert.equal(resolveFullFilename("hero-ada", "png"), "hero-ada_full.png");
});

test("uniqueDrawingAssetFilenames reserves the _full leaf when a source asset is included", () => {
  const names = uniqueDrawingAssetFilenames({
    name: "Griffin",
    playerName: "Ada",
    extension: "webp",
    hasMerged: true,
    hasSourceFull: true,
    existingFiles: ["griffin-ada_full.webp"]
  });
  assert.equal(names.sourceFull, "griffin-ada-2_full.webp");
});

test("computeDualSaveGeometry uses prompt framing and natural source dimensions", () => {
  const geometry = computeDualSaveGeometry({
    canvasWidth: 100,
    canvasHeight: 100,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.STRETCH,
      naturalWidth: 4,
      naturalHeight: 4,
      framing: { x: 1, y: 1, width: 2, height: 2 }
    }
  });

  assert.equal(geometry.canvasWidth, 100);
  assert.equal(geometry.canvasHeight, 100);
  assert.equal(geometry.sourceWidth, 4);
  assert.equal(geometry.sourceHeight, 4);
  assert.deepEqual(geometry.framing, { x: 1, y: 1, width: 2, height: 2 });
});

test("resolveSubmissionOverlaySize prefers original (pre-wire-scale) dimensions", () => {
  const size = resolveSubmissionOverlaySize(
    { width: 256, height: 128, originalWidth: 1024, originalHeight: 512, wireScaled: true },
    { canvasWidth: 800, canvasHeight: 600 }
  );
  assert.deepEqual(size, { width: 1024, height: 512 });
});

test("resolveSubmissionOverlaySize falls back to width then canvas", () => {
  assert.deepEqual(
    resolveSubmissionOverlaySize({ width: 400, height: 300 }, { canvasWidth: 1024, canvasHeight: 768 }),
    { width: 400, height: 300 }
  );
  assert.deepEqual(
    resolveSubmissionOverlaySize({}, { canvasWidth: 1024, canvasHeight: 768 }),
    { width: 1024, height: 768 }
  );
});

test("bakeDualRasters remaps wire-scaled overlay pixels into full Prompt canvas space", () => {
  // Prompt canvas 4×4, full source, stretch; wire overlay 2×2 with ink at (1,1).
  // Without scale-up mapping that pixel would land at source (1,1); with wire→canvas
  // map it centers on canvas (2.5,2.5) → source (3,3) rounded.
  const geometry = computeDualSaveGeometry({
    canvasWidth: 4,
    canvasHeight: 4,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.STRETCH,
      naturalWidth: 4,
      naturalHeight: 4,
      framing: { x: 0, y: 0, width: 4, height: 4 }
    }
  });

  const overlay = blankRgba(2, 2);
  setPixel(overlay, 2, 1, 1, [0, 255, 0, 255]);
  const { source } = bakeDualRasters({ geometry, overlay });

  assert.deepEqual(getPixel(source, 4, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(source, 4, 3, 3), [0, 255, 0, 255]);
});

test("dual save remaps overlay ink into source natural resolution", () => {
  const geometry = computeDualSaveGeometry({
    canvasWidth: 4,
    canvasHeight: 4,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.STRETCH,
      naturalWidth: 4,
      naturalHeight: 4,
      framing: { x: 1, y: 1, width: 2, height: 2 }
    }
  });

  const overlay = blankRgba(4, 4);
  setPixel(overlay, 4, 1, 1, [255, 0, 0, 255]);
  const { promptCanvas, source } = bakeDualRasters({ geometry, overlay });

  assert.equal(promptCanvas.width, 4);
  assert.equal(promptCanvas.height, 4);
  assert.equal(source.width, 4);
  assert.equal(source.height, 4);

  const mapped = mapPromptToSource(geometry, 1, 1);
  const sx = Math.round(mapped.x);
  const sy = Math.round(mapped.y);
  assert.deepEqual(getPixel(source, 4, sx, sy), [255, 0, 0, 255]);
});

test("clearFramingViewAssets clears both Framing View paths and re-arms the Save gate", () => {
  const assignment = DrawingAssignment.fromObject({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    status: STATUS.SUBMITTED,
    submittedAt: 200,
    savedSubmissionTs: 200,
    assets: {
      overlayPath: "drawings/hero-overlay.webp",
      mergedPath: "drawings/hero.webp",
      fullPath: "drawings/hero_full.webp",
      oplogPath: "drawings/hero-oplog.json"
    }
  });

  assert.equal(hasSavedFramingViewAssets(assignment), true);
  assert.equal(isSaveGateOpen(assignment), true);

  clearFramingViewAssets(assignment);

  assert.equal(assignment.primaryImagePath, null);
  assert.equal(assignment.assets.fullPath, null);
  assert.equal(assignment.assets.oplogPath, "drawings/hero-oplog.json");
  assert.equal(assignment.savedSubmissionTs, null);
  assert.equal(isSaveGateOpen(assignment), false);
  assert.equal(hasSavedFramingViewAssets(assignment), false);
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
