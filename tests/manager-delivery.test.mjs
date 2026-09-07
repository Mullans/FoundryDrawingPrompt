import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

let sequence = 0;
class TestDialogV2 {
  static calls = [];
  static async wait(options) {
    this.calls.push(options);
    return null;
  }
}
globalThis.foundry = { applications: { api: {
  ApplicationV2: class {}, DialogV2: TestDialogV2, HandlebarsApplicationMixin: Base => Base
} }, utils: { randomID: () => `id${++sequence}` } };
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0 } };
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.game = {
  user: { id: "gm", isGM: true },
  users: new Map([["u1", { id: "u1", name: "Ada", active: true, can: () => false }]]),
  journal: [],
  folders: [{ id: "folder", name: "DRAWING-PROMPTS.journal.folderName", type: "JournalEntry" }],
  settings: { get: () => undefined },
  i18n: { localize: key => key, format: key => key }
};
const { DrawingPromptManager } = await import("../scripts/apps/drawing-prompt-manager.mjs");

test("withdrawn invitations cannot enable Resend All while cancelled recipients can", async () => {
  const { DrawingPrompt } = await import("../scripts/prompts/prompt-models.mjs");
  const manager = new DrawingPromptManager();
  manager.activePrompt = new DrawingPrompt({ id: "resend-membership", gmUserId: "gm", assignments: {
    withdrawn: { id: "withdrawn", userId: "u1", status: "cancelled", delivery: { status: "withdrawn" } }
  } });
  const withdrawn = await manager._prepareContext({});
  assert.equal(withdrawn.canResendAll, false);
  assert.equal(withdrawn.rows[0].canResend, false);
  manager.activePrompt.getAssignment("withdrawn").delivery.status = "received";
  const cancelled = await manager._prepareContext({});
  assert.equal(cancelled.canResendAll, true);
  assert.equal(cancelled.rows[0].canResend, true);
});

test("Send paints busy feedback before storage, prevents duplicate creation, and recovers from failure", async () => {
  const manager = new DrawingPromptManager();
  Object.assign(manager.draft, { promptText: "Draw a bird", drawingName: "Bird", canvasWidth: 512, canvasHeight: 512,
    timerSeconds: 0, selectedUserIds: new Set(["u1"]) });
  const contexts = [];
  manager.render = async () => { contexts.push(await manager._prepareContext({})); return manager; };
  const storageRejectors = [];
  let creates = 0;
  globalThis.JournalEntry = { create: () => { creates++;
    return new Promise((_resolve, reject) => { storageRejectors.push(reject); });
  } };
  const action = DrawingPromptManager.DEFAULT_OPTIONS.actions.sendPrompt;
  const sending = action.call(manager).catch(() => {});
  for ( let n = 0; n < 20 && !storageRejectors.length; n++ ) await new Promise(resolve => setTimeout(resolve, 5));
  const paintedBeforeStorage = contexts.some(context => context.isSending && !context.canSend);
  const duplicate = action.call(manager).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 10));
  const createCount = creates;
  // Reject every attempt, including an erroneous duplicate on pre-fix code.
  for ( const reject of storageRejectors ) reject(new Error("storage unavailable"));
  await Promise.all([sending, duplicate]);
  assert.ok(paintedBeforeStorage, "Sending must be rendered before JournalEntry.create can stall");
  assert.equal(contexts.find(context => context.isSending)?.sendLabel, "Sending...");
  assert.equal(createCount, 1, "a second click must not create another prompt");
  assert.equal(manager.draft.promptText, "Draw a bird");
  assert.equal(manager.activePrompt, null);
  assert.equal(contexts.at(-1).canSend, true, "storage failure must release Send");
});

