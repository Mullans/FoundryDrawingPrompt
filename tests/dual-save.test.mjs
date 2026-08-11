import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_SOURCE, FIT_MODE, FRAMING_VIEW, STATUS } from "../scripts/constants.mjs";
import { bakeDualRasters, mapPromptToSource } from "../scripts/drawing/prompt-framing.mjs";
import { DrawingAssignment } from "../scripts/prompts/prompt-models.mjs";
import {
  canPlaceFramingView,
  clearFramingViewAssets,
  computeDualSaveGeometry,
  hasPromptCanvasBackground,
  hasSavedFramingViewAssets,
  hasSourceBackground,
  normalizeFramingView,
  pickSubmissionOverlaySrc,
  pickSubmissionPromptCanvasSrc,
  resolveFramingViewAssetPath,
  resolveFullFilename,
  resolveSourceOverlayFilename,
  resolveSubmissionOverlaySize,
  shouldWriteMergedSubmission,
  compositeOverlayOntoUnderlay
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

test("resolveSourceOverlayFilename puts _source before the extension", () => {
  assert.equal(resolveSourceOverlayFilename("hero-ada", "webp"), "hero-ada_source.webp");
  assert.equal(resolveSourceOverlayFilename("hero-ada", "png"), "hero-ada_source.png");
});

test("uniqueDrawingAssetFilenames reserves _full and _source leaves when source assets are included", () => {
  const names = uniqueDrawingAssetFilenames({
    name: "Griffin",
    playerName: "Ada",
    extension: "webp",
    hasMerged: true,
    hasSourceFull: true,
    existingFiles: ["griffin-ada_full.webp"]
  });
  assert.equal(names.sourceFull, "griffin-ada-2_full.webp");
  assert.equal(names.sourceOverlay, "griffin-ada-2_source.webp");

  const collideSource = uniqueDrawingAssetFilenames({
    name: "Griffin",
    playerName: "Ada",
    extension: "webp",
    hasMerged: false,
    hasSourceFull: true,
    existingFiles: ["griffin-ada_source.webp"]
  });
  assert.equal(collideSource.sourceOverlay, "griffin-ada-2_source.webp");
  assert.equal(collideSource.sourceFull, "griffin-ada-2_full.webp");
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

test("dual save Source Framing bake composites remapped ink over source underlay", () => {
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

  const sourceUnderlay = blankRgba(4, 4);
  for ( let y = 0; y < 4; y++ ) {
    for ( let x = 0; x < 4; x++ ) {
      setPixel(sourceUnderlay, 4, x, y, [40, 80, 120, 255]);
    }
  }

  const overlay = blankRgba(4, 4);
  setPixel(overlay, 4, 2, 2, [255, 255, 0, 255]);
  const { source } = bakeDualRasters({ geometry, overlay, sourceUnderlay });

  assert.deepEqual(getPixel(source, 4, 2, 2), [255, 255, 0, 255]);
  assert.deepEqual(getPixel(source, 4, 0, 0), [40, 80, 120, 255]);
  assert.deepEqual(getPixel(source, 4, 3, 3), [40, 80, 120, 255]);
});

test("source-space overlay bake is remapped ink only; _full keeps source underlay", () => {
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

  const sourceUnderlay = blankRgba(4, 4);
  for ( let y = 0; y < 4; y++ ) {
    for ( let x = 0; x < 4; x++ ) {
      setPixel(sourceUnderlay, 4, x, y, [10, 20, 30, 255]);
    }
  }

  const overlay = blankRgba(4, 4);
  setPixel(overlay, 4, 1, 1, [255, 0, 0, 255]);

  const { source: sourceOverlay } = bakeDualRasters({ geometry, overlay });
  const { source: full } = bakeDualRasters({ geometry, overlay, sourceUnderlay });

  const mapped = mapPromptToSource(geometry, 1, 1);
  const sx = Math.round(mapped.x);
  const sy = Math.round(mapped.y);

  assert.equal(sourceOverlay.width, 4);
  assert.equal(sourceOverlay.height, 4);
  assert.deepEqual(getPixel(sourceOverlay, 4, sx, sy), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(sourceOverlay, 4, 0, 0), [0, 0, 0, 0]);

  assert.deepEqual(getPixel(full, 4, sx, sy), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(full, 4, 0, 0), [10, 20, 30, 255]);
});

test("compositeOverlayOntoUnderlay paints ink over a prompt-canvas underlay", () => {
  const underlay = blankRgba(4, 4);
  for ( let y = 0; y < 4; y++ ) {
    for ( let x = 0; x < 4; x++ ) {
      setPixel(underlay, 4, x, y, [100, 100, 100, 255]);
    }
  }
  const overlay = blankRgba(4, 4);
  setPixel(overlay, 4, 2, 1, [0, 255, 0, 255]);
  const merged = compositeOverlayOntoUnderlay(underlay, overlay);
  assert.deepEqual(getPixel(merged, 4, 2, 1), [0, 255, 0, 255]);
  assert.deepEqual(getPixel(merged, 4, 0, 0), [100, 100, 100, 255]);
});

test("shouldWriteMergedSubmission is true when framed/prompt background exists even without staged merged", () => {
  const promptWithFramed = {
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      framedPath: "staging/p1-framed.webp",
      naturalWidth: 800,
      naturalHeight: 600
    }
  };
  assert.equal(shouldWriteMergedSubmission({
    mode: "staged",
    staged: { overlayPath: "staging/a1-overlay.webp", mergedPath: null }
  }, promptWithFramed), true);
  assert.equal(hasPromptCanvasBackground(promptWithFramed), true);

  assert.equal(shouldWriteMergedSubmission({
    mode: "inline",
    overlay: { dataUrl: "data:image/webp;base64,overlay" },
    merged: { dataUrl: "data:image/webp;base64,merged" }
  }, { background: { sourceType: BG_SOURCE.BLANK } }), true);

  assert.equal(shouldWriteMergedSubmission({
    mode: "staged",
    staged: { overlayPath: "staging/a1-overlay.webp", mergedPath: null }
  }, { background: { sourceType: BG_SOURCE.BLANK, path: null } }), false);
});

test("normalizeFramingView rejects Source Framing without a source and unknown values", () => {
  assert.equal(normalizeFramingView(FRAMING_VIEW.SOURCE, { hasSource: true }), FRAMING_VIEW.SOURCE);
  assert.equal(normalizeFramingView(FRAMING_VIEW.SOURCE, { hasSource: false }), FRAMING_VIEW.PROMPT_CANVAS);
  assert.equal(normalizeFramingView(FRAMING_VIEW.PROMPT_CANVAS, { hasSource: true }), FRAMING_VIEW.PROMPT_CANVAS);
  assert.equal(normalizeFramingView("nope", { hasSource: true }), FRAMING_VIEW.PROMPT_CANVAS);
  assert.equal(normalizeFramingView(null), FRAMING_VIEW.PROMPT_CANVAS);
});

test("resolveFramingViewAssetPath picks primary vs fullPath by Framing View", () => {
  const assignment = DrawingAssignment.fromObject({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    status: STATUS.SUBMITTED,
    assets: {
      overlayPath: "drawings/hero-overlay.webp",
      mergedPath: "drawings/hero.webp",
      fullPath: "drawings/hero_full.webp"
    }
  });
  assert.equal(resolveFramingViewAssetPath(assignment, FRAMING_VIEW.PROMPT_CANVAS), "drawings/hero.webp");
  assert.equal(resolveFramingViewAssetPath(assignment, FRAMING_VIEW.SOURCE), "drawings/hero_full.webp");
  assert.equal(resolveFramingViewAssetPath(null, FRAMING_VIEW.PROMPT_CANVAS), null);

  const blankOnly = DrawingAssignment.fromObject({
    id: "a2",
    promptId: "p1",
    userId: "u1",
    status: STATUS.SUBMITTED,
    assets: { overlayPath: "drawings/blank.webp", mergedPath: null, fullPath: null }
  });
  assert.equal(resolveFramingViewAssetPath(blankOnly, FRAMING_VIEW.PROMPT_CANVAS), "drawings/blank.webp");
  assert.equal(resolveFramingViewAssetPath(blankOnly, FRAMING_VIEW.SOURCE), null);
});

test("canPlaceFramingView uses the dual Save gate and current view path", () => {
  const assignment = DrawingAssignment.fromObject({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    status: STATUS.SUBMITTED,
    submittedAt: 100,
    savedSubmissionTs: 100,
    assets: {
      overlayPath: "drawings/hero-overlay.webp",
      mergedPath: "drawings/hero.webp",
      fullPath: "drawings/hero_full.webp"
    }
  });
  assert.equal(isSaveGateOpen(assignment), true);
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.PROMPT_CANVAS), true);
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.SOURCE), true);

  assignment.assets.fullPath = null;
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.SOURCE), false);
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.PROMPT_CANVAS), true);

  // Toggling framing view state is not modeled here — only savedSubmissionTs re-arms.
  assignment.savedSubmissionTs = null;
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.PROMPT_CANVAS), false);
});

