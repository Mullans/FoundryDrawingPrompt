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
test("replacement browser sessions preserve uncertain uploads from the issuing session", async () => {
  await upload();
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records.find(record => record.path === uploadPath).state, "ready");
  value.records[0].sessionId = "old-browser-session";
  value.records[0].attemptId = "old-attempt";
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records.find(record => record.path === uploadPath).state, "ready");
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
test("session recovery preserves a legacy Save lease acquired after its snapshot", async () => {
  const original = emit.cleanupFile;
  let resumePlayer, queriedPlayer, finishSave, acquiredSave;
  const playerQueried = new Promise(resolve => { queriedPlayer = resolve; });
  const saveAcquired = new Promise(resolve => { acquiredSave = resolve; });
  const saveFinished = new Promise(resolve => { finishSave = resolve; });
  for ( const [index, sourceUserId] of ["gm", "player"].entries() ) value.records.push({
    id: `waiting-${index}`, sourceUserId, assignmentId: "assignment", promptId: "prompt", kind: "overlay",
    attemptId: `waiting${index}`, path: `art/staging/assignment-overlay-upload-waiting${index}.webp`,
    stagingRoot: "art/staging", pendingRoot: "art/pending/assignment", revision: 1,
    state: "uploading", sessionId: "prior-session", status: "pending", leases: []
  });
  emit.cleanupFile = async (_userId, payload) => {
    if ( payload.action !== "sessions" ) throw new Error("Unexpected remote call");
    queriedPlayer();
    return new Promise(resolve => { resumePlayer = () => resolve({ sessionId: "player-session", attempts: [], leases: [] }); });
  };
  let saveRun;
  try {
    const recovery = cleanup.reconcileFileCleanup({ scan: true });
    await playerQueried; // The GM's earlier session response contained no lease.
    saveRun = cleanup.withFileCleanupProtection(["art/legacy-source.webp"], async () => { acquiredSave(); await saveFinished; });
    await saveAcquired;
    const heldId = value.readLeases[0].id;
    resumePlayer();
    await recovery;
    assert.ok(value.readLeases.some(lease => lease.id === heldId));
    finishSave();
    await saveRun;
    assert.deepEqual(value.readLeases, []);
  } finally { emit.cleanupFile = original; finishSave(); resumePlayer?.(); if ( saveRun ) await saveRun; }
});
test("a disconnected upload intent survives absence and a late HTTP completion", async () => {
  prompt.lifecycleStatus = "open";
  prompt.assignments.assignment.status = "opened";
  const original = emit.cleanupFile;
  let reservationId;
  emit.cleanupFile = async () => ({ sessionId: "issuing-player-session", attempts: [], leases: [] });
  try {
    reservationId = await cleanup.handleCleanupOperation("player", { type: "begin", assignmentId: "assignment", attemptId: "attempt", kind: "overlay", expectedPath: uploadPath, sessionId: "issuing-player-session" });
  } finally { emit.cleanupFile = original; }
  game.users.get("player").active = false;
  prompt = null;
  files = [];
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records[0].state, "uploading");
  files = [uploadPath]; // The already-issued HTTP upload finishes after disconnect.
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records[0].state, "uploading");
  await cleanup.handleCleanupOperation("player", { type: "complete", reservationId, path: uploadPath });
  await cleanup.reconcileFileCleanup({ scan: true });
  assert.equal(value.records[0].state, "settled");
  assert.equal(cleanup.getOrphanFiles()[0].path, uploadPath);
});
test("disconnected or replacement Save sessions cannot release outstanding read leases", async () => {
  const original = emit.cleanupFile;
  await upload();
  prompt.assignments.assignment.pendingSubmission = { staged: { overlayPath: uploadPath } };
  await cleanup.settleInternalUploads([uploadPath]);
  await cleanup.waitForFileCleanupIdle();
  prompt = null;
  game.users.set("saving-gm", { id: "saving-gm", isGM: true, active: false });
  value.readLeases = [{ id: "held-save", userId: "saving-gm", sessionId: "issuing-save-session", paths: [uploadPath] }];
  value.records[0].leases = [{ id: "held-save", userId: "saving-gm", sessionId: "issuing-save-session" }];
  try {
    await cleanup.reconcileFileCleanup({ scan: true });
    assert.equal(value.readLeases.length, 1);
    assert.equal(value.records[0].leases.length, 1);
    game.users.get("saving-gm").active = true;
    emit.cleanupFile = async () => ({ sessionId: "replacement-browser", attempts: [], leases: [] });
    await cleanup.reconcileFileCleanup({ scan: true });
    assert.equal(value.readLeases.length, 1);
    assert.equal(value.records[0].leases.length, 1);
    assert.deepEqual(cleanup.getOrphanFiles(), []);
  } finally { emit.cleanupFile = original; }
});

