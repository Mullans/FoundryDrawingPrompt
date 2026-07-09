import assert from "node:assert/strict";
import { test } from "node:test";

import { STATUS } from "../scripts/constants.mjs";
import { buildPendingDir, buildStagingDir } from "../scripts/prompts/asset-service.mjs";
import { DrawingAssignment } from "../scripts/prompts/prompt-models.mjs";
import {
  evaluateOpened,
  evaluateRejection,
  evaluateSnapshot,
  evaluateSubmission,
  isValidSubmissionPayload
} from "../scripts/prompts/transitions.mjs";

const STATUSES = Object.values(STATUS);

function assignmentWithStatus(status) {
  return DrawingAssignment.fromObject({
    id: `a-${status}`,
    promptId: "p1",
    userId: "u1",
    userName: "Ada",
    status
  });
}

test("evaluateOpened applies only while pending or opened", () => {
  const expected = {
    [STATUS.PENDING]: { apply: true },
    [STATUS.OPENED]: { apply: true },
    [STATUS.SUBMITTED]: { apply: false, reason: "inactive" },
    [STATUS.REJECTED]: { apply: false, reason: "inactive" },
    [STATUS.CANCELLED]: { apply: false, reason: "inactive" }
  };

  for ( const status of STATUSES ) {
    assert.deepEqual(evaluateOpened(assignmentWithStatus(status)), expected[status], status);
  }
});

test("evaluateSubmission applies only while active and treats duplicate submit distinctly", () => {
  const expected = {
    [STATUS.PENDING]: { apply: true },
    [STATUS.OPENED]: { apply: true },
    [STATUS.SUBMITTED]: { apply: false, reason: "duplicate" },
    [STATUS.REJECTED]: { apply: false, reason: "inactive" },
    [STATUS.CANCELLED]: { apply: false, reason: "inactive" }
  };

  for ( const status of STATUSES ) {
    assert.deepEqual(evaluateSubmission(assignmentWithStatus(status)), expected[status], status);
  }
});

test("evaluateRejection applies only while pending or opened", () => {
  const expected = {
    [STATUS.PENDING]: { apply: true },
    [STATUS.OPENED]: { apply: true },
    [STATUS.SUBMITTED]: { apply: false, reason: "inactive" },
    [STATUS.REJECTED]: { apply: false, reason: "inactive" },
    [STATUS.CANCELLED]: { apply: false, reason: "inactive" }
  };

  for ( const status of STATUSES ) {
    assert.deepEqual(evaluateRejection(assignmentWithStatus(status)), expected[status], status);
  }
});

test("evaluateSnapshot displays only while pending or opened", () => {
  const expected = {
    [STATUS.PENDING]: { apply: true },
    [STATUS.OPENED]: { apply: true },
    [STATUS.SUBMITTED]: { apply: false, reason: "inactive" },
    [STATUS.REJECTED]: { apply: false, reason: "inactive" },
    [STATUS.CANCELLED]: { apply: false, reason: "inactive" }
  };

  for ( const status of STATUSES ) {
    assert.deepEqual(evaluateSnapshot(assignmentWithStatus(status)), expected[status], status);
  }
});

test("buildStagingDir normalizes asset folders and appends staging", () => {
  assert.equal(buildStagingDir("worlds/test/drawing-prompts"), "worlds/test/drawing-prompts/staging");
  assert.equal(buildStagingDir("/worlds/test/drawing-prompts/"), "worlds/test/drawing-prompts/staging");
  assert.equal(buildStagingDir(""), "staging");
});

test("isValidSubmissionPayload accepts socket-lane submissions", () => {
  assert.equal(isValidSubmissionPayload({
    overlay: { dataUrl: "data:image/webp;base64,abc", format: "webp" },
    merged: { dataUrl: "data:image/webp;base64,def", format: "webp" },
    opLog: { operations: [] },
    width: 1024,
    height: 768
  }), true);
});

test("isValidSubmissionPayload accepts staged submissions", () => {
  assert.equal(isValidSubmissionPayload({
    mode: "staged",
    staged: { overlayPath: "worlds/test/drawing-prompts/staging/a1-overlay.webp", mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  }), true);
});

test("isValidSubmissionPayload rejects malformed staged submissions", () => {
  assert.equal(isValidSubmissionPayload({
    mode: "staged",
    staged: { mergedPath: null },
    opLog: {},
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  }), false);
});

test("isValidSubmissionPayload rejects unknown submission modes", () => {
  assert.equal(isValidSubmissionPayload({
    mode: "future",
    overlay: { dataUrl: "data:image/webp;base64,abc", format: "webp" },
    width: 1024,
    height: 768
  }), false);
});

test("isValidSubmissionPayload rejects invalid socket-lane image MIME", () => {
  assert.equal(isValidSubmissionPayload({
    overlay: { dataUrl: "data:text/plain;base64,YQ==", format: "webp" },
    width: 1024,
    height: 768
  }), false);
});

test("isValidSubmissionPayload rejects staged paths outside allowlist", () => {
  const assignmentId = "a1";
  const stagingRoot = buildStagingDir("worlds/test/drawing-prompts");
  const pendingRoot = buildPendingDir("worlds/test/drawing-prompts", assignmentId);
  assert.equal(isValidSubmissionPayload({
    mode: "staged",
    staged: { overlayPath: "worlds/other/secret.webp", mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  }, { assignmentId, stagingRoot, pendingRoot }), false);
  assert.equal(isValidSubmissionPayload({
    mode: "staged",
    staged: { overlayPath: `${stagingRoot}/${assignmentId}-overlay.webp`, mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  }, { assignmentId, stagingRoot, pendingRoot }), true);
});
