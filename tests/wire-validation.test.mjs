import assert from "node:assert/strict";
import { test } from "node:test";

import { INTERNAL } from "../scripts/constants.mjs";
import { buildPendingDir, buildStagingDir } from "../scripts/prompts/asset-service.mjs";
import {
  estimateOpLogWireBytes,
  estimateSnapshotPayloadWireBytes,
  isAllowedPendingPath,
  isAllowedStagedPath,
  isValidImageDataUrl,
  isValidSnapshotDataUrl,
  isValidSnapshotPayload,
  normalizeSnapshotPayload
} from "../scripts/prompts/wire-validation.mjs";

const SNAPSHOT_PREFIX = "data:image/webp;base64,";

/**
 * Build a snapshot data URL of an exact total length.
 * @param {number} totalLength Desired data URL length.
 * @returns {string}
 */
function snapshotUrlOfLength(totalLength) {
  return `${SNAPSHOT_PREFIX}${"a".repeat(Math.max(1, totalLength - SNAPSHOT_PREFIX.length))}`;
}

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

test("isValidSnapshotPayload accepts composite/overlay objects and legacy strings", () => {
  const small = `data:image/webp;base64,${"a".repeat(100)}`;
  assert.equal(isValidSnapshotPayload(small), true);
  assert.equal(isValidSnapshotPayload({ composite: small, overlay: small }), true);
  assert.equal(isValidSnapshotPayload({ overlay: small }), true);
  assert.equal(isValidSnapshotPayload({ composite: small }), true);
  assert.equal(isValidSnapshotPayload({}), false);
  assert.equal(isValidSnapshotPayload({ composite: "not-image" }), false);
  assert.equal(isValidSnapshotPayload(null), false);
});

test("isValidSnapshotPayload budgets composite and overlay against one wire cap", () => {
  const half = snapshotUrlOfLength(Math.floor(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES / 2));
  const threeQuarters = snapshotUrlOfLength(Math.floor(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES * 0.75));

  assert.equal(isValidSnapshotPayload({ composite: threeQuarters }), true);
  assert.equal(isValidSnapshotPayload({ overlay: threeQuarters }), true);
  assert.equal(isValidSnapshotPayload({ composite: half, overlay: half }), true);
  assert.equal(isValidSnapshotPayload({ composite: threeQuarters, overlay: half }), false);
  assert.equal(isValidSnapshotPayload({ composite: threeQuarters, overlay: threeQuarters }), false);
});

test("estimateSnapshotPayloadWireBytes sums composite and overlay bytes", () => {
  const composite = "data:image/webp;base64,composite";
  const overlay = "data:image/webp;base64,overlay";
  assert.equal(estimateSnapshotPayloadWireBytes(composite), composite.length);
  assert.equal(estimateSnapshotPayloadWireBytes({ composite }), composite.length);
  assert.equal(estimateSnapshotPayloadWireBytes({ composite, overlay }), composite.length + overlay.length);
  assert.equal(estimateSnapshotPayloadWireBytes(null), 0);
});

test("normalizeSnapshotPayload separates composite and overlay", () => {
  const composite = "data:image/webp;base64,composite";
  const overlay = "data:image/webp;base64,overlay";
  assert.deepEqual(normalizeSnapshotPayload(composite), { composite, overlay: null });
  assert.deepEqual(normalizeSnapshotPayload({ composite, overlay }), { composite, overlay });
  assert.deepEqual(normalizeSnapshotPayload({ overlay }), { composite: null, overlay });
  assert.deepEqual(normalizeSnapshotPayload(null), { composite: null, overlay: null });
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

test("Forge staged paths accept an HTTPS asset URL with one arbitrary account prefix", () => {
  const root = "drawing-prompts/test-world/staging";
  assert.equal(isAllowedStagedPath("a1", "https://assets.forge-vtt.com/account-9f8/drawing-prompts/test-world/staging/a1-overlay.webp", root, { forge: true }), true);
  assert.equal(isAllowedStagedPath("a1", "https://assets.forge-vtt.com/another-account/drawing-prompts/test-world/staging/a1-merged.png", root, { forge: true }), true);
});

test("Forge pending paths accept only the assignment-scoped provider structure", () => {
  const root = "drawing-prompts/test-world/pending/a1";
  assert.equal(isAllowedPendingPath("a1", "https://assets.forge-vtt.com/account/drawing-prompts/test-world/pending/a1/overlay.webp", root, { forge: true }), true);
  assert.equal(isAllowedPendingPath("a1", "https://assets.forge-vtt.com/account/drawing-prompts/test-world/pending/a1/merged.png", root, { forge: true }), true);
});

test("Forge allowlists reject wrong URL authority, assignment, structure, and traversal", () => {
  const stagingRoot = "drawing-prompts/test-world/staging";
  const rejected = [
    "http://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://evil.example/account/drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a2-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/nested/a1-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.jpg",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/../a1-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/%2e%2e/a1-overlay.webp"
  ];
  for ( const path of rejected ) assert.equal(isAllowedStagedPath("a1", path, stagingRoot, { forge: true }), false, path);
});

test("Forge allowlists reject URL credentials, query, fragment, and empty pathname segments", () => {
  const root = "drawing-prompts/test-world/staging";
  const invalid = [
    "https://user@assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://user:secret@assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp?download=1",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp#preview",
    "https://assets.forge-vtt.com/account//drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://assets.forge-vtt.com//account/drawing-prompts/test-world/staging/a1-overlay.webp",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp/"
  ];
  for ( const path of invalid ) assert.equal(isAllowedStagedPath("a1", path, root, { forge: true }), false, path);

  assert.equal(isAllowedStagedPath(
    "a1",
    "https://assets.forge-vtt.com/account/drawing-prompts/test-world/staging/a1-overlay.webp",
    root,
    { forge: true }
  ), true);
});

test("local allowlists retain exact root-relative path behavior when Forge is false", () => {
  const root = "worlds/test-world/drawing-prompts/staging";
  assert.equal(isAllowedStagedPath("a1", `${root}/a1-overlay.webp`, root, { forge: false }), true);
  assert.equal(isAllowedStagedPath("a1", `https://assets.forge-vtt.com/account/${root}/a1-overlay.webp`, root, { forge: false }), false);
});
