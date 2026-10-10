import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";

import { FLAG_PROMPT, MODULE_ID, PROMPT_STATUS, STATUS } from "../scripts/constants.mjs";

let saveAssignment;
let stagedFetchUrl;
let buildRestorationSubmissionFromSavedAssets;
let reopenAssignment;
let closePrompt;
let sendPrompt;
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
let failSetFlagAt;
let setFlagCalls;
let clearPendingSubmission;
let cleanup;
let nextUploadId = 0;

before(async () => {
  class ApplicationV2 {}
  globalThis.foundry = {
    utils: { randomID: () => `capture-request-${++nextUploadId}` },
    applications: {
      api: {
        ApplicationV2,
        DialogV2: class {},
        HandlebarsApplicationMixin: Base => class extends Base {}
      },
      apps: { FilePicker: class {
        static async browse() { return { files: [], dirs: [] }; }
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
    sendPrompt,
    reopenPrompt,
    archivePrompt,
    restorePrompt,
    deletePrompt,
    processRecoveryTombstonesForUser
  } = await import("../scripts/prompts/prompt-service.mjs"));
  ({ emit } = await import("../scripts/socket.mjs"));
  ({ clearPendingSubmission } = await import("../scripts/prompts/pending-submission.mjs"));
  cleanup = await import("../scripts/prompts/file-cleanup-service.mjs");
});

beforeEach(async () => {
  // Lifecycle cleanup is deliberately deferred; drain its queue before replacing the world fixture.
  if ( globalThis.game?.settings ) await cleanup.reconcileFileCleanup();
  clearPendingSubmission("a-saved");
  clearPendingSubmission("a-second");
  deletedFiles = [];
  failSetFlagAt = null;
  setFlagCalls = 0;
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
    promptName: "Griffin",
    assignments: { "a-saved": assignment }
  };
  const entry = {
    id: "p-save",
    getFlag: (moduleId, flag) => moduleId === MODULE_ID && flag === FLAG_PROMPT ? storedPrompt : null,
    setFlag: async (_moduleId, _flag, value) => {
      setFlagCalls++;
      if ( setFlagCalls === failSetFlagAt ) throw new Error("simulated incremental persistence failure");
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
      ["gm1", { id: "gm1", name: "GM", isGM: true, active: true }],
      ["u1", { id: "u1", name: "Ada", active: false }]
    ]),
    i18n: { localize: key => key },
    world: { id: "test-world" },
    scenes: [], actors: [],
    settings: {
      values: new Map(),
      get(_module, key) { return this.values.get(key) ?? (key === "fileCleanupRegistry" ? { version: 1, records: [], exports: [] } : []); },
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

afterEach(async () => { await cleanup.waitForFileCleanupIdle(); });

test("Archive cannot override Send while its Open flag write is pending", async () => {
  storedPrompt = { ...storedPrompt, lifecycleStatus: PROMPT_STATUS.DRAFT,
    assignments: {}, selectedUserIds: ["u1"] };
  game.users.get("u1").can = () => false;
  const entry = game.journal.get("p-save");
  const originalSetFlag = entry.setFlag;
  let release;
  let signal;
  const blocked = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  entry.setFlag = async (...args) => {
    if ( args[2].lifecycleStatus === PROMPT_STATUS.OPEN ) {
      signal();
      await gate;
    }
    return originalSetFlag(...args);
  };
  const sending = sendPrompt("p-save");
  await blocked;
  const archiving = archivePrompt("p-save");
  const rejected = assert.rejects(archiving, /open Prompt/);
  release();
  await sending;
  await rejected;
  assert.equal(storedPrompt.lifecycleStatus, PROMPT_STATUS.OPEN);
  assert.equal(Object.keys(storedPrompt.assignments).length, 1);
  assert.equal(Object.values(storedPrompt.assignments)[0].status, STATUS.PENDING);
});

for ( const [firstAction, staleAction, source, target] of [
  ["reopenPrompt", "archivePrompt", PROMPT_STATUS.CLOSED, PROMPT_STATUS.OPEN],
  ["archivePrompt", "reopenPrompt", PROMPT_STATUS.CLOSED, PROMPT_STATUS.ARCHIVED],
  ["archivePrompt", "reopenAssignment", PROMPT_STATUS.CLOSED, PROMPT_STATUS.ARCHIVED],
  ["restorePrompt", "restorePrompt", PROMPT_STATUS.ARCHIVED, PROMPT_STATUS.CLOSED],
  ["reopenPrompt", "reopenPrompt", PROMPT_STATUS.CLOSED, PROMPT_STATUS.OPEN]
] ) {
  test(`${staleAction} rechecks lifecycle after concurrent ${firstAction} commits`, async () => {
    storedPrompt.lifecycleStatus = source;
    const actions = { reopenPrompt, archivePrompt, restorePrompt,
      reopenAssignment: () => reopenAssignment("a-saved") };
    const entry = game.journal.get("p-save");
    const originalSetFlag = entry.setFlag;
    let release;
    let signal;
    const blocked = new Promise(resolve => { signal = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    entry.setFlag = async (...args) => {
      if ( first ) { first = false; signal(); await gate; }
      return originalSetFlag(...args);
    };
    const committing = actions[firstAction]("p-save");
    await blocked;
    const stale = actions[staleAction]("p-save");
    const rejected = assert.rejects(stale, new RegExp(`${target} Prompt`));
    release();
    await committing;
    await rejected;
    assert.equal(storedPrompt.lifecycleStatus, target);
    assert.equal(setFlagCalls, 1, "stale transitions perform no second flag write");
  });
}

for ( const lifecycleStatus of [PROMPT_STATUS.DRAFT, PROMPT_STATUS.CLOSED, PROMPT_STATUS.ARCHIVED] ) {
  test(`Close rejects ${lifecycleStatus} before freezing the timer or retaining artwork`, async () => {
    storedPrompt.lifecycleStatus = lifecycleStatus;
    storedPrompt.timerStatus = "running";
    storedPrompt.deadlineAt = Date.now() + 30_000;
    const previous = structuredClone(storedPrompt);
    await assert.rejects(closePrompt("p-save"), new RegExp(`${lifecycleStatus} Prompt`));
    assert.deepEqual(structuredClone(storedPrompt), previous);
    assert.equal(setFlagCalls, 0);
  });
}

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
    submission: { mode: "staged", formats: { overlay: "webp" }, staged: { overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp", mergedPath: null },
      width: 512, height: 512 }
  });
  try {
    await assert.rejects(() => closePrompt("p-save"), error => error.code === "RETAINED_CAPTURE_FAILED");
    assert.equal(storedPrompt.lifecycleStatus ?? PROMPT_STATUS.OPEN, PROMPT_STATUS.OPEN);
    assert.equal(storedPrompt.timerStatus, "paused", "a failed close attempt must leave drawing time frozen");

    emit.requestRetainedCapture = async (_userId, assignmentId, requestId) => ({
      requestId, assignmentId,
      submission: { mode: "staged", formats: { overlay: "webp" }, staged: { overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp", mergedPath: null },
        width: 512, height: 512 }
    });
    const closed = await closePrompt("p-save");
    assert.deepEqual(closed.getAssignment("a-saved").retainedCapture, {
      kind: "full-submission", receiptTs: closed.getAssignment("a-saved").retainedCapture.receiptTs,
      width: 512, height: 512, overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp", mergedPath: null
    });
    assert.equal(storedPrompt.assignments["a-saved"].retainedCapture.overlayPath, "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp");
  } finally {
    emit.requestRetainedCapture = originalCapture;
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("Close reports incremental retained-capture persistence failure through the resolution gate", async () => {
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.status = STATUS.OPENED;
  assignment.delivery = { status: "received", generation: 0 };
  assignment.assets = {};
  game.users.get("u1").active = true;
  const originalCapture = emit.requestRetainedCapture;
  const failedCapturePath = "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp";
  await game.settings.set(MODULE_ID, "fileCleanupRegistry", { version: 1, exports: [], records: [{
    id: "failed-capture", assignmentId: "a-saved", promptId: "p-save", sourceUserId: "u1",
    path: failedCapturePath, kind: "overlay", purpose: "retained-capture", state: "ready", status: "pending",
    stagingRoot: "worlds/test-world/drawing-prompts/staging", revision: 1, leases: []
  }] });
  emit.requestRetainedCapture = async (_userId, assignmentId, requestId) => ({
    requestId, assignmentId,
    submission: { mode: "staged", formats: { overlay: "webp" }, staged: { overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp", mergedPath: null }, width: 512, height: 512 }
  });
  failSetFlagAt = 2;
  try {
    await assert.rejects(() => closePrompt("p-save"), error =>
      error.code === "RETAINED_CAPTURE_FAILED" && error.assignmentIds?.includes("a-saved"));
    await cleanup.waitForFileCleanupIdle();
    assert.equal(game.settings.get(MODULE_ID, "fileCleanupRegistry").records
      .find(record => record.id === "failed-capture")?.state, "settled", "failed adoption releases the completed upload");
  } finally {
    emit.requestRetainedCapture = originalCapture;
  }
});

test("Close persists captures for every assignment across scoped saves", async () => {
  storedPrompt.assignments["a-second"] = new DrawingAssignment({
    id: "a-second", promptId: "p-save", userId: "u2", userName: "Bob",
    status: STATUS.SUBMITTED, assets: { overlayPath: "drawings/bob.webp" }
  });
  const closed = await closePrompt("p-save");
  for ( const id of ["a-saved", "a-second"] ) {
    assert.equal(closed.getAssignment(id).retainedCapture.kind, "full-submission");
    assert.equal(storedPrompt.assignments[id].retainedCapture.overlayPath,
      storedPrompt.assignments[id].assets.overlayPath);
  }
});

for ( const gap of ["capture response", "queued capture persistence", "failed capture response", "missing capture image"] ) {
  test(`Close preserves a newly accepted submission during ${gap}`, async () => {
    const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
    const { getPendingSubmission } = await import("../scripts/prompts/pending-submission.mjs");
    const assignment = storedPrompt.assignments["a-saved"];
    assignment.status = STATUS.OPENED;
    assignment.assets = {};
    assignment.delivery = { status: "received", generation: 0 };
    game.users.get("u1").active = true;
    const originalCapture = emit.requestRetainedCapture;
    const originalCancel = emit.cancelDrawingPrompt;
    let resolveCapture;
    let captureStarted;
    const captureRequested = new Promise(resolve => { captureStarted = resolve; });
    emit.requestRetainedCapture = (_user, assignmentId, requestId) => new Promise((resolve, reject) => {
      resolveCapture = () => gap === "failed capture response" ? reject(new Error("Capture unavailable"))
        : resolve({ requestId, assignmentId, submission: gap === "missing capture image" ? null : {
        mode: "staged", formats: { overlay: "webp" }, width: 512, height: 512,
        staged: { overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp" }, receiptTs: 1
      } });
      captureStarted();
    });
    const cancellations = [];
    emit.cancelDrawingPrompt = async (...args) => cancellations.push(args);
    let releaseSubmission;
    let submissionStarted;
    const submissionCommitting = new Promise(resolve => { submissionStarted = resolve; });
    const entry = game.journal.get("p-save");
    const originalSetFlag = entry.setFlag;
    if ( gap === "queued capture persistence" ) entry.setFlag = async (...args) => {
      if ( args[2].assignments["a-saved"].status === STATUS.SUBMITTED && !releaseSubmission ) {
        submissionStarted();
        await new Promise(resolve => { releaseSubmission = resolve; });
      }
      return originalSetFlag(...args);
    };
    try {
      const closing = closePrompt("p-save");
      await captureRequested;
      const submitted = getSocketHandlers().drawingSubmitted.call({ socketdata: { userId: "u1" } }, "a-saved", "u1", {
        mode: "staged", formats: { overlay: "webp" }, width: 512, height: 512,
        staged: { overlayPath: "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp" }
      });
      if ( gap === "queued capture persistence" ) await submissionCommitting;
      else await submitted;
      resolveCapture();
      if ( releaseSubmission ) { await new Promise(resolve => setImmediate(resolve)); releaseSubmission(); }
      await submitted;
      const closed = await closing;
      assert.equal(closed.getAssignment("a-saved").status, STATUS.SUBMITTED);
      assert.equal(storedPrompt.assignments["a-saved"].status, STATUS.SUBMITTED);
      assert.equal(storedPrompt.assignments["a-saved"].pendingSubmission.staged.overlayPath,
        "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp");
      assert.equal(getPendingSubmission("a-saved").staged.overlayPath,
        "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp");
      assert.deepEqual(cancellations, []);
    } finally {
      releaseSubmission?.();
      emit.requestRetainedCapture = originalCapture;
      emit.cancelDrawingPrompt = originalCancel;
    }
  });
}

test("Close retains both available previews and cancellations after reloading", async () => {
  const { loadPrompt } = await import("../scripts/prompts/persistence-service.mjs");
  storedPrompt.assignments["a-saved"].status = STATUS.OPENED;
  storedPrompt.assignments["a-second"] = new DrawingAssignment({
    id: "a-second", promptId: "p-save", userId: "u2", userName: "Bob", status: STATUS.OPENED
  });
  const picker = foundry.applications.apps.FilePicker;
  picker.createDirectory = async () => {};
  picker.upload = async (_source, dir, file) => ({ path: `${dir}/${file.name}` });
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const closed = await closePrompt("p-save", { closeWithoutCaptures: true,
    availablePreviews: { "a-saved": dataUrl, "a-second": dataUrl } });
  const reloaded = loadPrompt("p-save");
  for ( const id of ["a-saved", "a-second"] ) {
    for ( const prompt of [closed, reloaded] ) {
      assert.equal(prompt.getAssignment(id).status, STATUS.CANCELLED);
      assert.equal(prompt.getAssignment(id).retainedCapture.kind, "saved-preview");
      assert.ok(prompt.getAssignment(id).retainedCapture.overlayPath.includes(`/${id}/`));
    }
  }
});

test("Close upload cannot overwrite submission pixels accepted while capture upload is pending", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { getPendingSubmission } = await import("../scripts/prompts/pending-submission.mjs");
  storedPrompt.assignments["a-saved"].status = STATUS.OPENED;
  storedPrompt.assignments["a-saved"].assets = {};
  storedPrompt.assignments["a-saved"].delivery = { status: "received", generation: 0 };
  game.users.get("u1").active = true;
  const originalCapture = emit.requestRetainedCapture;
  const originalCancel = emit.cancelDrawingPrompt;
  const picker = foundry.applications.apps.FilePicker;
  const originalUpload = picker.upload;
  const originalCreateDirectory = picker.createDirectory;
  let release;
  let signal;
  const started = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const files = new Map();
  picker.createDirectory = async () => {};
  picker.upload = async (_source, dir, file) => {
    const pixels = new Uint8Array(await file.arrayBuffer())[0];
    if ( pixels === 65 ) { signal(); await gate; }
    const path = `${dir}/${file.name}`;
    files.set(path, pixels);
    return { path };
  };
  const image = value => ({ overlay: { dataUrl: `data:image/png;base64,${value}`, format: "png" }, width: 512, height: 512 });
  emit.requestRetainedCapture = async (_user, assignmentId, requestId) => ({
    requestId, assignmentId, submission: image("QQ==")
  });
  const cancelled = [];
  emit.cancelDrawingPrompt = async (...args) => cancelled.push(args);
  try {
    const closing = closePrompt("p-save");
    await started;
    await getSocketHandlers().drawingSubmitted.call({ socketdata: { userId: "u1" } }, "a-saved", "u1", image("Qg=="));
    const accepted = getPendingSubmission("a-saved");
    release();
    await closing;
    assert.equal(files.get(accepted.staged.overlayPath), 66, "accepted submission pixels remain unchanged");
    assert.equal(storedPrompt.assignments["a-saved"].status, STATUS.SUBMITTED);
    assert.equal(getPendingSubmission("a-saved").receiptTs, accepted.receiptTs);
    assert.deepEqual(cancelled, []);
  } finally {
    release();
    picker.upload = originalUpload;
    picker.createDirectory = originalCreateDirectory;
    emit.requestRetainedCapture = originalCapture;
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("player staged captures and submissions upload to distinct assignment-owned files", async () => {
  const { stageSubmissionImages } = await import("../scripts/prompts/asset-service.mjs");
  const picker = foundry.applications.apps.FilePicker;
  const originalUpload = picker.upload;
  game.user.can = () => true;
  picker.upload = async (_source, dir, file) => ({ path: `${dir}/${file.name}` });
  const image = { overlay: { dataUrl: "data:image/png;base64,QQ==", format: "png" },
    merged: { dataUrl: "data:image/png;base64,Qg==", format: "png" } };
  try {
    const submitted = await stageSubmissionImages("a-saved", image);
    const captured = await stageSubmissionImages("a-saved", image, { captureId: "request-1" });
    assert.notEqual(captured.overlayPath, submitted.overlayPath);
    assert.notEqual(captured.mergedPath, submitted.mergedPath);
    assert.match(captured.overlayPath, /\/a-saved-overlay-capture-request-1-upload-[A-Za-z0-9_-]+\.png$/);
    const nextSubmission = await stageSubmissionImages("a-saved", image);
    assert.notEqual(nextSubmission.overlayPath, submitted.overlayPath);
    const registry = game.settings.get(MODULE_ID, "fileCleanupRegistry");
    assert.equal(registry.records.length, 6);
    assert.ok(registry.records.every(record => record.path && record.attemptId));
    await assert.rejects(stageSubmissionImages("a-saved", image, { captureId: "../other" }), /Invalid capture id/);
  } finally {
    picker.upload = originalUpload;
  }
});

test("Close cancels every active assignment and reopen preserves cancellations", async () => {
  storedPrompt.assignments["a-saved"].status = STATUS.OPENED;
  storedPrompt.assignments["a-second"] = new DrawingAssignment({
    id: "a-second", promptId: "p-save", userId: "u2", userName: "Bob", status: STATUS.OPENED
  });
  await closePrompt("p-save", { closeWithoutCaptures: true });
  const reopened = await reopenPrompt("p-save");
  for ( const id of ["a-saved", "a-second"] ) {
    assert.equal(reopened.getAssignment(id).status, STATUS.CANCELLED);
    assert.equal(storedPrompt.assignments[id].status, STATUS.CANCELLED);
  }
});

test("Close captures reopened online work before reusing old saved or retained images", async () => {
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.status = STATUS.OPENED;
  assignment.retainedCapture = {
    kind: "full-submission", receiptTs: 1, width: 512, height: 512,
    overlayPath: "drawings/old-retained.webp", mergedPath: null
  };
  game.users.get("u1").active = true;
  const originalCapture = emit.requestRetainedCapture;
  const originalCancel = emit.cancelDrawingPrompt;
  const requests = [];
  emit.cancelDrawingPrompt = async () => {};
  emit.requestRetainedCapture = async (userId, assignmentId, requestId) => {
    requests.push([userId, assignmentId]);
    return { requestId, assignmentId, submission: {
      mode: "staged", formats: { overlay: "webp" }, staged: { overlayPath: "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp", mergedPath: null },
      width: 512, height: 512, receiptTs: 999_999
    } };
  };
  try {
    const closed = await closePrompt("p-save");
    assert.deepEqual(requests, [["u1", "a-saved"]]);
    assert.equal(closed.getAssignment("a-saved").retainedCapture.overlayPath, "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp");
    assert.equal(storedPrompt.assignments["a-saved"].retainedCapture.receiptTs, 999_999);
  } finally {
    emit.requestRetainedCapture = originalCapture;
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("Close rejects a correlated capture pointing outside its assignment folder", async () => {
  storedPrompt.assignments["a-saved"].status = STATUS.OPENED;
  game.users.get("u1").active = true;
  const originalCapture = emit.requestRetainedCapture;
  const originalCancel = emit.cancelDrawingPrompt;
  emit.cancelDrawingPrompt = async () => {};
  emit.requestRetainedCapture = async (_user, assignmentId, requestId) => ({
    requestId, assignmentId, submission: { mode: "staged", width: 512, height: 512,
      formats: { overlay: "webp" }, staged: { overlayPath: "worlds/test-world/unrelated.webp" } }
  });
  try {
    await assert.rejects(closePrompt("p-save"), error => error.code === "RETAINED_CAPTURE_FAILED");
    assert.equal(storedPrompt.assignments["a-saved"].retainedCapture, null);
    assert.deepEqual(deletedFiles, []);
  } finally {
    emit.requestRetainedCapture = originalCapture;
    emit.cancelDrawingPrompt = originalCancel;
  }
});

test("Close retains the newest full-quality pending work when its player is offline", async () => {
  const { setPendingSubmission } = await import("../scripts/prompts/pending-submission.mjs");
  storedPrompt.assignments["a-saved"].retainedCapture = {
    kind: "full-submission", receiptTs: 1, width: 512, height: 512,
    overlayPath: "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp"
  };
  setPendingSubmission("a-saved", { mode: "staged", formats: { overlay: "webp" },
    width: 512, height: 512, receiptTs: 999_999,
    staged: { overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp" } });
  await closePrompt("p-save");
  assert.equal(storedPrompt.assignments["a-saved"].retainedCapture.receiptTs, 999_999);
});

test("Delete never removes a recorded capture outside assignment-owned paths", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  storedPrompt.assignments["a-saved"].retainedCapture = {
    kind: "full-submission", overlayPath: "worlds/test-world/unrelated.webp"
  };
  await deletePrompt("p-save", { confirmed: true });
  assert.deepEqual(deletedFiles, []);
});

test("Delete durably retains correlated capture cleanup when the host cannot delete files", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const path = "worlds/test-world/drawing-prompts/pending/a-saved/overlay-capture-request_1.webp";
  storedPrompt.assignments["a-saved"].retainedCapture = { kind: "full-submission", overlayPath: path };
  await deletePrompt("p-save", { confirmed: true });
  await cleanup.reconcileFileCleanup();
  assert.equal(storedPrompt, null);
  assert.deepEqual(deletedFiles, []);
  assert.ok(cleanup.getOrphanFiles().some(record => record.path === path && record.status === "unsupported"));
});

test("Delete collects superseded and discarded captures while preserving exports and unrelated files", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const staging = "worlds/test-world/drawing-prompts/staging";
  const pending = "worlds/test-world/drawing-prompts/pending/a-saved";
  const superseded = `${staging}/a-saved-overlay-capture-old.webp`;
  const discarded = `${pending}/merged-capture-discarded.png`;
  const exported = `${staging}/a-saved-merged-capture-exported.webp`;
  storedPrompt.assignments["a-second"] = new DrawingAssignment({
    id: "a-second", promptId: "p-save", userId: "u2", status: STATUS.SUBMITTED,
    assets: { overlayPath: exported }
  });
  const picker = foundry.applications.apps.FilePicker;
  const originalBrowse = picker.browse;
  const browsed = [];
  picker.browse = async (_source, dir) => {
    browsed.push(dir);
    return { target: dir, dirs: [], files: dir === staging ? [superseded, exported,
      `${staging}/a-other-overlay-capture-request.webp`, `${staging}/a-saved-overlay.webp`,
      `${staging}/unrelated.webp`]
      : dir === pending ? [discarded, `${pending}/overlay.webp`] : [] };
  };
  try {
    await deletePrompt("p-save", { confirmed: true });
    await cleanup.reconcileFileCleanup({ retry: true });
    assert.deepEqual(deletedFiles, [], "legacy FilePicker.delete is never used");
    const tracked = cleanup.getOrphanFiles().map(record => record.path);
    assert.ok(tracked.includes(superseded));
    assert.ok(tracked.includes(discarded));
    assert.equal(tracked.includes(exported), false);
    assert.equal(tracked.some(path => path.includes("a-other") || path.includes("unrelated") || path.includes("../")), false);
    assert.ok(browsed.includes(staging));
    assert.ok(browsed.includes(pending));
  } finally {
    picker.browse = originalBrowse;
  }
});

for ( const failedDir of ["staging", "pending/a-saved"] ) test(`Delete preserves attribution for deferred ${failedDir} discovery`, async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const picker = foundry.applications.apps.FilePicker;
  const originalBrowse = picker.browse;
  let unavailable = true;
  const root = `worlds/test-world/drawing-prompts/${failedDir}`;
  const known = failedDir === "staging" ? `${root}/a-saved-overlay-capture-late.webp` : `${root}/overlay-capture-late.webp`;
  const unrelated = `${root}/a-other-overlay-capture-late.webp`;
  picker.browse = async (_source, dir) => {
    if ( dir === root && unavailable ) throw new Error("Discovery unavailable");
    return { target: dir, files: dir === root ? [known, unrelated] : [], dirs: ["worlds/test-world/drawing-prompts/staging", "worlds/test-world/drawing-prompts/pending/a-saved"] };
  };
  try {
    await deletePrompt("p-save", { confirmed: true });
    await cleanup.reconcileFileCleanup();
    assert.equal(storedPrompt, null);
    const registry = game.settings.get(MODULE_ID, "fileCleanupRegistry");
    assert.ok(registry.pendingScans?.some(context => context.assignmentId === "a-saved"), "attribution survives the deleted Prompt");
    unavailable = false;
    await cleanup.reconcileFileCleanup({ retry: true, scan: true });
    assert.deepEqual(game.settings.get(MODULE_ID, "fileCleanupRegistry").pendingScans, []);
    assert.ok(cleanup.getOrphanFiles().some(record => record.path === known));
    assert.equal(cleanup.getOrphanFiles().some(record => record.path === unrelated), false);
    assert.deepEqual(deletedFiles, []);
  } finally { picker.browse = originalBrowse; }
});

test("Delete accepts a confirmed missing pending folder", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const picker = foundry.applications.apps.FilePicker;
  const originalBrowse = picker.browse;
  picker.browse = async (_source, dir) => {
    if ( dir.endsWith("pending/a-saved") ) throw new Error("Missing folder");
    return { files: [], dirs: [] };
  };
  try {
    await deletePrompt("p-save", { confirmed: true });
    assert.equal(storedPrompt, null);
  } finally { picker.browse = originalBrowse; }
});

test("Delete succeeds without a deletion API and Refresh clears fallback after manual cleanup", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const path = "worlds/test-world/drawing-prompts/pending/a-saved/overlay-capture-request.webp";
  storedPrompt.assignments["a-saved"].retainedCapture = { kind: "full-submission", overlayPath: path };
  const picker = foundry.applications.apps.FilePicker;
  const originalDelete = picker.delete;
  const originalBrowse = picker.browse;
  let files = [path];
  picker.delete = undefined;
  picker.browse = async (_source, dir) => ({ target: dir, files, dirs: [] });
  try {
    await deletePrompt("p-save", { confirmed: true });
    await cleanup.reconcileFileCleanup();
    assert.equal(storedPrompt, null);
    assert.ok(cleanup.getOrphanFiles().some(record => record.path === path));
    assert.deepEqual(deletedFiles, []);
    files = [];
    await cleanup.refreshOrphanFiles();
    assert.deepEqual(cleanup.getOrphanFiles(), []);
  } finally { picker.delete = originalDelete; picker.browse = originalBrowse; }
});

test("Delete confirms a removed single-segment custom asset folder through the data root", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const picker = foundry.applications.apps.FilePicker;
  const originalBrowse = picker.browse;
  game.settings.values.set("assetFolder", "art");
  const browsed = [];
  picker.browse = async (_source, dir) => {
    browsed.push(dir);
    if ( dir ) throw new Error("Missing folder");
    return { target: dir, files: [], dirs: ["worlds"] };
  };
  try {
    await deletePrompt("p-save", { confirmed: true });
    await cleanup.reconcileFileCleanup({ retry: true });
    assert.equal(storedPrompt, null);
    assert.ok(browsed.includes(""), "successful root listing proves custom folder is absent");
  } finally { picker.browse = originalBrowse; }
});

test("Archived assignment cannot reopen before Restore", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.ARCHIVED;
  const before = structuredClone(storedPrompt);
  await assert.rejects(reopenAssignment("a-saved"), /archived Prompt/);
  assert.deepEqual(structuredClone(storedPrompt), before);
});

test("Prompt lifecycle archives Closed Prompts and restores them", async () => {
  await assert.rejects(() => archivePrompt("p-save"), /Illegal transition/);
  await closePrompt("p-save");
  const archived = await archivePrompt("p-save");
  assert.equal(archived.lifecycleStatus, PROMPT_STATUS.ARCHIVED);
  const restored = await restorePrompt("p-save");
  assert.equal(restored.lifecycleStatus, PROMPT_STATUS.CLOSED);
});

test("Prompt lifecycle archives Draft Prompts and restores them as Draft", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.DRAFT;
  storedPrompt.assignments = {};
  const archived = await archivePrompt("p-save");
  assert.equal(archived.lifecycleStatus, PROMPT_STATUS.ARCHIVED);
  assert.equal(archived.archivedFromStatus, PROMPT_STATUS.DRAFT);
  const restored = await restorePrompt("p-save");
  assert.equal(restored.lifecycleStatus, PROMPT_STATUS.DRAFT);
});

test("Delete requires explicit confirmation and removes the Prompt entry", async () => {
  assert.equal(await deletePrompt("p-save", { confirmed: false }), false);
  assert.notEqual(storedPrompt, null);
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  assert.equal(await deletePrompt("p-save", { confirmed: true }), true);
  assert.equal(storedPrompt, null);
  assert.deepEqual(game.settings.get("drawing-prompts", "recoveryTombstones"), [{
    worldId: "test-world", gmUserId: "gm1", userId: "u1", assignmentId: "a-saved", promptId: "p-save", width: 512, height: 512
  }]);
});

test("Registry write failure preserves the Prompt and does not queue Recovery cleanup", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const originalSet = game.settings.set;
  storedPrompt.assignments["a-saved"].retainedCapture = {
    kind: "saved-preview", overlayPath: "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp"
  };
  game.settings.set = async function(moduleId, key, value) {
    if ( key === "fileCleanupRegistry" ) throw new Error("simulated registry write failure");
    return originalSet.call(this, moduleId, key, value);
  };
  try {
    await assert.rejects(() => deletePrompt("p-save", { confirmed: true }), /simulated registry write failure/);
    assert.notEqual(storedPrompt, null);
    assert.deepEqual(game.settings.get("drawing-prompts", "recoveryTombstones"), []);
  } finally {
    game.settings.set = originalSet;
  }
});

test("Delete rejects Open Prompts with the close-first message", async () => {
  await assert.rejects(
    () => deletePrompt("p-save", { confirmed: true }),
    /Cannot delete an open prompt\. Please close from the Prompt Manager and try again\./
  );
  assert.notEqual(storedPrompt, null);
});

test("Recovery tombstones clear on the player's next connection acknowledgement", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
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

test("Delete tracks only recorded internal files and permanently preserves exported assets", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const assignment = storedPrompt.assignments["a-saved"];
  assignment.pendingSubmission = { staged: {
    overlayPath: "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp",
    mergedPath: "worlds/test-world/drawing-prompts/staging/a-saved-merged.webp"
  } };
  assignment.retainedCapture = {
    kind: "saved-preview", overlayPath: "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp"
  };
  assignment.assets.overlayPath = "drawings/exported.webp";

  await deletePrompt("p-save", { confirmed: true });
  await cleanup.reconcileFileCleanup();
  assert.deepEqual(cleanup.getOrphanFiles().map(record => record.path).sort(), [
    "worlds/test-world/drawing-prompts/staging/a-saved-merged.webp",
    "worlds/test-world/drawing-prompts/staging/a-saved-overlay.webp",
    "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp"
  ].sort());
  assert.deepEqual(deletedFiles, []);
  assert.ok(game.settings.get(MODULE_ID, "fileCleanupRegistry").exports.includes("drawings/exported.webp"));
});

test("Delete preserves internal paths referenced by scene textures and Revert metadata", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const first = "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp";
  const second = "worlds/test-world/drawing-prompts/staging/a-saved-merged.webp";
  storedPrompt.assignments["a-saved"].retainedCapture = { kind: "full-submission", overlayPath: first, mergedPath: second };
  game.scenes = [{ toObject: () => ({ tiles: [{ texture: { src: first } }], tokens: [{ flags: { [MODULE_ID]: { originalTexture: second } } }] }) }];
  await deletePrompt("p-save", { confirmed: true });
  await cleanup.reconcileFileCleanup();
  assert.equal(storedPrompt, null);
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  assert.deepEqual(deletedFiles, []);
  assert.equal(game.settings.get(MODULE_ID, "fileCleanupRegistry").records.length, 2);
});

test("Prompt document deletion failure leaves registered captures protected", async () => {
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  const path = "worlds/test-world/drawing-prompts/pending/a-saved/overlay.webp";
  storedPrompt.assignments["a-saved"].retainedCapture = { kind: "full-submission", overlayPath: path };
  game.journal.get("p-save").delete = async () => { throw new Error("Document deletion failed"); };
  await assert.rejects(deletePrompt("p-save", { confirmed: true }), /Document deletion failed/);
  await cleanup.reconcileFileCleanup();
  assert.ok(storedPrompt);
  assert.deepEqual(cleanup.getOrphanFiles(), []);
  assert.deepEqual(deletedFiles, []);
  assert.deepEqual(game.settings.get(MODULE_ID, "recoveryTombstones"), []);
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
  storedPrompt.lifecycleStatus = PROMPT_STATUS.CLOSED;
  storedPrompt.timerStatus = "paused";
  storedPrompt.deadlineAt = null;
  storedPrompt.remainingMs = 20_000;
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
    assert.equal(storedPrompt.lifecycleStatus, PROMPT_STATUS.OPEN, "reopening one Assignment reopens its owning Prompt");
    assert.equal(storedPrompt.timerStatus, "paused");
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