function openPlayerAssignments(count = 1) {
  prompt.lifecycleStatus = "open";
  prompt.assignments.assignment.status = "opened";
  const ids = ["assignment"];
  for ( let index = 1; index < count; index++ ) {
    const assignmentId = `assignment${index}`;
    ids.push(assignmentId);
    prompt.assignments[assignmentId] = { id: assignmentId, userId: "player", userName: "Ada", status: "opened", assets: {} };
  }
  rebuildAssignmentIndex();
  return ids;
}

function playerBegin(assignmentId, attemptId, clientSession = "authenticated-player", kind = "overlay") {
  return { type: "begin", assignmentId, attemptId, kind, sessionId: clientSession,
    expectedPath: `art/staging/${assignmentId}-${kind}-upload-${attemptId}.webp` };
}

test("missing and forged upload sessions are rejected without registry writes", async () => {
  openPlayerAssignments();
  const original = emit.cleanupFile;
  let checks = 0;
  emit.cleanupFile = async (userId, payload) => {
    checks++;
    assert.equal(userId, "player");
    assert.deepEqual(payload, { action: "sessions", targetUserId: "player" });
    return { sessionId: "authenticated-player", attempts: [], leases: [] };
  };
  try {
    const missing = playerBegin("assignment", "missing");
    delete missing.sessionId;
    await assert.rejects(cleanup.handleCleanupOperation("player", missing), /authenticated client session/);
    assert.equal(checks, 0);
    await assert.rejects(cleanup.handleCleanupOperation("player", playerBegin("assignment", "forged", "invented-session")), /does not match/);
    await assert.rejects(cleanup.handleCleanupOperation("gm", playerBegin("assignment", "forged-gm", "invented-gm-session")), /does not match/);
    assert.equal(value.records.length, 0);
    assert.equal(writes, 0);
  } finally { emit.cleanupFile = original; }
});

test("concurrent unique reservations stop at the Assignment limit and replay remains accepted", async () => {
  openPlayerAssignments();
  const original = emit.cleanupFile;
  let releaseSession;
  const sessionResponse = new Promise(resolve => { releaseSession = () => resolve({ sessionId: "authenticated-player", attempts: [], leases: [] }); });
  emit.cleanupFile = async () => sessionResponse;
  try {
    const pending = Array.from({ length: 9 }, (_item, index) => cleanup.handleCleanupOperation("player", playerBegin("assignment", `flood${index}`)));
    await new Promise(resolve => setImmediate(resolve));
    releaseSession();
    const results = await Promise.allSettled(pending);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 8);
    assert.match(results.find(result => result.status === "rejected").reason.message, /Assignment has too many/);
    assert.equal(value.records.length, 8);
    assert.equal(writes, 8);
    const first = value.records[0];
    assert.equal(await cleanup.handleCleanupOperation("player", playerBegin("assignment", first.attemptId)), first.id);
    assert.equal(writes, 8);
    assert.equal(value.records.length, 8);
  } finally { releaseSession(); emit.cleanupFile = original; }
});

