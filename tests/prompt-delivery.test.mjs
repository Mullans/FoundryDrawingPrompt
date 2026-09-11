import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

let lifecycle, delivery, emit, models, stored, entries, sequence;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

before(async () => {
  globalThis.foundry = { applications: { api: {
    ApplicationV2: class {}, DialogV2: class {}, HandlebarsApplicationMixin: Base => class extends Base {}
  } }, utils: { randomID: () => `a${++sequence}` } };
  lifecycle = await import("../scripts/prompts/prompt-lifecycle.mjs");
  delivery = await import("../scripts/prompts/prompt-delivery.mjs");
  models = await import("../scripts/prompts/prompt-models.mjs");
  ({ emit } = await import("../scripts/socket.mjs"));
});
beforeEach(() => {
  sequence = 0; entries = new Map(); stored = null;
  globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
  globalThis.Hooks = { callAll() {} };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: new Map([ ["u1", { id: "u1", name: "Ada", active: true, can: () => false }],
      ["u2", { id: "u2", name: "Ben", active: true, can: () => false }] ]),
    journal: { get: id => entries.get(id), [Symbol.iterator]: function* () { yield* entries.values(); } },
    folders: [{ id: "folder", name: "DRAWING-PROMPTS.journal.folderName", type: "JournalEntry" }],
    i18n: { localize: key => key, format: key => key }
  };
  globalThis.JournalEntry = { create: async () => {
    const entry = { id: `p${entries.size}`, getFlag: () => stored,
      setFlag: async (_m, _f, value) => { stored = structuredClone(value); return entry; },
      delete: async () => entries.delete(entry.id) };
    entries.set(entry.id, entry); return entry;
  } };
});
const draft = { canvasWidth: 512, canvasHeight: 512, selectedUserIds: ["u1"], timerSeconds: 60 };

test("awaitDeliveries false returns while the actual OPEN transport is unresolved", async () => {
  let release;
  emit.openDrawingPrompt = () => new Promise(resolve => { release = resolve; });
  const sending = lifecycle.sendPrompt({ ...draft, awaitDeliveries: false });
  const result = await Promise.race([sending.then(() => "returned"), new Promise(resolve => setTimeout(() => resolve("blocked"), 30))]);
  const prompt = await sending;
  await new Promise(resolve => setImmediate(resolve));
  await delivery.acknowledgePromptDelivery("u1", Object.keys(prompt.assignments)[0], "u1");
  release?.();
  assert.equal(result, "returned");
});

test("default awaited delivery resolves on automatic receipt without waiting for OPEN rendering", async () => {
  emit.openDrawingPrompt = async (_user, payload) => {
    await delivery.acknowledgePromptDelivery("u1", payload.assignment.id, "u1");
    return new Promise(() => {});
  };
  const prompt = await lifecycle.sendPrompt(draft);
  assert.equal(prompt.deliverySummary.received.length, 1);
  assert.equal(prompt.deliverySummary.isSending, false);
  assert.equal(stored.assignments.a1.delivery.status, "received");
});

test("sendPrompt opens a saved Draft in place and emits promptSent only after receipt", async () => {
  const hooks = [];
  globalThis.Hooks = { callAll: name => hooks.push(name) };
  const saved = await lifecycle.createPrompt({ ...draft, promptName: "Saved for later" });
  assert.equal(saved.lifecycleStatus, "draft");
  assert.deepEqual(saved.assignments, {});
  emit.openDrawingPrompt = async (_user, payload) => {
    await delivery.acknowledgePromptDelivery("u1", payload.assignment.id, "u1");
  };
  const sent = await lifecycle.sendPrompt(saved.id);
  assert.equal(sent.id, saved.id);
  assert.equal(sent.lifecycleStatus, "open");
  assert.equal(Object.keys(sent.assignments).length, 1);
  assert.ok(hooks.indexOf("drawing-prompts.promptCreated") < hooks.indexOf("drawing-prompts.promptSent"));
});

