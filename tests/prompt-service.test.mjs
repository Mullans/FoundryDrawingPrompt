import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import { FLAG_PROMPT, MODULE_ID, PROMPT_STATUS, STATUS } from "../scripts/constants.mjs";

let saveAssignment;
let stagedFetchUrl;
let buildRestorationSubmissionFromSavedAssets;
let reopenAssignment;
let closePrompt;
let reopenPrompt;
let archivePrompt;
let restorePrompt;
let deletePrompt;
let processRecoveryTombstonesForUser;
let DrawingAssignment;
let DrawingPrompt;
let storedPrompt;
let emit;
let deletedFiles;

before(async () => {
  class ApplicationV2 {}
  globalThis.foundry = {
    utils: { randomID: () => "capture-request" },
    applications: {
      api: {
        ApplicationV2,
        DialogV2: class {},
        HandlebarsApplicationMixin: Base => class extends Base {}
      },
      apps: { FilePicker: class {
        static async delete(_source, path) { deletedFiles.push(path); }
      } }
    }
  };
  ({ DrawingAssignment, DrawingPrompt } = await import("../scripts/prompts/prompt-models.mjs"));
  ({
    saveAssignment,
    stagedFetchUrl,
    buildRestorationSubmissionFromSavedAssets,
    reopenAssignment,
    closePrompt,
    reopenPrompt,
    archivePrompt,
    restorePrompt,
    deletePrompt,
    processRecoveryTombstonesForUser
  } = await import("../scripts/prompts/prompt-service.mjs"));
  ({ emit } = await import("../scripts/socket.mjs"));
});

beforeEach(() => {
  deletedFiles = [];
  const assignment = new DrawingAssignment({
    id: "a-saved",
    promptId: "p-save",
    userId: "u1",
    userName: "Ada",
    status: STATUS.OPENED,
    submittedAt: 123_456,
    savedSubmissionTs: null,
    assets: {
      name: "Griffin",
      overlayPath: "drawings/griffin.webp",
      oplogPath: "drawings/griffin.json"
    }
  });
  assignment.status = STATUS.SUBMITTED;
  storedPrompt = {
    id: "p-save",
    gmUserId: "gm1",
    promptText: "Draw a griffin",
    drawingName: "Griffin",
    assignments: { "a-saved": assignment }
  };
  const entry = {
    id: "p-save",
    getFlag: (moduleId, flag) => moduleId === MODULE_ID && flag === FLAG_PROMPT ? storedPrompt : null,
    setFlag: async (_moduleId, _flag, value) => {
      storedPrompt = structuredClone(value);
      return entry;
    },
    delete: async () => { storedPrompt = null; return entry; }
  };
  const journal = {
    get: id => id === "p-save" ? entry : null,
    [Symbol.iterator]: function* () { yield entry; }
  };
  globalThis.game = {
    user: { id: "gm1", isGM: true },
    journal,
    users: new Map([
      ["u1", { id: "u1", name: "Ada", active: false }]
    ]),
    i18n: { localize: key => key },
    world: { id: "test-world" },
    settings: {
      values: new Map(),
      get(_module, key) { return this.values.get(key) ?? []; },
      async set(_module, key, value) { this.values.set(key, structuredClone(value)); return value; }
    }
  };
  globalThis.Hooks = { callAll: () => {} };
  globalThis.sessionStorage = {
    store: new Map(),
    setItem(key, value) { this.store.set(key, value); },
    getItem(key) { return this.store.get(key) ?? null; },
    removeItem(key) { this.store.delete(key); }
  };
});

test("Prompt lifecycle closes with a frozen timer and reopens paused", async () => {
  storedPrompt.timerSeconds = 60;
  storedPrompt.timerStatus = "running";
  storedPrompt.deadlineAt = Date.now() + 30_000;
  storedPrompt.remainingMs = null;

  const closed = await closePrompt("p-save");
  assert.equal(closed.lifecycleStatus, PROMPT_STATUS.CLOSED);
  assert.equal(closed.timerStatus, "paused");
  assert.equal(closed.deadlineAt, null);
  assert.ok(closed.remainingMs <= 30_000 && closed.remainingMs > 0);
  assert.equal(storedPrompt.lifecycleStatus, PROMPT_STATUS.CLOSED);

  const reopened = await reopenPrompt("p-save");
  assert.equal(reopened.lifecycleStatus, PROMPT_STATUS.OPEN);
  assert.equal(reopened.timerStatus, "paused");
  assert.equal(reopened.deadlineAt, null);
});