test("the user-wide reservation limit spans Assignments, ready uploads, and session rollover", async () => {
  const assignmentIds = openPlayerAssignments(5);
  const original = emit.cleanupFile;
  let currentSession = "authenticated-player";
  emit.cleanupFile = async () => ({ sessionId: currentSession, attempts: [], leases: [] });
  try {
    for ( const assignmentId of assignmentIds.slice(0, 4) ) {
      for ( let index = 0; index < 8; index++ ) await cleanup.handleCleanupOperation("player", playerBegin(assignmentId, `attempt${index}`));
    }
    // Completed but unadopted uploads still consume outstanding capacity.
    const first = value.records[0];
    await cleanup.handleCleanupOperation("player", { type: "complete", reservationId: first.id, path: first.path });
    const before = writes;
    currentSession = "replacement-player-session";
    await assert.rejects(cleanup.handleCleanupOperation("player", playerBegin(assignmentIds[4], "overflow", currentSession)), /User has too many/);
    assert.equal(value.records.length, 32);
    assert.equal(writes, before);
    assert.equal(await cleanup.handleCleanupOperation("player", playerBegin(first.assignmentId, first.attemptId, currentSession)), first.id);
    assert.equal(writes, before);
  } finally { emit.cleanupFile = original; }
});

test("parallel Submit and Close overlay/merged reservations fit the limits", async () => {
  openPlayerAssignments();
  const original = emit.cleanupFile;
  emit.cleanupFile = async () => ({ sessionId: "authenticated-player", attempts: [], leases: [] });
  try {
    const requests = ["overlay", "merged"].flatMap(kind => [
      playerBegin("assignment", "submit", "authenticated-player", kind),
      { ...playerBegin("assignment", "close", "authenticated-player", kind), purpose: "retained-capture",
        expectedPath: `art/staging/assignment-${kind}-capture-captureA-upload-close.webp` }
    ]);
    const ids = await Promise.all(requests.map(request => cleanup.handleCleanupOperation("player", request)));
    assert.equal(new Set(ids).size, 4);
    assert.equal(value.records.length, 4);
  } finally { emit.cleanupFile = original; }
});

function discoveryContext(overrides = {}) {
  return { id: "scan", revision: 1, assignmentId: "assignment", promptId: "prompt", promptName: "Creature", playerName: "Ada",
    sourceUserId: "player", source: "data", folder: "art/staging", stagingRoot: "art/staging", pendingRoot: "art/pending/assignment", createdAt: 1, ...overrides };
}

test("failed deleted-Prompt discovery remains visible and Refresh discovers without deleting", async () => {
  value.pendingScans = [discoveryContext()];
  prompt = null;
  const picker = foundry.applications.apps.FilePicker;
  const original = picker.browse;
  try {
    picker.browse = async () => { throw new Error("permission denied"); };
    await cleanup.refreshOrphanFiles();
    const [scan] = cleanup.getPendingCleanupScans();
    assert.equal(scan.status, "unableToVerify");
    assert.equal(scan.promptName, "Creature");
    assert.equal(scan.playerName, "Ada");
    assert.equal(scan.folder, "art/staging");
    assert.ok(scan.orphanedAt);
    files = [uploadPath, "art/staging/unrelated-overlay.webp"];
    picker.browse = original;
    await cleanup.refreshOrphanFiles();
    assert.deepEqual(cleanup.getPendingCleanupScans(), []);
    assert.equal(cleanup.getOrphanFiles().length, 1);
    assert.equal(cleanup.getOrphanFiles()[0].path, uploadPath);
    assert.equal(cleanup.getOrphanFiles()[0].error, "File found; use Retry Cleanup");
    assert.deepEqual(files, [uploadPath, "art/staging/unrelated-overlay.webp"]);
  } finally { picker.browse = original; }
});