test("initial receipts wait for every delivery to settle and the timer starts at release", async () => {
  let firstReceipt;
  let firstReceiptResolved = false;
  let dispatched = 0;
  const bothDispatched = deferred();
  emit.openDrawingPrompt = (userId, payload) => {
    dispatched++;
    if ( dispatched === 2 ) bothDispatched.resolve();
    if ( userId === "u1" ) {
      firstReceipt = delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId)
        .then(result => { firstReceiptResolved = true; return result; });
      return firstReceipt;
    }
    return new Promise(() => {});
  };
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const timers = [];
  const firstTimerCleared = deferred();
  let now = 1_000_000;
  globalThis.setTimeout = fn => {
    const handle = { fn, cleared: false };
    timers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = handle => {
    handle.cleared = true;
    if ( handle === timers[0] ) firstTimerCleared.resolve();
  };
  Date.now = () => now;
  try {
    const sending = lifecycle.sendPrompt({ ...draft, selectedUserIds: ["u1", "u2"] });
    await bothDispatched.promise;
    await firstTimerCleared.promise;
    assert.equal(firstReceiptResolved, false, "a successful recipient must remain gated while another invitation is unresolved");
    assert.equal(stored.timerStatus, "paused");
    assert.equal(stored.deadlineAt, null);
    assert.equal(stored.remainingMs, 60_000);

    now = 1_005_000;
    timers.find(handle => !handle.cleared).fn();
    const prompt = await sending;
    const receipt = await firstReceipt;
    assert.equal(receipt.accepted, true);
    assert.equal(firstReceiptResolved, true);
    assert.equal(prompt.deliverySummary.received.length, 1);
    assert.equal(prompt.deliverySummary.failed.length, 1);
    assert.equal(prompt.timerStatus, "running");
    assert.equal(prompt.deadlineAt, 1_065_000, "the initial delivery wait must not consume drawing time");
    assert.equal(receipt.timerState.deadlineAt, prompt.deadlineAt);
  } finally {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
  }
});

test("unconfirmed dispatch completion is bounded, Retry keeps identity, and repeated Retry shares one attempt", async () => {
  emit.openDrawingPrompt = async () => {};
  // Set up through real lifecycle, then drive the next bounded attempt through the delivery service.
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, Math.min(ms, 15), ...args);
  try {
    const prompt = await lifecycle.sendPrompt(draft);
    assert.deepEqual(prompt.deliverySummary.failed.map(a => a.userName), ["Ada"]);
    let calls = 0;
    emit.openDrawingPrompt = async (_user, payload) => {
      calls++;
      await delivery.acknowledgePromptDelivery("u1", payload.assignment.id, "u1");
    };
    const [first, second] = await Promise.all([lifecycle.retryPromptDeliveries(prompt.id), lifecycle.retryPromptDeliveries(prompt.id)]);
    assert.equal(calls, 1);
    assert.equal(first.deliverySummary.received[0].assignmentId, "a1");
    assert.equal(second.deliverySummary.received[0].assignmentId, "a1");
    assert.equal(Object.keys(stored.assignments).length, 1);
    assert.equal(first.timerStatus, "running", "the first successful Retry must start a timer held by zero initial receipts");
    assert.ok(Number.isFinite(first.deadlineAt));
  } finally { globalThis.setTimeout = originalTimeout; }
});

test("Continue withdraws missing invitation, late authenticated contact fails, reinvitation uses a fresh id and deadline", async () => {
  emit.openDrawingPrompt = async (userId, payload) => {
    if ( userId === "u1" ) await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
    else throw new Error("offline transport");
  };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.sendPrompt({ ...draft, selectedUserIds: ["u1", "u2"] });
  const deadline = prompt.deadlineAt;
  const continued = await lifecycle.continuePromptDeliveries(prompt.id);
  assert.equal(continued.deliverySummary.received.length, 1);
  assert.equal(continued.assignmentForUser("u2"), null);
  assert.deepEqual(await delivery.acknowledgePromptDelivery("u2", "a2", "u2"), { accepted: false, reason: "invalid-invitation" });
  emit.openDrawingPrompt = async (userId, payload) => {
    assert.equal(payload.prompt.deadlineAt, deadline);
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  };
  const reinvited = await lifecycle.invitePromptRecipients(prompt.id, ["u2"]);
  assert.equal(reinvited.assignmentForUser("u2").id, "a3");
  assert.equal(reinvited.deliverySummary.received.length, 2);
  assert.equal(reinvited.getAssignment("a2").delivery.status, "withdrawn");
  assert.equal(reinvited.deadlineAt, deadline);
});

