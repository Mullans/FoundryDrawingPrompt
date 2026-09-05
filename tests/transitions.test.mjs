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
  isSaveGateOpen,
  validateSubmissionPayload,
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

test("isSaveGateOpen requires the GM to have saved the assignment's current submission", () => {
  const noSubmission = assignmentWithStatus(STATUS.OPENED);
  assert.equal(isSaveGateOpen(noSubmission), false, "no submission -> closed");

  const pending = assignmentWithStatus(STATUS.PENDING);
  assert.equal(isSaveGateOpen(pending), false, "pending -> closed");

  const newSubmission = DrawingAssignment.fromObject({
    id: "a-new", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED, submittedAt: 100
  });
  assert.equal(isSaveGateOpen(newSubmission), false, "new submission, not yet saved -> closed");

  const saved = DrawingAssignment.fromObject({
    id: "a-saved", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED, submittedAt: 100, savedSubmissionTs: 100
  });
  assert.equal(isSaveGateOpen(saved), true, "saved current submission -> open");

  const resubmittedAfterSave = DrawingAssignment.fromObject({
    id: "a-resubmit", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED, submittedAt: 200, savedSubmissionTs: 100
  });
  assert.equal(isSaveGateOpen(resubmittedAfterSave), false, "resubmission after save re-arms the gate -> closed");

  const legacyWithoutField = DrawingAssignment.fromObject({
    id: "a-legacy", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED, submittedAt: 100
  });
  assert.equal(legacyWithoutField.savedSubmissionTs, null);
  assert.equal(isSaveGateOpen(legacyWithoutField), false, "legacy data without the field -> closed");

  const legacySavedDrawing = DrawingAssignment.fromObject({
    id: "a-legacy-saved",
    promptId: "p1",
    userId: "u1",
    status: STATUS.SUBMITTED,
    submittedAt: 100,
    assets: { overlayPath: "worlds/demo/drawing-prompts/legacy.webp" }
  });
  assert.equal(legacySavedDrawing.savedSubmissionTs, 100);
  assert.equal(isSaveGateOpen(legacySavedDrawing), true, "legacy saved drawing -> open");
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
  const assignmentId = "a1";
  const stagingRoot = buildStagingDir("worlds/test/drawing-prompts");
  const pendingRoot = buildPendingDir("worlds/test/drawing-prompts", assignmentId);
  assert.equal(isValidSubmissionPayload({
    mode: "staged",
    staged: { overlayPath: `${stagingRoot}/${assignmentId}-overlay.webp`, mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  }, { assignmentId, stagingRoot, pendingRoot, forge: false }), true);
});

test("validateSubmissionPayload fails closed when staged path allowlist context is missing", () => {
  // Staged paths are player-supplied and this is the only gate that checks them, so an
  // unresolvable allowlist must reject rather than accept the payload unvalidated (SCR-52).
  const payload = {
    mode: "staged",
    staged: { overlayPath: "https://evil.example/payload.webp", mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  };
  assert.equal(isValidSubmissionPayload(payload), false, "no options at all -> rejected");

  const noContext = validateSubmissionPayload(payload);
  assert.equal(noContext.ok, false);
  assert.equal(noContext.reason, "path-context");
  assert.match(noContext.detail, /assignmentId/);
  assert.match(noContext.detail, /stagingRoot or pendingRoot/);

  const noRoots = validateSubmissionPayload(payload, { assignmentId: "a1" });
  assert.equal(noRoots.ok, false);
  assert.equal(noRoots.reason, "path-context");
  assert.match(noRoots.detail, /stagingRoot or pendingRoot/);
  assert.doesNotMatch(noRoots.detail, /assignmentId/);

  const noAssignmentId = validateSubmissionPayload(payload, {
    stagingRoot: "worlds/test/drawing-prompts/staging",
    pendingRoot: "worlds/test/drawing-prompts/pending/a1"
  });
  assert.equal(noAssignmentId.ok, false);
  assert.equal(noAssignmentId.reason, "path-context");
  assert.match(noAssignmentId.detail, /assignmentId/);

  // A single root is still enough context to evaluate the allowlist.
  const stagingOnly = validateSubmissionPayload(payload, {
    assignmentId: "a1",
    stagingRoot: "worlds/test/drawing-prompts/staging"
  });
  assert.equal(stagingOnly.ok, false);
  assert.equal(stagingOnly.reason, "path-allowlist", "resolvable context still reports a real allowlist miss");
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

test("validateSubmissionPayload distinguishes malformed shape from a path allowlist failure", () => {
  const shape = validateSubmissionPayload({ mode: "staged" });
  assert.equal(shape.ok, false);
  assert.equal(shape.reason, "shape");

  const payload = {
    mode: "staged",
    staged: { overlayPath: "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/wrong-overlay.webp", mergedPath: null },
    opLog: { operations: [] },
    width: 1024,
    height: 768,
    formats: { overlay: "webp", merged: null }
  };
  const decision = validateSubmissionPayload(payload, {
    assignmentId: "a1",
    stagingRoot: "drawing-prompts/test-world/staging",
    pendingRoot: "drawing-prompts/test-world/pending/a1",
    forge: true
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "path-allowlist");
  assert.match(decision.detail, /wrong-overlay\.webp/);
  assert.match(decision.detail, /drawing-prompts\/test-world\/staging/);
});

test("validateSubmissionPayload rejects role-swapped local staged paths", () => {
  const decision = validateSubmissionPayload({
    mode: "staged",
    staged: {
      overlayPath: "worlds/test/drawing-prompts/staging/a1-merged.webp",
      mergedPath: "worlds/test/drawing-prompts/staging/a1-overlay.webp"
    },
    formats: { overlay: "webp", merged: "webp" },
    width: 1024,
    height: 768
  }, {
    assignmentId: "a1",
    stagingRoot: "worlds/test/drawing-prompts/staging",
    pendingRoot: "worlds/test/drawing-prompts/pending/a1",
    forge: false
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "path-allowlist");
  assert.match(decision.detail, /overlayPath/);
  assert.match(decision.detail, /a1-overlay\.\(webp\|png\)/);
});

test("validateSubmissionPayload rejects duplicate-role Forge pending paths", () => {
  const duplicateOverlay = "https://assets.forge-vtt.com/account/drawing-prompts/test-world/pending/a1/overlay.webp";
  const decision = validateSubmissionPayload({
    mode: "staged",
    staged: { overlayPath: duplicateOverlay, mergedPath: duplicateOverlay },
    formats: { overlay: "webp", merged: "webp" },
    width: 1024,
    height: 768
  }, {
    assignmentId: "a1",
    stagingRoot: "drawing-prompts/test-world/staging",
    pendingRoot: "drawing-prompts/test-world/pending/a1",
    forge: true
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "path-allowlist");
  assert.match(decision.detail, /mergedPath/);
  assert.match(decision.detail, /merged\.\(webp\|png\)/);
});
