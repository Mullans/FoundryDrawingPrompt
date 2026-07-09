import assert from "node:assert/strict";
import { test } from "node:test";

import { STATUS } from "../scripts/constants.mjs";
import { DrawingAssignment } from "../scripts/prompts/prompt-models.mjs";
import {
  evaluateOpened,
  evaluateRejection,
  evaluateSnapshot,
  evaluateSubmission
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
