import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, test } from "node:test";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));

class TestApplicationV2 {
  constructor() {
    this.renderCalls = [];
    this.focusCalls = 0;
  }

  async render(options) {
    this.renderCalls.push(options);
    return this;
  }

  bringToFront() { this.focusCalls += 1; }

  _onClose() {}
}

class TestDialogV2 {
  static calls = [];
  static result = false;

  static async confirm(options) {
    this.calls.push(options);
    return this.result;
  }
}

let PromptLibrary;

before(async () => {
  globalThis.foundry = { applications: { api: {
    ApplicationV2: TestApplicationV2,
    DialogV2: TestDialogV2,
    HandlebarsApplicationMixin: Base => class extends Base {}
  } } };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    i18n: { localize: key => english[key] ?? key }
  };
  ({ PromptLibrary } = await import("../scripts/apps/prompt-library.mjs"));
});

beforeEach(() => {
  TestDialogV2.calls.length = 0;
  TestDialogV2.result = false;
});

function libraryWith({ prompts = [], services = {}, openManager = async () => {} } = {}) {
  return new PromptLibrary({}, {
    loadPrompts: () => prompts,
    services: {
      reopenPrompt: async () => {},
      archivePrompt: async () => {},
      restorePrompt: async () => {},
      deletePrompt: async () => {},
      ...services
    },
    openManager
  });
}

test("library lists only Closed and Archived Prompts in their respective sections", async () => {
  const library = libraryWith({ prompts: [
    { id: "open", drawingName: "Open", lifecycleStatus: "open", closedAt: 30 },
    { id: "closed-old", drawingName: "Old", lifecycleStatus: "closed", closedAt: 10 },
    { id: "archived", promptText: "Archived fallback", lifecycleStatus: "archived", closedAt: 20 },
    { id: "closed-new", drawingName: "New", lifecycleStatus: "closed", closedAt: 40 }
  ] });

  const context = await library._prepareContext();

  assert.deepEqual(context.closed, [
    { id: "closed-new", name: "New" },
    { id: "closed-old", name: "Old" }
  ]);
  assert.deepEqual(context.archived, [{ id: "archived", name: "Archived fallback" }]);
});

test("opening the library reuses and focuses its registered singleton", async () => {
  const first = await PromptLibrary.open();
  const second = await PromptLibrary.open();

  assert.strictEqual(second, first);
  assert.equal(first.renderCalls.length, 2);
  assert.equal(first.focusCalls, 2);
});

test("closing the Prompt Library releases the singleton for a fresh open", async () => {
  const first = await PromptLibrary.open();
  first._onClose({});
  const reopened = await PromptLibrary.open();

  assert.notStrictEqual(reopened, first);
  assert.equal(reopened.renderCalls.length, 1);
  assert.equal(reopened.focusCalls, 1);
});

test("Open reopens the exact Prompt and delegates to DrawingPromptManager.openPrompt", async () => {
  const calls = [];
  const library = libraryWith({
    services: { reopenPrompt: async id => calls.push(["reopen", id]) },
    openManager: async id => calls.push(["manager", id])
  });

  await PromptLibrary.DEFAULT_OPTIONS.actions.openPrompt.call(library, null, { dataset: { promptId: "p-exact" } });

  assert.deepEqual(calls, [["reopen", "p-exact"], ["manager", "p-exact"]]);
  assert.deepEqual(library.renderCalls, [{ parts: ["body"] }]);
});

test("Archive and Restore apply to the selected Prompt and refresh the library", async () => {
  const calls = [];
  const library = libraryWith({ services: {
    archivePrompt: async id => calls.push(["archive", id]),
    restorePrompt: async id => calls.push(["restore", id])
  } });
  const target = id => ({ dataset: { promptId: id } });

  await PromptLibrary.DEFAULT_OPTIONS.actions.archivePrompt.call(library, null, target("p-closed"));
  await PromptLibrary.DEFAULT_OPTIONS.actions.restorePrompt.call(library, null, target("p-archived"));

  assert.deepEqual(calls, [["archive", "p-closed"], ["restore", "p-archived"]]);
  assert.deepEqual(library.renderCalls, [{ parts: ["body"] }, { parts: ["body"] }]);
});

test("Delete cancellation preserves the Prompt and confirmation deletes the exact Prompt", async () => {
  const deleted = [];
  const library = libraryWith({ services: { deletePrompt: async (id, options) => deleted.push([id, options]) } });
  const action = PromptLibrary.DEFAULT_OPTIONS.actions.deletePrompt;
  const target = { dataset: { promptId: "p-delete" } };

  TestDialogV2.result = false;
  await action.call(library, null, target);
  assert.deepEqual(deleted, []);
  assert.equal(library.renderCalls.length, 0);

  TestDialogV2.result = true;
  await action.call(library, null, target);
  assert.deepEqual(deleted, [["p-delete", { confirmed: true }]]);
  assert.deepEqual(library.renderCalls, [{ parts: ["body"] }]);
  assert.equal(TestDialogV2.calls.length, 2);
  assert.equal(TestDialogV2.calls[1].modal, true);
});

test("Prompt Library copy is localized", () => {
  const expected = {
    "DRAWING-PROMPTS.library.title": "Prompt Library",
    "DRAWING-PROMPTS.library.closed": "Closed",
    "DRAWING-PROMPTS.library.archived": "Archived",
    "DRAWING-PROMPTS.library.open": "Open",
    "DRAWING-PROMPTS.library.archive": "Archive",
    "DRAWING-PROMPTS.library.restore": "Restore",
    "DRAWING-PROMPTS.library.delete": "Delete",
    "DRAWING-PROMPTS.library.deleteTitle": "Delete prompt"
  };
  for ( const [key, value] of Object.entries(expected) ) assert.equal(english[key], value, key);
});