test("clearFramingViewAssets clears Framing View paths including sourceOverlayPath", () => {
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
      sourceOverlayPath: "drawings/hero_source.webp",
      oplogPath: "drawings/hero-oplog.json"
    }
  });

  assert.equal(hasSavedFramingViewAssets(assignment), true);
  assert.equal(isSaveGateOpen(assignment), true);

  clearFramingViewAssets(assignment);

  assert.equal(assignment.primaryImagePath, null);
  assert.equal(assignment.assets.fullPath, null);
  assert.equal(assignment.assets.sourceOverlayPath, null);
  assert.equal(assignment.assets.oplogPath, "drawings/hero-oplog.json");
  assert.equal(assignment.savedSubmissionTs, null);
  assert.equal(isSaveGateOpen(assignment), false);
  assert.equal(hasSavedFramingViewAssets(assignment), false);
});

test("pickSubmissionOverlaySrc never prefers merged over overlay for Source Framing preview", () => {
  assert.equal(pickSubmissionOverlaySrc({
    mode: "inline",
    overlay: { dataUrl: "data:image/webp;base64,overlay" },
    merged: { dataUrl: "data:image/webp;base64,merged" }
  }), "data:image/webp;base64,overlay");

  assert.equal(pickSubmissionOverlaySrc({
    mode: "staged",
    staged: {
      overlayPath: "worlds/demo/staging/a1-overlay.webp",
      mergedPath: "worlds/demo/staging/a1-merged.webp"
    }
  }), "worlds/demo/staging/a1-overlay.webp");

  assert.equal(pickSubmissionOverlaySrc({
    mode: "staged",
    staged: { overlayPath: null, mergedPath: "worlds/demo/staging/a1-merged.webp" }
  }), null);

  assert.equal(pickSubmissionOverlaySrc(null), null);
});

test("pickSubmissionPromptCanvasSrc prefers merged for Prompt-canvas preview", () => {
  assert.equal(pickSubmissionPromptCanvasSrc({
    mode: "inline",
    overlay: { dataUrl: "data:image/webp;base64,overlay" },
    merged: { dataUrl: "data:image/webp;base64,merged" }
  }), "data:image/webp;base64,merged");

  assert.equal(pickSubmissionPromptCanvasSrc({
    mode: "staged",
    staged: {
      overlayPath: "worlds/demo/staging/a1-overlay.webp",
      mergedPath: "worlds/demo/staging/a1-merged.webp"
    }
  }), "worlds/demo/staging/a1-merged.webp");
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
