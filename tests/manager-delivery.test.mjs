import assert from "node:assert/strict";
import { test } from "node:test";

let sequence = 0;
globalThis.foundry = { applications: { api: {
  ApplicationV2: class {}, DialogV2: class {}, HandlebarsApplicationMixin: Base => Base
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

test("Send paints busy feedback before storage, prevents duplicate creation, and recovers from failure", async () => {
  const manager = new DrawingPromptManager();
  Object.assign(manager.draft, { promptText: "Draw a bird", canvasWidth: 512, canvasHeight: 512,
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
  assert.equal(createCount, 1, "a second click must not create another prompt");
  assert.equal(manager.draft.promptText, "Draw a bird");
  assert.equal(manager.activePrompt, null);
  assert.equal(contexts.at(-1).canSend, true, "storage failure must release Send");
});

test("zero receipts preserve setup until Continue withdraws the failed attempt", async () => {
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
  assert.equal(failed.deliveryFeedback.needsResolution, true);
  assert.equal(failed.deliveryFeedback.noRecipients, true);
  assert.equal(entries.size, 1, "retain the attempt for same-invitation Retry");
  await DrawingPromptManager.DEFAULT_OPTIONS.actions.continueDeliveries.call(manager);
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
