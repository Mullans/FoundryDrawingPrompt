import assert from "node:assert/strict";
import { test } from "node:test";

import { INTERNAL } from "../scripts/constants.mjs";
import { estimateSubmissionWireSize, nextWireSizeStep } from "../scripts/drawing/export-service.mjs";
import { estimateSnapshotPayloadWireBytes, isValidSnapshotPayload } from "../scripts/prompts/wire-validation.mjs";

test("nextWireSizeStep returns done for payloads under the cap", () => {
  assert.deepEqual(nextWireSizeStep({
    format: "webp",
    size: INTERNAL.MAX_SUBMISSION_BYTES - 1,
    maxBytes: INTERNAL.MAX_SUBMISSION_BYTES,
    qualityIndex: 0,
    scale: 1,
    width: 1024,
    height: 768
  }), { action: "done" });
});

test("nextWireSizeStep walks WebP quality steps before oversized", () => {
  let state = { format: "webp", size: 99, maxBytes: 10, qualityIndex: 0, scale: 1, width: 2048, height: 1024 };
  for ( const [index, quality] of INTERNAL.WIRE_QUALITY_STEPS.entries() ) {
    const step = nextWireSizeStep(state);
    assert.deepEqual(step, { action: "quality", quality, qualityIndex: index + 1 });
    state = { ...state, qualityIndex: step.qualityIndex };
  }

  assert.deepEqual(nextWireSizeStep(state), { action: "oversized" });
});

test("nextWireSizeStep downscales PNG payloads until the minimum edge", () => {
  const first = nextWireSizeStep({
    format: "png",
    size: 99,
    maxBytes: 10,
    qualityIndex: 0,
    scale: 1,
    width: 2048,
    height: 1024
  });
  assert.equal(first.action, "downscale");
  assert.equal(first.scale, INTERNAL.WIRE_DOWNSCALE_STEP);
  assert.equal(first.width, 1536);
  assert.equal(first.height, 768);

  const second = nextWireSizeStep({
    format: "png",
    size: 99,
    maxBytes: 10,
    qualityIndex: 0,
    scale: INTERNAL.WIRE_DOWNSCALE_STEP,
    width: 2048,
    height: 1024
  });
  assert.equal(second.action, "downscale");
  assert.equal(second.scale, 0.5625);
  assert.equal(second.width, 1152);
  assert.equal(second.height, 576);

  const clamped = nextWireSizeStep({
    format: "png",
    size: 99,
    maxBytes: 10,
    qualityIndex: 0,
    scale: second.scale,
    width: 2048,
    height: 1024
  });
  assert.equal(clamped.action, "downscale");
  assert.equal(clamped.scale, 0.5);
  assert.equal(clamped.width, 1024);
  assert.equal(clamped.height, 512);

  assert.deepEqual(nextWireSizeStep({
    format: "png",
    size: 99,
    maxBytes: 10,
    qualityIndex: 0,
    scale: 0.5,
    width: 2048,
    height: 1024
  }), { action: "oversized" });
});

test("a combined live snapshot may use the wire budget exactly once", () => {
  const prefix = "data:image/webp;base64,";
  const build = totalLength => `${prefix}${"a".repeat(totalLength - prefix.length)}`;
  const composite = build(Math.floor(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES / 2));
  const overlay = build(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES - composite.length);

  assert.equal(estimateSnapshotPayloadWireBytes({ composite, overlay }), INTERNAL.MAX_SNAPSHOT_WIRE_BYTES);
  assert.equal(isValidSnapshotPayload({ composite, overlay }), true);
  assert.equal(isValidSnapshotPayload({ composite, overlay: `${overlay}a` }), false);
});

test("estimateSubmissionWireSize includes op-log JSON length", () => {
  const payload = {
    overlay: { dataUrl: "data:image/webp;base64,abc" },
    merged: { dataUrl: "data:image/webp;base64,def" },
    opLog: { operations: [{ type: "stroke", points: [1, 2, 3] }] }
  };
  const withoutOpLog = String(payload.overlay.dataUrl).length + String(payload.merged.dataUrl).length;
  assert.equal(estimateSubmissionWireSize(payload) > withoutOpLog, true);
});
