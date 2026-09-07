import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

let lifecycle, delivery, emit, models, stored, entries, sequence;
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
  const sending = lifecycle.createAndSendPrompt({ ...draft, awaitDeliveries: false });
  const result = await Promise.race([sending.then(() => "returned"), new Promise(resolve => setTimeout(() => resolve("blocked"), 30))]);
  const prompt = await sending;
  await new Promise(resolve => setImmediate(resolve));
  await delivery.acknowledgePromptDelivery("u1", Object.keys(prompt.assignments)[0], "u1");
  release?.();
  await delivery.deliverPromptAssignments(prompt);
  assert.equal(result, "returned");
});

test("default awaited delivery resolves on automatic receipt without waiting for OPEN rendering", async () => {
  emit.openDrawingPrompt = async (_user, payload) => {
    await delivery.acknowledgePromptDelivery("u1", payload.assignment.id, "u1");
    return new Promise(() => {});
  };
  const prompt = await lifecycle.createAndSendPrompt(draft);
  assert.equal(prompt.deliverySummary.received.length, 1);
  assert.equal(prompt.deliverySummary.isSending, false);
  assert.equal(stored.assignments.a1.delivery.status, "received");
});

test("unconfirmed dispatch completion is bounded, Retry keeps identity, and repeated Retry shares one attempt", async () => {
  emit.openDrawingPrompt = async () => {};
  // Set up through real lifecycle, then drive the next bounded attempt through the delivery service.
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, Math.min(ms, 15), ...args);
  try {
    const prompt = await lifecycle.createAndSendPrompt(draft);
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
  } finally { globalThis.setTimeout = originalTimeout; }
});

test("Continue withdraws missing invitation, late authenticated contact fails, reinvitation uses a fresh id and deadline", async () => {
  emit.openDrawingPrompt = async (userId, payload) => {
    if ( userId === "u1" ) await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
    else throw new Error("offline transport");
  };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.createAndSendPrompt({ ...draft, selectedUserIds: ["u1", "u2"] });
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

test("zero-success Continue removes the orphan prompt and rejects late receipt", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("transport unavailable"); };
  emit.cancelDrawingPrompt = async () => {};
  const prompt = await lifecycle.createAndSendPrompt(draft);
  const continued = await lifecycle.continuePromptDeliveries(prompt.id);
  assert.equal(continued.deliverySummary.hasRecipients, false);
  assert.equal(entries.size, 0);
  assert.deepEqual(await delivery.acknowledgePromptDelivery("u1", "a1", "u1"), { accepted: false, reason: "invalid-invitation" });
});

test("new offline/GM invitations fail before persistence while received membership survives disconnect", async () => {
  game.users.get("u1").active = false;
  await assert.rejects(lifecycle.createAndSendPrompt(draft), /onlineRecipientsRequired/);
  assert.equal(entries.size, 0);
  game.users.get("u1").active = true;
  game.users.get("u1").isGM = true;
  await assert.rejects(lifecycle.createAndSendPrompt(draft), /onlineRecipientsRequired/);
  game.users.get("u1").isGM = false;
  emit.openDrawingPrompt = async (userId, payload) => delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  const prompt = await lifecycle.createAndSendPrompt(draft);
  game.users.get("u1").active = false;
  await delivery.deliverPromptAssignments(prompt);
  assert.equal(prompt.deliverySummary.received.length, 1);
});

test("receipt authorization rejects spoofed wire identity and unknown initiator", async () => {
  emit.openDrawingPrompt = async () => { throw new Error("failed"); };
  const prompt = await lifecycle.createAndSendPrompt(draft);
  for ( const [initiator, claimed] of [["u2", "u1"], [null, "u1"], ["u1", "u2"]] ) {
    assert.equal((await delivery.acknowledgePromptDelivery(initiator, "a1", claimed)).accepted, false);
  }
  assert.equal(prompt.deliverySummary.hasRecipients, false);
});

test("framing failure removes the prompt before any invitation is dispatched", async () => {
  let dispatched = false;
  emit.openDrawingPrompt = async () => { dispatched = true; };
  globalThis.Image = class { constructor() { throw new Error("Image unavailable"); } };
  await assert.rejects(lifecycle.createAndSendPrompt({ ...draft, background: { sourceType: "file", path: "unavailable.webp" } }), /Image unavailable/);
  assert.equal(entries.size, 0);
  assert.equal(dispatched, false);
});

test("inviting another player during an existing attempt dispatches the additional assignment", async () => {
  let firstPayload;
  emit.openDrawingPrompt = async (userId, payload) => {
    if ( userId === "u1" ) { firstPayload = payload; return; }
    await delivery.acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  };
  const prompt = await lifecycle.createAndSendPrompt({ ...draft, awaitDeliveries: false });
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
  const prompt = await lifecycle.createAndSendPrompt(draft);
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
  await lifecycle.createAndSendPrompt(draft);
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
  const prompt = await lifecycle.createAndSendPrompt(draft);
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
  const prompt = await lifecycle.createAndSendPrompt({ ...draft, selectedUserIds: ["u1", "u2"] });
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