test("zero-success Continue retains a saved Draft and rejects late receipt", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("transport unavailable"); };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.sendPrompt(draft);
  const continued = await lifecycle.continuePromptDeliveries(prompt.id);
  assert.equal(continued.deliverySummary.hasRecipients, false);
  assert.equal(entries.size, 1);
  assert.equal(continued.lifecycleStatus, "draft");
  assert.deepEqual(continued.assignments, {});
  assert.deepEqual(await delivery.acknowledgePromptDelivery("u1", "a1", "u1"), { accepted: false, reason: "invalid-invitation" });
});

test("offline invitations enter the standard delivery warning flow while GM recipients remain invalid", async () => {
  game.users.get("u1").active = false;
  const offline = await lifecycle.sendPrompt(draft);
  assert.equal(offline.deliverySummary.failed[0].status, "failed");
  assert.equal(Object.values(offline.assignments)[0].delivery.error, "offline");
  assert.equal(entries.size, 1);
  entries.clear(); stored = null;
  game.users.get("u1").active = true;
  game.users.get("u1").isGM = true;
  await assert.rejects(lifecycle.sendPrompt(draft), /onlineRecipientsRequired/);
  game.users.get("u1").isGM = false;
  emit.openDrawingPrompt = async (userId, payload) => delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  const prompt = await lifecycle.sendPrompt(draft);
  game.users.get("u1").active = false;
  await delivery.deliverPromptAssignments(prompt);
  assert.equal(prompt.deliverySummary.received.length, 1);
});

test("receipt authorization rejects spoofed wire identity and unknown initiator", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("failed"); };
  const prompt = await lifecycle.sendPrompt(draft);
  for ( const [initiator, claimed] of [["u2", "u1"], [null, "u1"], ["u1", "u2"]] ) {
    assert.equal((await delivery.acknowledgePromptDelivery(initiator, "a1", claimed)).accepted, false);
  }
  assert.equal(prompt.deliverySummary.hasRecipients, false);
});

test("framing failure removes the prompt before any invitation is dispatched", async () => {
  let dispatched = false;
  emit.openDrawingPrompt = async () => { dispatched = true; };
  globalThis.Image = class { constructor() { throw new Error("Image unavailable"); } };
  await assert.rejects(lifecycle.sendPrompt({ ...draft, background: { sourceType: "file", path: "unavailable.webp" } }), /Image unavailable/);
  assert.equal(entries.size, 0);
  assert.equal(dispatched, false);
});

test("inviting another player during an existing attempt dispatches the additional assignment", async () => {
  let firstPayload;
  emit.openDrawingPrompt = async (userId, payload) => {
    if ( userId === "u1" ) { firstPayload = payload; return; }
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  };
  const prompt = await lifecycle.sendPrompt({ ...draft, awaitDeliveries: false });
  await new Promise(resolve => setImmediate(resolve));
  const invitation = lifecycle.invitePromptRecipients(prompt.id, ["u2"]);
  await delivery.acknowledgePromptDelivery("u1", firstPayload.assignment.id, "u1");
  const result = await invitation;
  assert.deepEqual(result.deliverySummary.received.map(a => a.userName).sort(), ["Ada", "Ben"]);
});

test("client cancellation during automatic receipt prevents a late OPEN window", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
  const { getAssignment } = await import("../scripts/prompts/client-store.mjs");
  const { CALLS } = await import("../scripts/socket.mjs");
  let release;
  emit.assignmentReceived = () => new Promise(resolve => { release = resolve; });
  game.user = { id: "u1", isGM: false };
  game.settings = { get: () => true };
  let windowsOpened = 0;
  const originalOpen = PlayerDrawingApp.open;
  const originalClose = PlayerDrawingApp.closeAssignment;
  PlayerDrawingApp.open = async () => { windowsOpened++; };
  PlayerDrawingApp.closeAssignment = async () => {};
  try {
    const handlers = getSocketHandlers();
    const context = { socketdata: { userId: "gm" } };
    const opening = handlers[CALLS.OPEN].call(context, {
      prompt: { id: "race-prompt", gmUserId: "gm" }, assignment: { id: "race-assignment", userId: "u1", status: "pending" }
    });
    await handlers[CALLS.CANCEL].call(context, "race-assignment");
    release({ accepted: true, timerState: {} });
    await opening;
    assert.equal(getAssignment("race-assignment").assignment.status, "cancelled");
    assert.equal(windowsOpened, 0);
  } finally { PlayerDrawingApp.open = originalOpen; PlayerDrawingApp.closeAssignment = originalClose; }
});

