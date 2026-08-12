import assert from "node:assert/strict";
import { test } from "node:test";

import { fitPlateInBox, layoutPlateInStage } from "../scripts/drawing/plate-layout.mjs";

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
