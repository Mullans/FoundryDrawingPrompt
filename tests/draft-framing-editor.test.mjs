import assert from "node:assert/strict";
import { test } from "node:test";

import { FIT_MODE } from "../scripts/constants.mjs";
import {
  FRAMING_ZOOM_STEP,
  framingAfterFitModeSelect,
  framingForPlacedStart,
  lockFramingToCanvasAspect,
  panFraming,
  resetFraming,
  resolveDraftFraming,
  resolveFramingEditorDrawRect,
  zoomFraming
} from "../scripts/drawing/draft-framing-editor.mjs";
import { computeFramingGeometry } from "../scripts/drawing/prompt-framing.mjs";

/**
 * @param {object} options Geometry inputs and viewport.
 * @returns {ReturnType<typeof resolveFramingEditorDrawRect>}
 */
function editorDrawRectFromModes(options) {
  const {
    sourceWidth,
    sourceHeight,
    framing = null,
    fitMode,
    canvasWidth,
    canvasHeight,
    viewportWidth,
    viewportHeight
  } = options;
  const geometry = computeFramingGeometry({
    sourceWidth,
    sourceHeight,
    framing,
    fitMode,
    canvasWidth,
    canvasHeight
  });
  return resolveFramingEditorDrawRect({ geometry, viewportWidth, viewportHeight });
}

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

test("lockFramingToCanvasAspect locks square ROI to tall canvas aspect, center stable", () => {
  const framing = { x: 10, y: 20, width: 100, height: 100 };
  const locked = lockFramingToCanvasAspect(framing, 50, 100);
  const aspect = locked.width / locked.height;
  assert.ok(Math.abs(aspect - 50 / 100) < 1e-9, `aspect ${aspect}`);
  const cx0 = framing.x + framing.width / 2;
  const cy0 = framing.y + framing.height / 2;
  const cx1 = locked.x + locked.width / 2;
  const cy1 = locked.y + locked.height / 2;
  assert.ok(Math.abs(cx1 - cx0) < 1e-6, `centerX ${cx1} vs ${cx0}`);
  assert.ok(Math.abs(cy1 - cy0) < 1e-6, `centerY ${cy1} vs ${cy0}`);
});

test("framingForPlacedStart square source on tall canvas contains source with canvas aspect", () => {
  const sw = 100;
  const sh = 100;
  const frame = framingForPlacedStart({
    sourceWidth: sw,
    sourceHeight: sh,
    framing: null,
    canvasWidth: 50,
    canvasHeight: 100
  });
  assert.ok(Math.abs(frame.width / frame.height - 50 / 100) < 1e-9);
  // Source origin rect must lie fully inside the ROI.
  assert.ok(frame.x <= 0);
  assert.ok(frame.y <= 0);
  assert.ok(frame.x + frame.width >= sw);
  assert.ok(frame.y + frame.height >= sh);
});

test("zoom and pan with canvas dims preserve locked aspect", () => {
  const canvasWidth = 50;
  const canvasHeight = 100;
  const start = lockFramingToCanvasAspect({ x: 0, y: 0, width: 100, height: 100 }, canvasWidth, canvasHeight);
  const zoomed = zoomFraming(start, {
    factor: 1.5,
    focusX: 40,
    focusY: 60,
    viewportWidth: 200,
    viewportHeight: 200,
    canvasWidth,
    canvasHeight
  });
  assert.ok(Math.abs(zoomed.width / zoomed.height - canvasWidth / canvasHeight) < 1e-9);
  const panned = panFraming(zoomed, {
    dxDisplay: 12,
    dyDisplay: -8,
    viewportWidth: 200,
    viewportHeight: 200,
    canvasWidth,
    canvasHeight
  });
  assert.ok(Math.abs(panned.width / panned.height - canvasWidth / canvasHeight) < 1e-9);
  assert.notEqual(panned.x, zoomed.x);
  assert.notEqual(panned.y, zoomed.y);
});

