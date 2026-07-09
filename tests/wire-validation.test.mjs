import assert from "node:assert/strict";
import { test } from "node:test";

import { INTERNAL } from "../scripts/constants.mjs";
import { buildPendingDir, buildStagingDir } from "../scripts/prompts/asset-service.mjs";
import {
  estimateOpLogWireBytes,
  isAllowedPendingPath,
  isAllowedStagedPath,
  isValidImageDataUrl,
  isValidSnapshotDataUrl
} from "../scripts/prompts/wire-validation.mjs";

test("isValidImageDataUrl accepts webp and png data URLs", () => {
  assert.equal(isValidImageDataUrl("data:image/webp;base64,abc"), true);
  assert.equal(isValidImageDataUrl("data:image/png;base64,abc"), true);
  assert.equal(isValidImageDataUrl("javascript:alert(1)"), false);
  assert.equal(isValidImageDataUrl("data:text/plain;base64,YQ=="), false);
});

test("isValidSnapshotDataUrl enforces snapshot wire cap", () => {
  const small = `data:image/webp;base64,${"a".repeat(100)}`;
  assert.equal(isValidSnapshotDataUrl(small), true);
  const huge = `data:image/webp;base64,${"a".repeat(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES)}`;
  assert.equal(isValidSnapshotDataUrl(huge), false);
});

test("estimateOpLogWireBytes counts serialized op-log size", () => {
  assert.equal(estimateOpLogWireBytes({ operations: [{ type: "stroke" }] }) > 0, true);
  assert.equal(estimateOpLogWireBytes(undefined), 0);
});

test("isAllowedStagedPath rejects traversal and foreign assignment paths", () => {
  const stagingRoot = buildStagingDir("worlds/test/drawing-prompts");
  const assignmentId = "abc123";
  assert.equal(isAllowedStagedPath(assignmentId, `${stagingRoot}/${assignmentId}-overlay.webp`, stagingRoot), true);
  assert.equal(isAllowedStagedPath(assignmentId, `${stagingRoot}/../secret.webp`, stagingRoot), false);
  assert.equal(isAllowedStagedPath(assignmentId, "worlds/other/secret.webp", stagingRoot), false);
  assert.equal(isAllowedStagedPath(assignmentId, `${stagingRoot}/other-overlay.webp`, stagingRoot), false);
});

test("isAllowedPendingPath accepts only assignment pending overlay and merged files", () => {
  const pendingRoot = buildPendingDir("worlds/test/drawing-prompts", "a1");
  assert.equal(isAllowedPendingPath("a1", `${pendingRoot}/overlay.webp`, pendingRoot), true);
  assert.equal(isAllowedPendingPath("a1", `${pendingRoot}/merged.png`, pendingRoot), true);
  assert.equal(isAllowedPendingPath("a1", `${pendingRoot}/../other/overlay.webp`, pendingRoot), false);
  assert.equal(isAllowedPendingPath("a1", "worlds/test/drawing-prompts/staging/a1-overlay.webp", pendingRoot), false);
});
