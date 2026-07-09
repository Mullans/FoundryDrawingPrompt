import assert from "node:assert/strict";
import { test } from "node:test";

import { INTERNAL } from "../scripts/constants.mjs";
import { resolveCanvasSize } from "../scripts/foundry/background-source-service.mjs";

test("resolveCanvasSize uses requested dimensions when valid", () => {
  assert.deepEqual(resolveCanvasSize(800, 600, 2000, 1000), { width: 800, height: 600 });
});

test("resolveCanvasSize derives blank dimensions from background size and clamps aspect ratio", () => {
  assert.deepEqual(resolveCanvasSize("", null, 8192, 4096), {
    width: INTERNAL.MAX_CANVAS_DIM,
    height: INTERNAL.MAX_CANVAS_DIM / 2
  });
});

test("resolveCanvasSize falls back to settings defaults when no background is present", () => {
  globalThis.game = {
    settings: {
      get: (_moduleId, key) => key === "defaultCanvasWidth" ? 1200 : 900
    }
  };

  assert.deepEqual(resolveCanvasSize(0, 0, null, null), { width: 1200, height: 900 });
});
