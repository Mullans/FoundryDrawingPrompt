import assert from "node:assert/strict";
import { test } from "node:test";

import { FIT_MODE } from "../scripts/constants.mjs";
import {
  FRAMING_ZOOM_STEP,
  framingAfterFitModeSelect,
  panFraming,
  resetFraming,
  resolveDraftFraming,
  zoomFraming
} from "../scripts/drawing/draft-framing-editor.mjs";

test("resolveDraftFraming defaults to full source when framing is absent", () => {
  assert.deepEqual(resolveDraftFraming({
    path: "images/test.webp",
    naturalWidth: 800,
    naturalHeight: 600
  }), { x: 0, y: 0, width: 800, height: 600 });
});

test("resolveDraftFraming returns null without a source image", () => {
  assert.equal(resolveDraftFraming({ path: null, naturalWidth: 800, naturalHeight: 600 }), null);
});

test("panFraming shifts origin opposite viewport drag", () => {
  const framing = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(
    panFraming(framing, { dxDisplay: 10, dyDisplay: 5, viewportWidth: 100, viewportHeight: 50 }),
    { x: 0, y: 15, width: 100, height: 50 }
  );
});

test("zoomFraming keeps the focus source point fixed", () => {
  const framing = { x: 0, y: 0, width: 100, height: 100 };
  const zoomed = zoomFraming(framing, {
    factor: 2,
    focusX: 50,
    focusY: 50,
    viewportWidth: 100,
    viewportHeight: 100
  });
  assert.deepEqual(zoomed, { x: 25, y: 25, width: 50, height: 50 });
});

test("zoomFraming can expand beyond the source for pad-out", () => {
  const framing = { x: 0, y: 0, width: 100, height: 100 };
  const zoomed = zoomFraming(framing, {
    factor: 0.5,
    focusX: 50,
    focusY: 50,
    viewportWidth: 100,
    viewportHeight: 100
  });
  assert.deepEqual(zoomed, { x: -50, y: -50, width: 200, height: 200 });
});

test("resetFraming restores the full source rect", () => {
  assert.deepEqual(resetFraming(640, 480), { x: 0, y: 0, width: 640, height: 480 });
});

test("framingAfterFitModeSelect resets to full source when leaving Placed", () => {
  const background = {
    path: "images/test.webp",
    naturalWidth: 800,
    naturalHeight: 600,
    framing: { x: 100, y: 50, width: 200, height: 200 }
  };
  assert.deepEqual(
    framingAfterFitModeSelect(background, FIT_MODE.PLACED, FIT_MODE.FIT_WIDTH),
    { x: 0, y: 0, width: 800, height: 600 }
  );
});

test("framingAfterFitModeSelect keeps framing when mode unchanged or Placed", () => {
  const background = {
    path: "images/test.webp",
    naturalWidth: 800,
    naturalHeight: 600,
    framing: { x: 10, y: 20, width: 100, height: 100 }
  };
  assert.equal(framingAfterFitModeSelect(background, FIT_MODE.FIT_WIDTH, FIT_MODE.FIT_WIDTH), null);
  assert.equal(framingAfterFitModeSelect(background, FIT_MODE.FIT_WIDTH, FIT_MODE.PLACED), null);
});

test("FRAMING_ZOOM_STEP matches player navigation zoom step", () => {
  assert.equal(FRAMING_ZOOM_STEP, 1.25);
});