test("Recovery cleanup accepts only the Prompt's owning GM", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
  const { saveRecoveryCopy } = await import("../scripts/drawing/recovery-copy.mjs");
  const { CALLS } = await import("../scripts/socket.mjs");
  const priorUser = game.user;
  const priorStorage = globalThis.localStorage;
  const records = new Map();
  const removed = [];
  game.user = { id: "u1", isGM: false };
  globalThis.localStorage = {
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: key => { removed.push(key); records.delete(key); }
  };
  const identity = {
    worldId: "world", gmUserId: "gm-owner", userId: "u1",
    assignmentId: "assignment", promptId: "prompt", width: 512, height: 512
  };
  try {
    const originalClear = PlayerDrawingApp.clearRecoveryForIdentity;
    PlayerDrawingApp.clearRecoveryForIdentity = async () => {};
    saveRecoveryCopy(identity, { ops: [{ type: "clear", id: "clear", ts: 1 }], pointer: 1 });
    const handler = getSocketHandlers()[CALLS.CLEAR_RECOVERY];
    const forged = { ...identity, gmUserId: "gm-other" };
    assert.equal(await handler.call({ socketdata: { userId: "gm-other" } }, forged), false);
    assert.deepEqual(removed, []);
    assert.equal(await handler.call({ socketdata: { userId: "gm-owner" } }, identity), true);
    assert.equal(removed.length, 1);
    PlayerDrawingApp.clearRecoveryForIdentity = originalClear;
  } finally {
    game.user = priorUser;
    if ( priorStorage === undefined ) delete globalThis.localStorage;
    else globalThis.localStorage = priorStorage;
  }
});

test("GM Cancel then Resend advances the invitation and opens the player window without reviving old OPEN", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
  const { CALLS } = await import("../scripts/socket.mjs");
  let payload;
  emit.openDrawingPrompt = async (userId, wire) => {
    payload = structuredClone(wire);
    await delivery.acknowledgePromptDelivery(userId, wire.assignment.id, userId, wire.assignment.delivery.generation);
  };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.sendPrompt(draft);
  const originalPayload = structuredClone(payload);
  const gm = game.user;
  const originalOpen = PlayerDrawingApp.open;
  const originalClose = PlayerDrawingApp.closeAssignment;
  let windowsOpened = 0;
  PlayerDrawingApp.open = async () => { windowsOpened++; };
  PlayerDrawingApp.closeAssignment = async () => {};
  game.settings = { get: () => true };
  const handlers = getSocketHandlers();
  const context = { socketdata: { userId: "gm" } };
  try {
    game.user = { id: "u1", isGM: false };
    emit.assignmentReceived = async () => ({ accepted: true, timerState: {} });
    await handlers[CALLS.OPEN].call(context, originalPayload);
    assert.equal(windowsOpened, 1);
    game.user = gm;
    await lifecycle.cancelAssignment("a1");
    game.user = { id: "u1", isGM: false };
    await handlers[CALLS.CANCEL].call(context, "a1", 0);
    emit.assignmentReceived = async () => ({ accepted: false, reason: "invalid-invitation" });
    await handlers[CALLS.OPEN].call(context, originalPayload);
    assert.equal(windowsOpened, 1);
    game.user = gm;
    await lifecycle.resendAssignment("a1");
    assert.equal(payload.assignment.delivery.generation, 1);
    game.user = { id: "u1", isGM: false };
    emit.assignmentReceived = async () => ({ accepted: true, timerState: {} });
    await handlers[CALLS.OPEN].call(context, payload);
    assert.equal(windowsOpened, 2);
    await handlers[CALLS.OPEN].call(context, originalPayload);
    await handlers[CALLS.CANCEL].call(context, "a1", 0);
    assert.equal(windowsOpened, 2);
    const { getAssignment } = await import("../scripts/prompts/client-store.mjs");
    assert.equal(getAssignment("a1").assignment.status, "pending");
  } finally { PlayerDrawingApp.open = originalOpen; PlayerDrawingApp.closeAssignment = originalClose; game.user = gm; }
});