test("resolveFramingEditorDrawRect Center matches scaled bake placement (no plate stretch)", () => {
  // Small square source on tall canvas: Center keeps natural W×H centered — not full-plate stretch.
  const geometry = computeFramingGeometry({
    sourceWidth: 40,
    sourceHeight: 40,
    framing: { x: 0, y: 0, width: 40, height: 40 },
    fitMode: FIT_MODE.CENTER,
    canvasWidth: 50,
    canvasHeight: 100
  });
  const viewportWidth = 100;
  const viewportHeight = 200;
  const rect = resolveFramingEditorDrawRect({ geometry, viewportWidth, viewportHeight });
  assert.equal(geometry.framedPlacement.dw, 40);
  assert.equal(geometry.framedPlacement.dh, 40);
  // Canvas 50×100 → viewport 100×200 is 2× uniform.
  assert.deepEqual(
    {
      sourceX: rect.sourceX,
      sourceY: rect.sourceY,
      sourceW: rect.sourceW,
      sourceH: rect.sourceH,
      destX: rect.destX,
      destY: rect.destY,
      destW: rect.destW,
      destH: rect.destH
    },
    {
      sourceX: 0,
      sourceY: 0,
      sourceW: 40,
      sourceH: 40,
      destX: geometry.framedPlacement.dx * 2,
      destY: geometry.framedPlacement.dy * 2,
      destW: geometry.framedPlacement.dw * 2,
      destH: geometry.framedPlacement.dh * 2
    }
  );
  // Must not stretch to full viewport.
  assert.notEqual(rect.destW, viewportWidth);
  assert.notEqual(rect.destH, viewportHeight);
  assert.equal(rect.destW, rect.destH);
});

test("resolveFramingEditorDrawRect Stretch and Placed fill the scaled plate", () => {
  for ( const fitMode of [FIT_MODE.STRETCH, FIT_MODE.PLACED] ) {
    const rect = editorDrawRectFromModes({
      sourceWidth: 100,
      sourceHeight: 80,
      framing: { x: 0, y: 0, width: 100, height: 80 },
      fitMode,
      canvasWidth: 50,
      canvasHeight: 100,
      viewportWidth: 100,
      viewportHeight: 200
    });
    assert.deepEqual(
      { destX: rect.destX, destY: rect.destY, destW: rect.destW, destH: rect.destH },
      { destX: 0, destY: 0, destW: 100, destH: 200 },
      `fitMode ${fitMode}`
    );
  }
});

test("resolveFramingEditorDrawRect FIT_CANVAS matches scaled contain placement", () => {
  const geometry = computeFramingGeometry({
    sourceWidth: 200,
    sourceHeight: 100,
    framing: { x: 0, y: 0, width: 200, height: 100 },
    fitMode: FIT_MODE.FIT_CANVAS,
    canvasWidth: 100,
    canvasHeight: 100
  });
  const rect = resolveFramingEditorDrawRect({
    geometry,
    viewportWidth: 200,
    viewportHeight: 200
  });
  assert.deepEqual(
    { destX: rect.destX, destY: rect.destY, destW: rect.destW, destH: rect.destH },
    {
      destX: geometry.framedPlacement.dx * 2,
      destY: geometry.framedPlacement.dy * 2,
      destW: geometry.framedPlacement.dw * 2,
      destH: geometry.framedPlacement.dh * 2
    }
  );
  // Landscape contained in square: half viewport height, full width.
  assert.equal(rect.destW, 200);
  assert.equal(rect.destH, 100);
});

test("resolveFramingEditorDrawRect zoomed framing + Center uses framing size as Fit input", () => {
  const framing = { x: 25, y: 25, width: 50, height: 50 };
  const geometry = computeFramingGeometry({
    sourceWidth: 100,
    sourceHeight: 100,
    framing,
    fitMode: FIT_MODE.CENTER,
    canvasWidth: 200,
    canvasHeight: 200
  });
  const rect = resolveFramingEditorDrawRect({
    geometry,
    viewportWidth: 100,
    viewportHeight: 100
  });
  assert.deepEqual(
    { sourceX: rect.sourceX, sourceY: rect.sourceY, sourceW: rect.sourceW, sourceH: rect.sourceH },
    { sourceX: 25, sourceY: 25, sourceW: 50, sourceH: 50 }
  );
  assert.equal(rect.destW, geometry.framedPlacement.dw * (100 / 200));
  assert.equal(rect.destH, geometry.framedPlacement.dh * (100 / 200));
  // Center at natural framing size (50×50) on 200×200 canvas → scale 0.5 plate.
  assert.equal(rect.destW, 25);
  assert.equal(rect.destH, 25);
});
