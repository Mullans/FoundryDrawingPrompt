import assert from "node:assert/strict";
import { test } from "node:test";

import { createLeadingTrailingThrottle } from "../scripts/utils/throttle.mjs";
import { buildTileData, clampedTilePosition } from "../scripts/foundry/tile-placement-service.mjs";
import {
  defaultAssignmentAssetName,
  promptAssetFolderName,
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
  assert.equal(slugifyDrawingName(" Crème brûlée / ../ <script>💥 "), "creme-brulee-script");
  assert.equal(slugifyDrawingName(" .. / \\ "), "drawing");
  assert.equal(slugifyDrawingName(" .. / \\ ", { fallback: "saved drawing" }), "saved-drawing");
});

test("promptAssetFolderName combines the UTC date, capped prompt slug, and stable id fragment", () => {
  assert.equal(promptAssetFolderName({
    promptId: "prompt-ABCD",
    promptText: "Draw the ancient moon gate!",
    sentAt: Date.UTC(2026, 6, 19, 23, 59)
  }), "2026-07-19-draw-the-ancient-moon-gate-gb5y");

  const fortyCharacters = "a".repeat(40);
  assert.equal(fortyCharacters.length, 40);
  assert.equal(promptAssetFolderName({
    promptId: "1234",
    promptText: `${fortyCharacters}-characters-beyond-the-cap`,
    sentAt: Date.UTC(2026, 0, 2)
  }), `2026-01-02-${fortyCharacters}-ss1p`);
});

test("promptAssetFolderName accepts Date-compatible values and falls back past invalid timestamps", () => {
  assert.equal(promptAssetFolderName({
    promptId: "safe",
    promptText: "Created date",
    sentAt: "not-a-date",
    createdAt: "2025-11-08T12:30:00Z",
    now: () => Date.UTC(2030, 0, 1)
  }), "2025-11-08-created-date-lufs");
  assert.equal(promptAssetFolderName({
    promptId: "safe",
    promptText: "",
    sentAt: 9e15,
    createdAt: new Date("invalid"),
    now: () => new Date("2024-02-29T20:00:00Z")
  }), "2024-02-29-prompt-lufs");
});

test("promptAssetFolderName uses a fixed epoch when explicitly injected now is invalid", () => {
  assert.equal(promptAssetFolderName({
    promptId: "safe",
    promptText: "Deterministic",
    sentAt: "invalid",
    createdAt: 9e15,
    now: () => "still-invalid"
  }), "1970-01-01-deterministic-lufs");
});

test("promptAssetFolderName derives deterministic four-character fragments for short or unsafe ids", () => {
  const shortId = promptAssetFolderName({ promptId: "x", sentAt: 0 });
  const repeated = promptAssetFolderName({ promptId: "x", sentAt: 0 });
  const unsafeId = promptAssetFolderName({ promptId: "../💥", sentAt: 0 });

  assert.match(shortId, /^1970-01-01-prompt-[a-z0-9]{4}$/);
  assert.equal(shortId, repeated);
  assert.match(unsafeId, /^1970-01-01-prompt-[a-z0-9]{4}$/);
  assert.notEqual(shortId, unsafeId);
});

test("promptAssetFolderName hashes the full prompt id rather than reusing a common suffix", () => {
  const first = promptAssetFolderName({ promptId: "same-prefix-ABCD", sentAt: 0 });
  const second = promptAssetFolderName({ promptId: "different-prefix-ABCD", sentAt: 0 });

  assert.equal(first, "1970-01-01-prompt-fstt");
  assert.equal(second, "1970-01-01-prompt-qd4o");
});

test("uniqueDrawingAssetFilenames chooses a collision-free base for primary, overlay, and op log", () => {
  assert.deepEqual(uniqueDrawingAssetFilenames({
    name: "Camp Layout",
    playerName: "Ada Lovelace",
    extension: "webp",
    hasMerged: true,
    existingFiles: [
      "worlds/demo/drawing-prompts/camp-layout-ada-lovelace.webp",
      "worlds/demo/drawing-prompts/camp-layout-ada-lovelace-overlay.webp",
      "worlds/demo/drawing-prompts/camp-layout-ada-lovelace-oplog.json",
      "worlds/demo/drawing-prompts/camp-layout-ada-lovelace-2.webp"
    ]
  }), {
    slug: "camp-layout-ada-lovelace-3",
    primary: "camp-layout-ada-lovelace-3.webp",
    overlay: "camp-layout-ada-lovelace-3-overlay.webp",
    sourceFull: null,
    opLog: "camp-layout-ada-lovelace-3-oplog.json"
  });

  assert.deepEqual(uniqueDrawingAssetFilenames({
    name: "Camp Layout",
    playerName: "",
    extension: "webp",
    hasMerged: false,
    existingFiles: []
  }), {
    slug: "camp-layout-player",
    primary: "camp-layout-player.webp",
    overlay: null,
    sourceFull: null,
    opLog: "camp-layout-player-oplog.json"
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
    sourceFull: null,
    opLog: "camp-layout-oplog.json"
  });
});

test("uniqueDrawingAssetFilenames bounds long components while preserving collision counters", () => {
  const options = {
    name: `Drawing ${"ancient ".repeat(80)}`,
    playerName: `Player ${"traveler ".repeat(80)}`,
    extension: "webp",
    hasMerged: true
  };
  const first = uniqueDrawingAssetFilenames(options);
  const occupied = [first.primary, first.overlay, first.opLog];
  const second = uniqueDrawingAssetFilenames({ ...options, existingFiles: occupied });

  for ( const filename of [...occupied, second.primary, second.overlay, second.opLog] ) {
    assert.ok(filename.length <= 200, `${filename.length}: ${filename}`);
  }
  assert.match(second.slug, /-2$/);
  assert.ok(!occupied.includes(second.primary));
  assert.ok(!occupied.includes(second.overlay));
  assert.ok(!occupied.includes(second.opLog));
});

test("defaultAssignmentAssetName prefers drawing name and truncates prompt text fallback", () => {
  assert.equal(defaultAssignmentAssetName({
    drawingName: "Mystery Sigil",
    promptText: "Draw the symbol on the old door",
    userName: "Ada"
  }), "Mystery Sigil");

  assert.equal(defaultAssignmentAssetName({
    drawingName: "",
    promptText: "A very long prompt text that should be shortened before it becomes part of the drawing name",
    userName: "Bert"
  }), "A very long prompt text that should be shortened before it...");

  assert.equal(defaultAssignmentAssetName({ drawingName: "", promptText: "", userName: "Ada" }), "Drawing");
});