test("drawing name appears before optional prompt text and a name-only prompt sends", async () => {
  const template = readFileSync(new URL("../templates/drawing-prompt-manager.hbs", import.meta.url), "utf8");
  assert.ok(template.indexOf('name="drawingName"') < template.indexOf('name="promptText"'));

  const entries = new Map();
  game.journal = { get: id => entries.get(id), [Symbol.iterator]: function* () { yield* entries.values(); } };
  globalThis.JournalEntry = { create: async () => {
    let stored;
    const entry = { id: `prompt${++sequence}`, getFlag: () => stored,
      setFlag: async (_module, _flag, value) => { stored = structuredClone(value); return entry; } };
    entries.set(entry.id, entry);
    return entry;
  } };
  const { emit } = await import("../scripts/socket.mjs");
  const { acknowledgePromptDelivery } = await import("../scripts/prompts/prompt-delivery.mjs");
  emit.openDrawingPrompt = (userId, payload) => acknowledgePromptDelivery(userId, payload.assignment.id, userId);
  const manager = new DrawingPromptManager();
  Object.assign(manager.draft, { drawingName: "crab", promptText: "", canvasWidth: 512, canvasHeight: 512,
    timerSeconds: 0, selectedUserIds: new Set(["u1"]) });
  manager.render = async () => manager;

  await DrawingPromptManager.DEFAULT_OPTIONS.actions.sendPrompt.call(manager);

  assert.equal(entries.size, 1);
  assert.equal(manager.activePrompt.drawingName, "crab");
  assert.equal(manager.activePrompt.promptText, "");
  assert.equal(manager.activePrompt.deliverySummary.received.length, 1);
});

test("zero receipts use a separate modal with disabled Continue and Back to setup preserves configuration", async () => {
  TestDialogV2.calls.length = 0;
  const entries = new Map();
  game.journal = { get: id => entries.get(id), [Symbol.iterator]: function* () { yield* entries.values(); } };
  globalThis.JournalEntry = { create: async () => {
    let stored;
    const entry = { id: `prompt${++sequence}`, getFlag: () => stored,
      setFlag: async (_module, _flag, value) => { stored = structuredClone(value); return entry; },
      delete: async () => entries.delete(entry.id) };
    entries.set(entry.id, entry);
    return entry;
  } };
  const { emit } = await import("../scripts/socket.mjs");
  emit.openDrawingPrompt = async () => { throw new Error("unreachable"); };
  emit.cancelDrawingPrompt = async () => {};
  const manager = new DrawingPromptManager();
  Object.assign(manager.draft, { promptText: "Keep this prompt", drawingName: "Birds", canvasWidth: 640,
    canvasHeight: 480, timerSeconds: 120, selectedUserIds: new Set(["u1"]) });
  manager.render = async () => manager;
  await DrawingPromptManager.DEFAULT_OPTIONS.actions.sendPrompt.call(manager);
  const failed = await manager._prepareContext({});
  assert.equal(failed.mode, "setup");
  assert.equal(failed.canSend, false, "retry must not create another invitation");
  assert.equal(failed.deliveryFeedback, null, "delivery warnings must not be embedded in the manager");
  assert.equal(entries.size, 1, "retain the attempt for same-invitation Retry");
  const dialog = TestDialogV2.calls.at(-1);
  assert.equal(dialog.modal, true);
  assert.match(dialog.content, /No response from:.*Ada/s);
  assert.match(dialog.content, /Not enough players to start the drawing\./);
  assert.deepEqual(dialog.buttons.map(button => [button.action, button.label, Boolean(button.disabled)]), [
    ["retry", "Retry", false],
    ["continue", "Continue", true],
    ["back", "Back to setup", false]
  ]);

  await DrawingPromptManager.DEFAULT_OPTIONS.actions.backToSetup.call(manager);
  const setup = await manager._prepareContext({});
  assert.equal(setup.canSend, true);
  assert.equal(setup.deliveryFeedback, null);
  assert.equal(entries.size, 0);
  assert.equal(manager.draft.promptText, "Keep this prompt");
  assert.equal(manager.draft.drawingName, "Birds");
  assert.equal(manager.draft.canvasWidth, 640);
  assert.equal(manager.draft.canvasHeight, 480);
  assert.equal(manager.draft.timerSeconds, 120);
  assert.deepEqual([...manager.draft.selectedUserIds], ["u1"]);
});

test("partial delivery modal uses the requested Continue explanation", async () => {
  const { DrawingPrompt } = await import("../scripts/prompts/prompt-models.mjs");
  const manager = new DrawingPromptManager();
  manager.activePrompt = new DrawingPrompt({ id: "partial", gmUserId: "gm", assignments: {
    received: { id: "received", userId: "u1", userName: "Ada", status: "pending", delivery: { status: "received" } },
    failed: { id: "failed", userId: "u2", userName: "Ben", status: "pending", delivery: { status: "failed" } }
  } });
  await manager.showDeliveryWarning();
  const dialog = TestDialogV2.calls.at(-1);
  assert.match(dialog.content, /No response from:.*Ben/s);
  assert.match(dialog.content, /Continue to start the drawing without these players\./);
  assert.equal(dialog.buttons.find(button => button.action === "continue").disabled, false);
});
