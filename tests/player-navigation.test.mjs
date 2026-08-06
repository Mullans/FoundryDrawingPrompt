import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampView,
  classifyWheelGesture,
  createFitView,
  cssTransform,
  isPanModifierActive,
  mapViewportClientToLogical,
  panView,
  shouldDrawingToolTakePointer,
  zoomView
} from "../scripts/drawing/player-navigation.mjs";

const sizes = {
  contentWidth: 800,
  contentHeight: 600,
  viewportWidth: 400,
  viewportHeight: 300
};

test("createFitView fits content inside the viewport and centers it", () => {
  const view = createFitView(sizes);
  assert.equal(view.scale, 0.5);
  assert.equal(view.panX, 0);
  assert.equal(view.panY, 0);
});

test("createFitView letterboxes and centers when aspect ratios differ", () => {
  const view = createFitView({
    contentWidth: 800,
    contentHeight: 400,
    viewportWidth: 400,
    viewportHeight: 400
  });
  // scale limited by width: 400/800 = 0.5 → content height 200, centered with 100px each side
  assert.equal(view.scale, 0.5);
  assert.equal(view.panX, 0);
  assert.equal(view.panY, 100);
});

test("clampView prevents panning outside the Prompt canvas extent when zoomed in", () => {
  const zoomed = { scale: 1, panX: 50, panY: -999 };
  const clamped = clampView(zoomed, sizes);
  // content 800×600 covers 400×300 viewport: panX in [viewportW-contentW, 0] = [-400, 0]
  assert.equal(clamped.panX, 0);
  assert.equal(clamped.panY, -300);
});

test("clampView locks pan to center when content is letterboxed smaller than the viewport", () => {
  const letterbox = {
    contentWidth: 800,
    contentHeight: 400,
    viewportWidth: 400,
    viewportHeight: 400
  };
  // fit scale 0.5 → content 400×200; illegal pan is recentered on the free axis
  const view = clampView({ scale: 0.5, panX: 200, panY: 0 }, letterbox);
  assert.equal(view.panX, 0);
  assert.equal(view.panY, 100);
});

test("clampView cannot zoom out past the fit scale", () => {
  const view = clampView({ scale: 0.1, panX: 0, panY: 0 }, sizes);
  assert.equal(view.scale, 0.5);
});

test("zoomView zooms about a focus point and keeps it stable under the cursor", () => {
  const start = createFitView(sizes);
  // focus on top-left corner of content (viewport 0,0 at fit when pan 0,0)
  const next = zoomView(start, sizes, { factor: 2, focusX: 0, focusY: 0 });
  assert.equal(next.scale, 1);
  assert.equal(next.panX, 0);
  assert.equal(next.panY, 0);
  // content point (0,0) still maps under viewport point (0,0)
  const logical = mapViewportClientToLogical({
    clientX: 10,
    clientY: 20,
    viewportRect: { left: 10, top: 20, width: 400, height: 300 },
    view: next,
    contentWidth: 800,
    contentHeight: 600
  });
  assert.deepEqual(logical, { x: 0, y: 0 });
});

test("panView offsets the view then clamps", () => {
  const start = clampView({ scale: 1, panX: 0, panY: 0 }, sizes);
  const panned = panView(start, sizes, { dx: -50, dy: -25 });
  assert.equal(panned.panX, -50);
  assert.equal(panned.panY, -25);
});

test("cssTransform serializes pan/zoom for the content surface", () => {
  assert.equal(
    cssTransform({ scale: 1.5, panX: 12, panY: -4 }),
    "translate(12px, -4px) scale(1.5)"
  );
});

test("mapViewportClientToLogical converts screen coords using the ephemeral view only", () => {
  const view = { scale: 2, panX: 10, panY: 20 };
  const logical = mapViewportClientToLogical({
    clientX: 110,
    clientY: 120,
    viewportRect: { left: 0, top: 0, width: 400, height: 300 },
    view,
    contentWidth: 800,
    contentHeight: 600
  });
  // ((110 - 10) / 2, (120 - 20) / 2) = (50, 50)
  assert.deepEqual(logical, { x: 50, y: 50 });
});

test("isPanModifierActive is true for middle button or space-held primary", () => {
  assert.equal(isPanModifierActive({ button: 1, spaceHeld: false }), true);
  assert.equal(isPanModifierActive({ button: 0, spaceHeld: true }), true);
  assert.equal(isPanModifierActive({ button: 0, spaceHeld: false }), false);
  assert.equal(isPanModifierActive({ button: 2, spaceHeld: false }), false);
});

test("shouldDrawingToolTakePointer prioritizes drawing over navigation for plain primary", () => {
  assert.equal(shouldDrawingToolTakePointer({ button: 0, spaceHeld: false }), true);
  assert.equal(shouldDrawingToolTakePointer({ button: 0, spaceHeld: true }), false);
  assert.equal(shouldDrawingToolTakePointer({ button: 1, spaceHeld: false }), false);
});

test("classifyWheelGesture treats ctrl/meta wheel as pinch zoom", () => {
  const gesture = classifyWheelGesture({
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false
  });
  assert.equal(gesture.type, "zoom");
  assert.ok(gesture.factor < 1);
});

test("classifyWheelGesture zooms for pure vertical mouse wheel (pixel or line mode)", () => {
  for ( const deltaMode of [0, 1] ) {
    const gesture = classifyWheelGesture({
      deltaX: 0,
      deltaY: 100,
      deltaMode,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false
    });
    assert.equal(gesture.type, "zoom", `deltaMode ${deltaMode}`);
    assert.ok(gesture.factor < 1);
  }
});

test("classifyWheelGesture pans for trackpad two-finger scroll with horizontal delta", () => {
  const gesture = classifyWheelGesture({
    deltaX: 30,
    deltaY: -12,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false
  });
  assert.deepEqual(gesture, { type: "pan", dx: -30, dy: 12 });
});

test("classifyWheelGesture uses shift+wheel for horizontal pan when useful", () => {
  const gesture = classifyWheelGesture({
    deltaX: 0,
    deltaY: 40,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true
  });
  assert.deepEqual(gesture, { type: "pan", dx: -40, dy: 0 });
});
