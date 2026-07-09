import assert from "node:assert/strict";
import { test } from "node:test";

import { FIT_MODE } from "../scripts/constants.mjs";
import { computeBackgroundLayout } from "../scripts/drawing/background-layout.mjs";

test("computeBackgroundLayout centers natural-size images without scaling", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 200, 100, FIT_MODE.CENTER), {
    dx: 300,
    dy: 250,
    dw: 200,
    dh: 100
  });
});

test("computeBackgroundLayout keeps oversized centered images at natural size", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 1200, 900, FIT_MODE.CENTER), {
    dx: -200,
    dy: -150,
    dw: 1200,
    dh: 900
  });
});

test("computeBackgroundLayout fits landscape images to canvas width", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 400, 200, FIT_MODE.FIT_WIDTH), {
    dx: 0,
    dy: 100,
    dw: 800,
    dh: 400
  });
});

test("computeBackgroundLayout fits portrait images to canvas height", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 200, 400, FIT_MODE.FIT_HEIGHT), {
    dx: 250,
    dy: 0,
    dw: 300,
    dh: 600
  });
});

test("computeBackgroundLayout stretches exactly to the canvas rectangle", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 200, 400, FIT_MODE.STRETCH), {
    dx: 0,
    dy: 0,
    dw: 800,
    dh: 600
  });
});

test("computeBackgroundLayout falls back to center behavior for unknown fit modes", () => {
  assert.deepEqual(computeBackgroundLayout(800, 600, 100, 50, "diagonal"), {
    dx: 350,
    dy: 275,
    dw: 100,
    dh: 50
  });
});