test("a delayed duplicate OPEN cannot cancel or close an established submission", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
  const { upsertAssignment, getAssignment } = await import("../scripts/prompts/client-store.mjs");
  const { CALLS } = await import("../scripts/socket.mjs");
  game.user = { id: "u1", isGM: false };
  upsertAssignment({ prompt: { id: "submitted-p", gmUserId: "gm" }, assignment: {
    id: "submitted-a", userId: "u1", status: "submitted", delivery: { status: "received", generation: 0 }
  } });
  emit.assignmentReceived = async () => ({ accepted: false, reason: "invalid-invitation" });
  const originalClose = PlayerDrawingApp.closeAssignment;
  let closed = false;
  let warned = false;
  ui.notifications.warn = () => { warned = true; };
  PlayerDrawingApp.closeAssignment = async () => { closed = true; };
  try {
    await getSocketHandlers()[CALLS.OPEN].call({ socketdata: { userId: "gm" } }, {
      prompt: { id: "submitted-p", gmUserId: "gm" }, assignment: { id: "submitted-a", userId: "u1", status: "pending", delivery: { generation: 0 } }
    });
    assert.equal(getAssignment("submitted-a").assignment.status, "submitted");
    assert.equal(closed, false);
    assert.equal(warned, false);
  } finally { PlayerDrawingApp.closeAssignment = originalClose; }
});

test("receipt distinguishes an inactive established assignment from a withdrawn invitation", async () => {
  emit.openDrawingPrompt = async (userId, payload) => delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  await lifecycle.sendPrompt(draft);
  stored.assignments.a1.status = "submitted";
  assert.deepEqual(await delivery.acknowledgePromptDelivery("u1", "a1", "u1"), { accepted: false, reason: "inactive-assignment" });
  assert.deepEqual(await delivery.acknowledgePromptDelivery("u1", "a1", "u1", 1), { accepted: false, reason: "stale-invitation" });
});

test("assignmentSent fires once per confirmed attempt including retry and ignores duplicate acknowledgements", async () => {
  const sent = [];
  Hooks.callAll = (event, prompt, assignment) => {
    if ( event === "drawing-prompts.assignmentSent" ) sent.push([prompt.id, assignment.id]);
  };
  emit.openDrawingPrompt = async (userId, payload) => {
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  };
  const prompt = await lifecycle.sendPrompt(draft);
  assert.deepEqual(sent, [[prompt.id, "a1"]]);
  await lifecycle.resendAssignment("a1");
  assert.deepEqual(sent, [[prompt.id, "a1"], [prompt.id, "a1"]]);
});

test("resendAll restarts every cancelled assignment after persistence replaces the assignment map", async () => {
  const dispatched = [];
  emit.openDrawingPrompt = async (userId, payload) => {
    dispatched.push([payload.assignment.id, payload.assignment.delivery.generation]);
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId, payload.assignment.delivery.generation);
  };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.sendPrompt({ ...draft, selectedUserIds: ["u1", "u2"] });
  await lifecycle.cancelAllAssignments(prompt.id);
  dispatched.length = 0;
  await lifecycle.resendAllAssignments(prompt.id);
  assert.deepEqual(dispatched.sort(), [["a1", 1], ["a2", 1]]);
  for ( const assignment of Object.values(stored.assignments) ) {
    assert.equal(assignment.status, "pending");
    assert.equal(assignment.delivery.generation, 1);
  }
});

test("delayed resent OPEN after a second GM cancellation cannot install an active client assignment", async () => {
  const { getSocketHandlers } = await import("../scripts/prompts/prompt-socket-handlers.mjs");
  const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
  const { upsertAssignment, getAssignment } = await import("../scripts/prompts/client-store.mjs");
  const { CALLS } = await import("../scripts/socket.mjs");
  game.user = { id: "u1", isGM: false };
  upsertAssignment({ prompt: { id: "twice-p", gmUserId: "gm" }, assignment: {
    id: "twice-a", userId: "u1", status: "cancelled", delivery: { status: "received", generation: 0 }
  } });
  emit.assignmentReceived = async () => ({ accepted: false, reason: "inactive-assignment" });
  const originalOpen = PlayerDrawingApp.open;
  const originalClose = PlayerDrawingApp.closeAssignment;
  let opened = false;
  PlayerDrawingApp.open = async () => { opened = true; };
  PlayerDrawingApp.closeAssignment = async () => {};
  try {
    const response = await getSocketHandlers()[CALLS.OPEN].call({ socketdata: { userId: "gm" } }, {
      prompt: { id: "twice-p", gmUserId: "gm" }, assignment: {
        id: "twice-a", userId: "u1", status: "pending", delivery: { status: "received", generation: 1 }
      }
    });
    assert.equal(response.reason, "inactive-assignment");
    assert.equal(getAssignment("twice-a").assignment.status, "cancelled");
    assert.equal(opened, false);
  } finally { PlayerDrawingApp.open = originalOpen; PlayerDrawingApp.closeAssignment = originalClose; }
});

