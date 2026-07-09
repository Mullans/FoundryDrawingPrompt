import assert from "node:assert/strict";
import { test } from "node:test";

import { createLeadingTrailingThrottle } from "../scripts/utils/throttle.mjs";
import { buildTileData, clampedTilePosition } from "../scripts/foundry/tile-placement-service.mjs";
import {
  defaultAssignmentAssetName,
  slugifyDrawingName,
  uniqueDrawingAssetFilenames
} from "../scripts/prompts/naming-service.mjs";

test("clampedTilePosition centers a tile and clamps it inside scene bounds", () => {
  assert.deepEqual(
    clampedTilePosition({ x: 500, y: 400 }, { width: 200, height: 100 }, { width: 1000, height: 800 }),
    { x: 400, y: 350 }
  );
  assert.deepEqual(
    clampedTilePosition({ x: 20, y: 30 }, { width: 200, height: 100 }, { width: 1000, height: 800 }),
    { x: 0, y: 0 }
  );
  assert.deepEqual(
    clampedTilePosition({ x: 980, y: 790 }, { width: 200, height: 100 }, { width: 1000, height: 800 }),
    { x: 800, y: 700 }
  );
});

test("buildTileData produces v14 TileDocument creation data", () => {
  assert.deepEqual(buildTileData({
    src: "worlds/test/drawing-prompts/p1/a1-merged.webp",
    name: "Sigil - Ada",
    width: 321.6,
    height: 240.2,
    center: { x: 50, y: 60 },
    scene: { width: 1000, height: 800 },
    hidden: true
  }), {
    texture: { src: "worlds/test/drawing-prompts/p1/a1-merged.webp" },
    name: "Sigil - Ada",
    width: 322,
    height: 240,
    x: 0,
    y: 0,
    hidden: true
  });
});

test("createLeadingTrailingThrottle fires first call immediately and trails the last burst value", () => {
  const calls = [];
  let now = 0;
  let scheduled = null;
  const throttle = createLeadingTrailingThrottle(value => calls.push([now, value]), {
    intervalMs: 100,
    now: () => now,
    setTimeout: (callback, delay) => {
      scheduled = { callback, delay };
      return 1;
    },
    clearTimeout: () => {
      scheduled = null;
    }
  });

  throttle("first");
  assert.deepEqual(calls, [[0, "first"]]);

  now = 30;
  throttle("second");
  now = 60;
  throttle("third");
  assert.equal(scheduled.delay, 70);

  now = 100;
  scheduled.callback();
  assert.deepEqual(calls, [[0, "first"], [100, "third"]]);
});

test("slugifyDrawingName lowercases names and falls back when unsafe text is empty", () => {
  assert.equal(slugifyDrawingName("Camp Layout! 01"), "camp-layout-01");
  assert.equal(slugifyDrawingName(" .. / \\ "), "drawing");
  assert.equal(slugifyDrawingName(" .. / \\ ", { fallback: "saved drawing" }), "saved-drawing");
});

test("uniqueDrawingAssetFilenames chooses a collision-free base for primary, overlay, and op log", () => {
  assert.deepEqual(uniqueDrawingAssetFilenames({
    name: "Camp Layout",
    extension: "webp",
    hasMerged: true,
    existingFiles: [
      "worlds/demo/drawing-prompts/camp-layout.webp",
      "worlds/demo/drawing-prompts/camp-layout-overlay.webp",
      "worlds/demo/drawing-prompts/camp-layout-oplog.json",
      "worlds/demo/drawing-prompts/camp-layout-2.webp"
    ]
  }), {
    slug: "camp-layout-3",
    primary: "camp-layout-3.webp",
    overlay: "camp-layout-3-overlay.webp",
    opLog: "camp-layout-3-oplog.json"
  });

  assert.deepEqual(uniqueDrawingAssetFilenames({
    name: "Camp Layout",
    extension: "webp",
    hasMerged: false,
    existingFiles: []
  }), {
    slug: "camp-layout",
    primary: "camp-layout.webp",
    overlay: null,
    opLog: "camp-layout-oplog.json"
  });
});

test("defaultAssignmentAssetName prefers drawing name and truncates prompt text fallback", () => {
  assert.equal(defaultAssignmentAssetName({
    drawingName: "Mystery Sigil",
    promptText: "Draw the symbol on the old door",
    userName: "Ada"
  }), "Mystery Sigil - Ada".replace(" - ", " – "));

  assert.equal(defaultAssignmentAssetName({
    drawingName: "",
    promptText: "A very long prompt text that should be shortened before it becomes part of the drawing name",
    userName: "Bert"
  }), "A very long prompt text that should be shortened before it... - Bert".replace(" - ", " – "));
});
