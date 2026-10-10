import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import * as cleanup from "../scripts/prompts/file-cleanup-service.mjs";
import { rebuildAssignmentIndex } from "../scripts/prompts/persistence-service.mjs";
import { emit } from "../scripts/socket.mjs";

let value, prompt, files, writes, failWrites;
let clearPendingSubmission;
const uploadPath = "art/staging/assignment-overlay-upload-attempt.webp";
before(async () => {
  class ApplicationV2 {}
  globalThis.foundry = { utils: { randomID: () => "test-id" }, applications: {
    api: { ApplicationV2, DialogV2: class {}, HandlebarsApplicationMixin: Base => class extends Base {} },
    apps: { FilePicker: { browse: async (_source, target) => ({ target, files, dirs: [] }) } }
  } };
  ({ clearPendingSubmission } = await import("../scripts/prompts/pending-submission.mjs"));
});
beforeEach(() => {
  clearPendingSubmission("assignment");
  value = { version: 1, records: [], exports: [] };
  writes = 0; failWrites = false; files = [];
  prompt = { id: "prompt", gmUserId: "gm", promptName: "Creature", lifecycleStatus: "closed", assignments: {
    assignment: { id: "assignment", userId: "player", userName: "Ada", status: "submitted", assets: {} }
  } };
  const gm = { id: "gm", isGM: true, active: true };
  const players = new Map([["gm", gm], ["player", { id: "player", isGM: false, active: true }]]);
  players.activeGM = gm;
  const entry = { id: "prompt", getFlag: () => prompt };
  globalThis.game = {
    user: gm, users: players, world: { id: "test" }, scenes: [], actors: [],
    journal: { get: key => key === "prompt" && prompt ? entry : null, [Symbol.iterator]: function* () { if ( prompt ) yield entry; } },
    settings: { get: (_module, key) => key === "fileCleanupRegistry" ? structuredClone(value) : "art", set: async (_module, _key, next) => { if ( failWrites ) throw new Error("disk failure"); value = structuredClone(next); writes++; } },
    i18n: { localize: key => key }
  };
  globalThis.Hooks = { callAll() {} };
  globalThis.ForgeVTT = { usingTheForge: false };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  rebuildAssignmentIndex();
});
afterEach(async () => { await cleanup.waitForFileCleanupIdle(); });

async function upload() {
  const reservationId = await cleanup.beginInternalUpload({ assignmentId: "assignment", attemptId: "attempt", kind: "overlay", expectedPath: uploadPath });
  await cleanup.completeInternalUpload(reservationId, { path: uploadPath });
  files = [uploadPath];
  return reservationId;
}