for ( const interruptedStatus of ["pending", "sending"] ) {
  test(`GM reload makes persisted ${interruptedStatus} invitations actionable without inventing receipt`, async () => {
    emit.openDrawingPrompt = async () => { throw new Error("transport unavailable"); };
    const prompt = await lifecycle.sendPrompt(draft);
    stored.assignments.a1.delivery.status = interruptedStatus;
    const { loadPrompt } = await import("../scripts/prompts/persistence-service.mjs");
    assert.equal(loadPrompt(prompt.id).deliverySummary.needsResolution, false);
    await delivery.recoverInterruptedPromptDeliveries();
    const reloaded = loadPrompt(prompt.id);
    assert.equal(reloaded.deliverySummary.needsResolution, true, "reload left Retry/Continue unavailable");
    assert.equal(reloaded.deliverySummary.isSending, false);
    assert.equal(reloaded.deliverySummary.hasRecipients, false);
    assert.equal(reloaded.getAssignment("a1").delivery.error, "interrupted");
  });
}

test("rejected receipt authorization is logged without accepting the forged identity", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("unavailable"); };
  await lifecycle.sendPrompt(draft);
  const originalDebug = console.debug;
  const logs = [];
  console.debug = (...args) => logs.push(args);
  try {
    assert.equal((await delivery.acknowledgePromptDelivery("u2", "a1", "u1")).accepted, false);
    assert.equal(logs.length, 1, "authorization rejection must be logged and dropped");
  } finally { console.debug = originalDebug; }
});

test("startup reconciliation leaves live delivery deadlines in control", async () => {
  let wire;
  emit.openDrawingPrompt = async (_userId, payload) => { wire = payload; };
  const prompt = await lifecycle.sendPrompt({ ...draft, awaitDeliveries: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stored.assignments.a1.delivery.status, "sending");
  await delivery.recoverInterruptedPromptDeliveries();
  assert.equal(stored.assignments.a1.delivery.status, "sending");
  assert.equal(stored.assignments.a1.delivery.error, null);
  await delivery.acknowledgePromptDelivery("u1", wire.assignment.id, "u1");
  assert.equal(prompt.deliverySummary.received.length, 1);
});

test("recovery preserves confirmed membership and ignores another GM's unresolved invitations", async () => {
  emit.openDrawingPrompt = async (userId, payload) => delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  await lifecycle.sendPrompt(draft);
  await delivery.recoverInterruptedPromptDeliveries();
  assert.equal(stored.assignments.a1.delivery.status, "received");
  stored.gmUserId = "other-gm";
  stored.assignments.a1.delivery.status = "sending";
  await delivery.recoverInterruptedPromptDeliveries();
  assert.equal(stored.assignments.a1.delivery.status, "sending");
});

test("Retry queues behind startup reconciliation and reuses the interrupted assignment", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("unavailable"); };
  const prompt = await lifecycle.sendPrompt(draft);
  stored.assignments.a1.delivery.status = "pending";
  const entry = entries.get(prompt.id);
  const originalSave = entry.setFlag;
  let release;
  let first = true;
  entry.setFlag = async (...args) => {
    if ( first ) { first = false; await new Promise(resolve => { release = resolve; }); }
    return originalSave(...args);
  };
  const recovering = delivery.recoverInterruptedPromptDeliveries();
  await new Promise(resolve => setImmediate(resolve));
  emit.openDrawingPrompt = async (userId, payload) => delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  const retrying = lifecycle.retryPromptDeliveries(prompt.id);
  release();
  await recovering;
  const retried = await retrying;
  assert.equal(retried.deliverySummary.received[0].assignmentId, "a1");
  assert.equal(stored.assignments.a1.delivery.error, null);
});
