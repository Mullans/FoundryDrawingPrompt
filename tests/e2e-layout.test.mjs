import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectComposeManagerLayoutFailures,
  collectReviewManagerLayoutFailures,
  doRectsOverlap,
  isRectContainedIn
} from "../tools/e2e-layout-geometry.mjs";

test("isRectContainedIn allows small tolerance and rejects overflow", () => {
  const outer = { x: 0, y: 0, width: 100, height: 50 };
  assert.equal(isRectContainedIn({ x: 10, y: 5, width: 40, height: 20 }, outer), true);
  assert.equal(isRectContainedIn({ x: -0.5, y: 0, width: 10, height: 10 }, outer, { tolerance: 1 }), true);
  assert.equal(isRectContainedIn({ x: 80, y: 0, width: 40, height: 10 }, outer), false);
});

test("doRectsOverlap detects the dimensions-spill failure mode", () => {
  const fields = { x: 20, y: 200, width: 500, height: 28 };
  const preview = { x: 420, y: 80, width: 400, height: 500 };
  assert.equal(doRectsOverlap(fields, preview), true);
  assert.equal(doRectsOverlap(
    { x: 20, y: 200, width: 200, height: 28 },
    preview
  ), false);
});

test("collectComposeManagerLayoutFailures flags overflow into preview", () => {
  const failures = collectComposeManagerLayoutFailures({
    managerMain: { x: 0, y: 0, width: 400, height: 600 },
    dimensionsFields: { x: 100, y: 200, width: 450, height: 30 },
    previewPanel: { x: 420, y: 0, width: 400, height: 600 },
    widthInput: { x: 160, y: 200, width: 200, height: 28 },
    heightInput: { x: 430, y: 200, width: 80, height: 28 }
  });
  assert.ok(failures.some(msg => msg.includes("dimensions .form-fields overflow")));
  assert.ok(failures.some(msg => msg.includes("overlaps .dp-preview-panel")));
  assert.ok(failures.some(msg => msg.includes("canvasHeight input overflows")));
});

test("collectComposeManagerLayoutFailures is empty for a coherent row", () => {
  const failures = collectComposeManagerLayoutFailures({
    managerMain: { x: 0, y: 0, width: 400, height: 600 },
    dimensionsFields: { x: 120, y: 200, width: 220, height: 28 },
    previewPanel: { x: 420, y: 0, width: 400, height: 600 },
    widthInput: { x: 170, y: 200, width: 50, height: 28 },
    heightInput: { x: 280, y: 200, width: 50, height: 28 }
  });
  assert.deepEqual(failures, []);
});

test("collectReviewManagerLayoutFailures flags player/preview overlap", () => {
  const failures = collectReviewManagerLayoutFailures({
    playersFieldset: { x: 0, y: 80, width: 450, height: 400 },
    previewPanel: { x: 400, y: 80, width: 400, height: 400 },
    summaryBar: { x: 0, y: 0, width: 800, height: 60 },
    timerBlock: { x: 500, y: 8, width: 280, height: 48 }
  });
  assert.ok(failures.some(msg => msg.includes("players column overlaps")));
});