test("successful upload stays protected until adoption settles it", async () => {
  await upload();
  await cleanup.reconcileFileCleanup();
  assert.equal(value.records[0].state, "ready");
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.reconcileFileCleanup();
  assert.equal(cleanup.getOrphanFiles()[0].status, "unsupported");
});
test("pending and retained capture references prevent cleanup after settlement", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  prompt.assignments.assignment.pendingSubmission = { staged: { overlayPath: uploadPath } };
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  prompt.assignments.assignment.pendingSubmission = null;
  prompt.assignments.assignment.retainedCapture = { overlayPath: uploadPath };
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles(), []);
});
test("exports remain protected after Prompt disappears", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.protectExportedFiles([uploadPath]);
  prompt = null;
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  assert.deepEqual(value.exports, [uploadPath]);
});
test("inactive Scene and Actor original texture references protect files", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  game.scenes = [{ toObject: () => ({ active: false, tiles: [{ texture: { src: uploadPath } }] }) }];
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  game.scenes = []; game.actors = [{ toObject: () => ({ flags: { "drawing-prompts": { originalTexture: uploadPath } } }) }];
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles(), []);
});
test("durable Save lease permits export registration without deadlock", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.withFileCleanupProtection([uploadPath], async () => {
    assert.equal(value.records[0].leases.length, 1);
    await cleanup.reconcileFileCleanup();
    assert.deepEqual(cleanup.getOrphanFiles(), []);
    await cleanup.protectExportedFiles([uploadPath]);
  });
  assert.equal(value.records[0].leases.length, 0);
});
test("registration failure creates no untracked upload permission", async () => {
  failWrites = true;
  await assert.rejects(upload(), /disk failure/);
  assert.deepEqual(value.records, []);
});
test("player cannot register another Assignment or complete another reservation", async () => {
  game.users.set("other", { id: "other", active: true });
  await assert.rejects(cleanup.handleCleanupOperation("other", { type: "begin", assignmentId: "assignment", attemptId: "attempt", kind: "overlay", expectedPath: uploadPath }), /Unauthorized/);
  const reservationId = await upload();
  await assert.rejects(cleanup.handleCleanupOperation("player", { type: "complete", reservationId, path: uploadPath }), /another user/);
});
test("delete receiver rejects arbitrary, stale, protected, and non-GM requests", async () => {
  const reservationId = await upload();
  await assert.rejects(cleanup.handleCleanupFileRequest("player", { recordId: reservationId, revision: 2, targetUserId: "gm", action: "delete" }));
  await assert.rejects(cleanup.handleCleanupFileRequest("gm", { recordId: "invented", revision: 2, targetUserId: "gm", action: "delete" }), /missing/);
  await assert.rejects(cleanup.handleCleanupFileRequest("gm", { recordId: reservationId, revision: 1, targetUserId: "gm", action: "delete" }), /stale/);
  await assert.rejects(cleanup.handleCleanupFileRequest("gm", { recordId: reservationId, revision: 2, targetUserId: "gm", action: "delete" }), /protected/);
});
test("startup merges attributable files into existing list on every scan", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  files = [uploadPath, "art/staging/assignment-merged.webp", "art/staging/unrelated-overlay.webp"];
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records.length, 2);
  const ids = value.records.map(record => record.id);
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.deepEqual(value.records.map(record => record.id), ids);
});
test("Refresh checks exact folder once and removes only confirmed manually deleted files", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.reconcileFileCleanup();
  files = [uploadPath];
  await cleanup.refreshOrphanFiles();
  assert.equal(cleanup.getOrphanFiles().length, 1);
  files = [];
  await cleanup.refreshOrphanFiles();
  assert.equal(value.records.length, 0);
});
test("writer failover rejects old GM and accepts elected GM without resetting records", async () => {
  await upload();
  const gm2 = { id: "gm2", isGM: true, active: true };
  game.users.set(gm2.id, gm2); game.users.activeGM = gm2;
  await assert.rejects(cleanup.handleCleanupOperation("gm", { type: "export", paths: [] }), /active GM/);
  game.user = gm2;
  await cleanup.protectExportedFiles(["art/saved.webp"]);
  assert.equal(value.records.length, 1);
  assert.deepEqual(value.exports, ["art/saved.webp"]);
});
test("cache-busting artwork references preserve the underlying file", async () => {
  await upload(); await cleanup.settleInternalUploads([uploadPath]);
  game.scenes = [{ toObject: () => ({ background: { src: `${uploadPath}?v=123#preview` } }) }];
  await cleanup.reconcileFileCleanup();
  assert.equal(value.records.length, 1);
  assert.deepEqual(cleanup.getOrphanFiles(), []);
});
test("prior-session reservations recover without expiring active current-session work", async () => {
  await upload();
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records.find(record => record.path === uploadPath).state, "ready");
  value.records[0].sessionId = "old-browser-session";
  value.records[0].attemptId = "old-attempt";
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records.find(record => record.path === uploadPath).state, "settled");
});
test("startup recovers recorded paths from their original folder after configuration changes", async () => {
  const original = "old/staging/assignment-overlay.webp";
  prompt.assignments.assignment.pendingSubmission = { staged: { overlayPath: original } };
  files = [original];
  await cleanup.reconcileFileCleanup({ scan: true });
  const recovered = value.records.find(record => record.path === original);
  assert.ok(recovered);
  assert.equal(recovered.stagingRoot, "old/staging");
});
test("half-connected socket clients time out and do not prevent later writes", async () => {
  const original = emit.cleanupFile;
  emit.cleanupFile = () => new Promise(() => {});
  try {
    await assert.rejects(cleanup.requestCleanupClient("player", { action: "sessions" }, 10), /timed out/);
    await cleanup.protectExportedFiles(["art/saved.webp"]);
    assert.deepEqual(value.exports, ["art/saved.webp"]);
  } finally { emit.cleanupFile = original; }
});
test("Forge backfill queries the assigned player's library even when the GM library is empty", async () => {
  const original = emit.cleanupFile;
  const playerPath = "https://assets.forge-vtt.com/player-account/art/staging/assignment-overlay-capture-old.webp";
  globalThis.ForgeVTT = { usingTheForge: true };
  globalThis.ForgeAPI = { getUserId: async () => `${game.user.id === "gm" ? "gm" : "player"}-account`, call: async () => ({ success: false }) };
  const picker = foundry.applications.apps.FilePicker;
  const originalBrowse = picker.browse;
  picker.browse = async (source, target) => ({ source, target, dirs: [], files: game.user.id === "player" && target.includes("/staging") ? [playerPath] : [] });
  emit.cleanupFile = async (userId, payload) => {
    const previous = game.user;
    game.user = game.users.get(userId);
    try { return await cleanup.handleCleanupFileRequest("gm", payload); }
    finally { game.user = previous; }
  };
  try {
    await cleanup.reconcileFileCleanup({ scan: true });
    const recovered = value.records.find(record => record.path === playerPath);
    assert.ok(recovered);
    assert.equal(recovered.sourceUserId, "player");
    assert.equal(recovered.status, "denied");
  } finally { emit.cleanupFile = original; picker.browse = originalBrowse; }
});
test("slow physical cleanup releases the writer queue and denies acquiring its deleting file", async () => {
  globalThis.ForgeVTT = { usingTheForge: true };
  let finishDelete, startedDelete;
  const started = new Promise(resolve => { startedDelete = resolve; });
  globalThis.ForgeAPI = { getUserId: async () => "gm-account", call: async () => {
    startedDelete();
    return new Promise(resolve => { finishDelete = resolve; });
  } };
  const actual = `https://assets.forge-vtt.com/gm-account/${uploadPath}`;
  const reservationId = await cleanup.beginInternalUpload({ assignmentId: "assignment", attemptId: "attempt", kind: "overlay", expectedPath: uploadPath });
  await cleanup.completeInternalUpload(reservationId, { path: actual });
  await cleanup.settleInternalUploads([actual]);
  files = [actual];
  const cleanupRun = cleanup.reconcileFileCleanup();
  await started;
  await cleanup.protectExportedFiles(["art/unrelated-save.webp"]);
  await assert.rejects(cleanup.withFileCleanupProtection([actual], async () => {}), /deletion is in progress/);
  assert.deepEqual(value.exports, ["art/unrelated-save.webp"]);
  files = [];
  finishDelete({ success: true });
  await cleanupRun;
  assert.equal(value.records.length, 0);
});
test("Save leases protect legacy files discovered after the lease was acquired", async () => {
  const legacyPath = "art/staging/assignment-overlay.webp";
  files = [legacyPath];
  await cleanup.withFileCleanupProtection([legacyPath], async () => {
    await cleanup.reconcileFileCleanup({ scan: true });
    assert.ok(value.records.find(record => record.path === legacyPath));
    assert.deepEqual(cleanup.getOrphanFiles(), []);
  });
  await cleanup.reconcileFileCleanup();
  assert.equal(cleanup.getOrphanFiles()[0].path, legacyPath);
});
test("Prompt preparation persists known files and discovery context without any provider request", async () => {
  const original = foundry.applications.apps.FilePicker.browse;
  foundry.applications.apps.FilePicker.browse = () => { throw new Error("Preparation must not browse"); };
  prompt.assignments.assignment.pendingSubmission = { staged: { overlayPath: uploadPath } };
  try {
    await cleanup.preparePromptCleanup(prompt);
    assert.ok(value.records.find(record => record.path === uploadPath));
    assert.equal(value.pendingScans.length, 2);
  } finally { foundry.applications.apps.FilePicker.browse = original; }
});
test("automatic cleanup caps requests, exposes deferred files, and prioritizes them next time", async () => {
  for ( let index = 0; index < 12; index++ ) {
    const path = `art/staging/assignment-overlay-upload-attempt${index}.webp`;
    value.records.push({ id: `file-${index}`, assignmentId: "assignment", promptId: "prompt", path,
      sourceUserId: "gm", kind: "overlay", attemptId: `attempt${index}`, stagingRoot: "art/staging", pendingRoot: "art/pending/assignment",
      revision: 1, state: "settled", status: "pending", createdAt: index + 1, leases: [] });
  }
  files = value.records.map(record => record.path);
  await cleanup.reconcileFileCleanup({ retry: true });
  assert.equal(value.records.filter(record => record.lastCheckedAt).length, 10);
  assert.equal(value.records.filter(record => record.deferred).length, 2);
  assert.equal(cleanup.getOrphanFiles().length, 12);
  const attempted = value.records.slice(0, 10).map(record => record.lastCheckedAt);
  await cleanup.reconcileFileCleanup();
  assert.equal(value.records.filter(record => record.lastCheckedAt).length, 12);
  assert.deepEqual(value.records.slice(0, 10).map(record => record.lastCheckedAt), attempted);
  assert.equal(value.records.filter(record => record.deferred).length, 0);
  await cleanup.reconcileFileCleanup({ retry: true, manual: true });
  assert.equal(value.records.filter(record => record.lastCheckedAt).length, 12);
});
test("settlement schedules one cleanup while adopted files and idempotent mutations remain safe", async () => {
  const reservationId = await upload();
  prompt.assignments.assignment.pendingSubmission = { staged: { overlayPath: uploadPath } };
  await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.waitForFileCleanupIdle();
  const before = writes;
  await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.protectExportedFiles(["art/saved.webp"]);
  const withExport = writes;
  await cleanup.protectExportedFiles(["art/saved.webp"]);
  assert.equal(writes, withExport);
  assert.equal(withExport, before + 1);
  assert.equal(await cleanup.beginInternalUpload({ assignmentId: "assignment", attemptId: "attempt", kind: "overlay", expectedPath: uploadPath }), reservationId);
  assert.equal(writes, withExport);
  prompt.assignments.assignment.pendingSubmission = null;
  // A freshly completed abandoned attempt is cleaned without a caller retry.
  value.records[0].state = "ready";
  await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.waitForFileCleanupIdle();
  assert.equal(cleanup.getOrphanFiles()[0].status, "unsupported");
});