test("Closing a Prompt cancels active Assignments and closes their player work", async () => {
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.status = STATUS.OPENED;
  assignment.delivery = { status: "received", generation: 2 };
  game.users.get("u1").active = true;
  const originalCancel = emit.cancelDrawingPrompt;
  const cancelled = [];
  emit.cancelDrawingPrompt = async (...args) => cancelled.push(args);
  try {
    const closed = await closePrompt("p-save", { closeWithoutCaptures: true });
    assert.equal(closed.getAssignment("a-saved").status, STATUS.CANCELLED);
    assert.deepEqual(cancelled, [["u1", "a-saved", 2]]);
  } finally {
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("Close accepts only a correlated full-quality retained capture and persists it incrementally", async () => {
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.status = STATUS.OPENED;
  assignment.delivery = { status: "received", generation: 0 };
  assignment.assets = {};
  assignment.pendingSubmission = null;
  storedPrompt.timerStatus = "running";
  storedPrompt.deadlineAt = Date.now() + 20_000;
  game.users.get("u1").active = true;
  const originalCapture = emit.requestRetainedCapture;
  const originalCancel = emit.cancelDrawingPrompt;
  emit.cancelDrawingPrompt = async () => {};
  emit.requestRetainedCapture = async (_userId, assignmentId, requestId) => ({
    requestId: `${requestId}-stale`, assignmentId,
    submission: { mode: "staged", staged: { overlayPath: "pending/full.webp", mergedPath: null },
      width: 512, height: 512 }
  });
  try {
    await assert.rejects(() => closePrompt("p-save"), error => error.code === "RETAINED_CAPTURE_FAILED");
    assert.equal(storedPrompt.lifecycleStatus ?? PROMPT_STATUS.OPEN, PROMPT_STATUS.OPEN);
    assert.equal(storedPrompt.timerStatus, "paused", "a failed close attempt must leave drawing time frozen");

    emit.requestRetainedCapture = async (_userId, assignmentId, requestId) => ({
      requestId, assignmentId,
      submission: { mode: "staged", staged: { overlayPath: "pending/full.webp", mergedPath: null },
        width: 512, height: 512 }
    });
    const closed = await closePrompt("p-save");
    assert.deepEqual(closed.getAssignment("a-saved").retainedCapture, {
      kind: "full-submission", receiptTs: closed.getAssignment("a-saved").retainedCapture.receiptTs,
      width: 512, height: 512, overlayPath: "pending/full.webp", mergedPath: null
    });
    assert.equal(storedPrompt.assignments["a-saved"].retainedCapture.overlayPath, "pending/full.webp");
  } finally {
    emit.requestRetainedCapture = originalCapture;
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("Prompt lifecycle only archives Closed Prompts and restores them", async () => {
  await assert.rejects(() => archivePrompt("p-save"), /Illegal transition/);
  await closePrompt("p-save");
  const archived = await archivePrompt("p-save");
  assert.equal(archived.lifecycleStatus, PROMPT_STATUS.ARCHIVED);
  const restored = await restorePrompt("p-save");
  assert.equal(restored.lifecycleStatus, PROMPT_STATUS.CLOSED);
});

test("Delete requires explicit confirmation and removes the Prompt entry", async () => {
  assert.equal(await deletePrompt("p-save", { confirmed: false }), false);
  assert.notEqual(storedPrompt, null);
  assert.equal(await deletePrompt("p-save", { confirmed: true }), true);
  assert.equal(storedPrompt, null);
  assert.deepEqual(game.settings.get("drawing-prompts", "recoveryTombstones"), [{
    worldId: "test-world", gmUserId: "gm1", userId: "u1", assignmentId: "a-saved", promptId: "p-save", width: 512, height: 512
  }]);
});

test("Recovery tombstones clear on the player's next connection acknowledgement", async () => {
  await deletePrompt("p-save", { confirmed: true });
  const originalClear = emit.clearRecoveryCopy;
  emit.clearRecoveryCopy = async (_userId, identity) => identity.assignmentId === "a-saved";
  try {
    await processRecoveryTombstonesForUser("u1");
    assert.deepEqual(game.settings.get("drawing-prompts", "recoveryTombstones"), []);
  } finally {
    emit.clearRecoveryCopy = originalClear;
  }
});

test("Delete removes only recorded internal capture files and preserves exported assets", async () => {
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.pendingSubmission = { staged: {
    overlayPath: "drawing-prompts/pending/a-saved/pending.webp",
    mergedPath: "drawing-prompts/pending/a-saved/pending-merged.webp"
  } };
  assignment.retainedCapture = {
    kind: "saved-preview", overlayPath: "drawing-prompts/pending/a-saved/preview.webp"
  };
  assignment.assets.overlayPath = "drawings/exported.webp";

  await deletePrompt("p-save", { confirmed: true });

  assert.deepEqual(deletedFiles.sort(), [
    "drawing-prompts/pending/a-saved/pending-merged.webp",
    "drawing-prompts/pending/a-saved/pending.webp",
    "drawing-prompts/pending/a-saved/preview.webp"
  ]);
  assert.equal(deletedFiles.includes("drawings/exported.webp"), false);
});

test("saveAssignment backfills the save gate timestamp when cached submission data is gone", async () => {
  const assignment = await saveAssignment("a-saved");

  assert.equal(assignment.savedSubmissionTs, 123_456);
  assert.equal(storedPrompt.assignments["a-saved"].savedSubmissionTs, 123_456);
});

test("stagedFetchUrl treats a local path as root-relative", () => {
  const url = stagedFetchUrl("worlds/test-world/drawing-prompts/staging/a1-overlay.webp", 999);

  assert.equal(url, "/worlds/test-world/drawing-prompts/staging/a1-overlay.webp?ts=999");
});

test("stagedFetchUrl fetches a Forge Assets Library URL absolutely", () => {
  const forgeUrl = "https://assets.forge-vtt.com/abc123/drawing-prompts/world/staging/a1-overlay.webp";

  const url = stagedFetchUrl(forgeUrl, 999);

  assert.equal(url, `${forgeUrl}?ts=999`);
});

test("stagedFetchUrl appends the cache-buster with & when the URL already has a query string", () => {
  const forgeUrl = "https://assets.forge-vtt.com/abc123/staging/a1-overlay.webp?v=2";

  const url = stagedFetchUrl(forgeUrl, 999);

  assert.equal(url, `${forgeUrl}&ts=999`);
});

test("buildRestorationSubmissionFromSavedAssets returns full-quality image paths without a GM operation log", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.match(String(url), /griffin\.json$/);
    return {
      ok: true,
      json: async () => ({ ops: [{ type: "stroke" }] })
    };
  };
  try {
    const assignment = storedPrompt.assignments["a-saved"];
    assignment.assets.mergedPath = "drawings/griffin-merged.webp";
    assignment.assets.tileWidth = 800;
    assignment.assets.tileHeight = 600;
    const prompt = DrawingPrompt.fromObject({
      ...storedPrompt,
      canvasWidth: 800,
      canvasHeight: 600
    });
    const submission = await buildRestorationSubmissionFromSavedAssets(assignment, prompt);

    assert.equal(submission.mode, "staged");
    assert.equal(submission.staged.overlayPath, "drawings/griffin.webp");
    assert.equal(submission.staged.mergedPath, "drawings/griffin-merged.webp");
    assert.equal(submission.formats.overlay, "webp");
    assert.equal(submission.opLog, undefined);
    assert.equal(submission.width, 800);
    assert.equal(submission.height, 600);
    assert.equal(submission.recoveryKind, "full-submission");
    assert.equal(submission.assignmentId, "a-saved");
    assert.equal(submission.overlay, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reopenAssignment does not persist pendingSubmission to JournalEntry", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ops: [] })
  });
  const originalReopen = emit.reopenDrawingPrompt;
  let reopenPayload = null;
  emit.reopenDrawingPrompt = async (_userId, payload) => {
    reopenPayload = payload;
  };
  storedPrompt.canvasWidth = 1024;
  storedPrompt.canvasHeight = 768;
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.savedSubmissionTs = 123_456;
  assignment.assets.mergedPath = "drawings/griffin-merged.webp";
  assignment.assets.tileWidth = 1024;
  assignment.assets.tileHeight = 768;
  game.users.get("u1").active = true;

  try {
    await reopenAssignment("a-saved");

    assert.equal(storedPrompt.assignments["a-saved"].pendingSubmission, null);
    assert.equal(storedPrompt.assignments["a-saved"].status, STATUS.OPENED);
    assert.equal(reopenPayload?.restorationSubmission?.mode, "staged");
    assert.equal(reopenPayload?.restorationSubmission?.recoveryKind, "full-submission");
    assert.equal(reopenPayload?.restorationSubmission?.assignmentId, "a-saved");
    assert.equal(reopenPayload?.restorationSubmission?.opLog, undefined);
    assert.equal(reopenPayload?.restorationSubmission?.staged?.overlayPath, "drawings/griffin.webp");
    assert.equal(reopenPayload?.assignment?.pendingSubmission, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    emit.reopenDrawingPrompt = originalReopen;
    game.users.get("u1").active = false;
  }
});
