import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containFitScale,
  createPlateFitView,
  fitPlateInBox,
  layoutPlateFit,
  layoutPlateInStage
} from "../scripts/drawing/plate-layout.mjs";
import { createFitView } from "../scripts/drawing/player-navigation.mjs";

test("fitPlateInBox letterboxes a landscape plate in a square host", () => {
  assert.deepEqual(
    fitPlateInBox({
      contentWidth: 200,
      contentHeight: 100,
      containerWidth: 100,
      containerHeight: 100
    }),
    { width: 100, height: 50 }
  );
});

test("fitPlateInBox pillarboxes a portrait plate in a landscape host", () => {
  assert.deepEqual(
    fitPlateInBox({
      contentWidth: 100,
      contentHeight: 200,
      containerWidth: 200,
      containerHeight: 100
    }),
    { width: 50, height: 100 }
  );
});

test("fitPlateInBox preserves exact aspect when host matches content", () => {
  assert.deepEqual(
    fitPlateInBox({
      contentWidth: 1024,
      contentHeight: 768,
      containerWidth: 512,
      containerHeight: 384
    }),
    { width: 512, height: 384 }
  );
});

test("fitPlateInBox height-constrains a square plate in a wide short host", () => {
  assert.deepEqual(
    fitPlateInBox({
      contentWidth: 512,
      contentHeight: 512,
      containerWidth: 400,
      containerHeight: 200
    }),
    { width: 200, height: 200 }
  );
});

test("layoutPlateInStage applies contain sizing to the plate element", () => {
  const stage = {
    clientWidth: 400,
    clientHeight: 200
  };
  const plate = { style: {} };
  const size = layoutPlateInStage(plate, stage, { width: 512, height: 512 });
  assert.deepEqual(size, { width: 200, height: 200 });
  assert.equal(plate.style.width, "200px");
  assert.equal(plate.style.height, "200px");
});

test("fitPlateInBox falls back to 1 for invalid dimensions", () => {
  assert.deepEqual(
    fitPlateInBox({
      contentWidth: 0,
      contentHeight: -5,
      containerWidth: NaN,
      containerHeight: 0
    }),
    { width: 1, height: 1 }
  );
});

test("containFitScale is the shared letterbox/pillarbox invariant", () => {
  // Landscape in square → width-limited letterbox
  assert.equal(
    containFitScale({
      contentWidth: 200,
      contentHeight: 100,
      containerWidth: 100,
      containerHeight: 100
    }),
    0.5
  );
  // Portrait in landscape → height-limited pillarbox
  assert.equal(
    containFitScale({
      contentWidth: 100,
      contentHeight: 200,
      containerWidth: 200,
      containerHeight: 100
    }),
    0.5
  );
});

test("fitPlateInBox CSS size matches containFitScale (floored)", () => {
  const sizes = {
    contentWidth: 800,
    contentHeight: 400,
    containerWidth: 400,
    containerHeight: 400
  };
  const scale = containFitScale(sizes);
  const box = fitPlateInBox(sizes);
  assert.equal(box.width, Math.floor(800 * scale));
  assert.equal(box.height, Math.floor(400 * scale));
});

test("createPlateFitView letterboxes and centers free axes", () => {
  assert.deepEqual(
    createPlateFitView({
      contentWidth: 800,
      contentHeight: 400,
      containerWidth: 400,
      containerHeight: 400
    }),
    { scale: 0.5, panX: 0, panY: 100 }
  );
});

test("layoutPlateFit returns CSS size and open-fit view together", () => {
  const result = layoutPlateFit({
    contentWidth: 200,
    contentHeight: 100,
    containerWidth: 100,
    containerHeight: 100
  });
  assert.deepEqual(result.size, { width: 100, height: 50 });
  assert.deepEqual(result.view, { scale: 0.5, panX: 0, panY: 25 });
});

test("createFitView and createPlateFitView share contain scale for open fit", () => {
  const sizes = {
    contentWidth: 800,
    contentHeight: 400,
    viewportWidth: 400,
    viewportHeight: 400
  };
  const plateView = createPlateFitView({
    contentWidth: sizes.contentWidth,
    contentHeight: sizes.contentHeight,
    containerWidth: sizes.viewportWidth,
    containerHeight: sizes.viewportHeight
  });
  const navView = createFitView(sizes);
  assert.equal(navView.scale, plateView.scale);
  assert.equal(navView.panX, plateView.panX);
  assert.equal(navView.panY, plateView.panY);
  assert.equal(
    navView.scale,
    containFitScale({
      contentWidth: sizes.contentWidth,
      contentHeight: sizes.contentHeight,
      containerWidth: sizes.viewportWidth,
      containerHeight: sizes.viewportHeight
    })
  );
});