test("pending folder rows exclude retained Prompts and players but retain offline Forge owners", async () => {
  value.pendingScans = [discoveryContext({ source: "forgevtt", status: "unavailable", error: "Offline" })];
  assert.deepEqual(cleanup.getPendingCleanupScans(), []);
  prompt = null;
  game.users.get("player").active = false;
  await cleanup.refreshOrphanFiles();
  assert.equal(cleanup.getPendingCleanupScans()[0].source, "forgevtt");
  assert.equal(cleanup.getPendingCleanupScans()[0].account, "");
  assert.equal(cleanup.getPendingCleanupScans()[0].error, "File-owning client is offline");
  game.user = game.users.get("player");
  assert.deepEqual(cleanup.getPendingCleanupScans(), []);
});

test("Refresh groups discovery by exact folder and removes contexts after authoritative absence", async () => {
  value.pendingScans = [discoveryContext(), discoveryContext({ id: "scan2", assignmentId: "other", sourceUserId: "other", pendingRoot: "art/pending/other" })];
  prompt = null;
  files = [uploadPath, "art/staging/other-merged-upload-attempt.webp", "art/staging/unrelated-overlay.webp"];
  const picker = foundry.applications.apps.FilePicker;
  const original = picker.browse;
  let calls = 0;
  try {
    picker.browse = async (...args) => { calls++; return original(...args); };
    await cleanup.refreshOrphanFiles();
    // The authoritative discovery listing also verifies the found files.
    assert.equal(calls, 1);
    assert.equal(value.records.length, 2);
    assert.equal(value.pendingScans.length, 0);
    value.records = [];
    value.pendingScans = [discoveryContext()];
    files = [];
    await cleanup.refreshOrphanFiles();
    assert.equal(value.pendingScans.length, 0);
    assert.deepEqual(cleanup.getPendingCleanupScans(), []);
  } finally { picker.browse = original; }
});

test("discovery batches reject stale revisions and cross-folder context injection", async () => {
  value.pendingScans = [discoveryContext(), discoveryContext({ id: "scan2", folder: "art/pending/assignment" })];
  const invoke = scans => cleanup.handleCleanupFileRequest("gm", { action: "discoverBatch", targetUserId: "gm", scans });
  await assert.rejects(invoke([{ scanId: "scan", revision: 2 }]), /stale/);
  await assert.rejects(invoke([{ scanId: "scan", revision: 1 }, { scanId: "scan2", revision: 1 }]), /boundary/);
  assert.equal(writes, 0);
});

test("bounded Refresh exposes unattempted folders and the next Refresh finishes them", async () => {
  prompt = null;
  value.pendingScans = Array.from({ length: 11 }, (_, index) => discoveryContext({ id: `scan${index}`, folder: `art${index}/staging`, stagingRoot: `art${index}/staging` }));
  const picker = foundry.applications.apps.FilePicker;
  const original = picker.browse;
  let calls = 0;
  try {
    picker.browse = async (...args) => { calls++; return original(...args); };
    await cleanup.refreshOrphanFiles();
    assert.equal(calls, 10);
    assert.equal(value.pendingScans.length, 1);
    assert.equal(cleanup.getPendingCleanupScans()[0].deferred, true);
    await cleanup.refreshOrphanFiles();
    assert.equal(calls, 11);
    assert.deepEqual(cleanup.getPendingCleanupScans(), []);
  } finally { picker.browse = original; }
});

test("Refresh retains the original Forge folder when a response changes accounts", async () => {
  prompt = null;
  const folder = "https://assets.forge-vtt.com/owner/art/staging";
  value.pendingScans = [discoveryContext({ source: "forgevtt", folder })];
  const original = emit.cleanupFile;
  try {
    emit.cleanupFile = async () => ({ scans: [{ scanId: "scan", files: [] }], folder: "https://assets.forge-vtt.com/other/art/staging", files: [] });
    await cleanup.refreshOrphanFiles();
    assert.equal(value.pendingScans.length, 1);
    assert.equal(cleanup.getPendingCleanupScans()[0].folder, folder);
    assert.equal(cleanup.getPendingCleanupScans()[0].account, "owner");
    assert.equal(cleanup.getPendingCleanupScans()[0].status, "unableToVerify");
  } finally { emit.cleanupFile = original; }
});
