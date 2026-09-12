import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, test } from "node:test";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));

class TestApplicationV2 {
  constructor() { this.renderCalls = []; this.focusCalls = 0; }
  async render(options) { this.renderCalls.push(options); return this; }
  bringToFront() { this.focusCalls += 1; }
  _onClose() {}
  async _onRender() {}
}

class TestDialogV2 {
  static calls = [];
  static result = false;
  static async confirm(options) { this.calls.push(options); return this.result; }
}

let PromptLibrary;
let LIBRARY_SORT;
let filterAndSortPrompts;

before(async () => {
  globalThis.foundry = { applications: { api: {
    ApplicationV2: TestApplicationV2,
    DialogV2: TestDialogV2,
    HandlebarsApplicationMixin: Base => class extends Base {}
  } } };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    i18n: { lang: "en", localize: key => english[key] ?? key },
    settings: { get: () => undefined }
  };
  ({ PromptLibrary, LIBRARY_SORT, filterAndSortPrompts } = await import("../scripts/apps/prompt-library.mjs"));
});

beforeEach(() => { TestDialogV2.calls.length = 0; TestDialogV2.result = false; });

function libraryWith({ prompts = [], services = {}, openManager = async () => {}, openNew = async () => {}, openCopy = async () => {}, activePromptId = () => null, sortField, sortDirection } = {}) {
  return new PromptLibrary({}, {
    loadPrompts: () => prompts,
    services: { archivePrompt: async () => {}, restorePrompt: async () => {}, deletePrompt: async () => {}, ...services },
    openManager, openNew, openCopy, activePromptId, sortField, sortDirection
  });
}

const prompts = [
  { id: "open", gmUserId: "gm", promptName: "Goblin", promptText: "Ambush", lifecycleStatus: "open", createdAt: 10, sentAt: 40 },
  { id: "draft", gmUserId: "gm", promptName: "Clockwork", promptText: "Familiar", lifecycleStatus: "draft", createdAt: 30 },
  { id: "closed", gmUserId: "gm", promptName: "Best Drawing", lifecycleStatus: "closed", createdAt: 20, closedAt: 50 },
  { id: "archived", gmUserId: "gm", promptName: "Old Tavern", lifecycleStatus: "archived", createdAt: 5, closedAt: 25 }
];

test("library presents one unified list and hides Archived Prompts by default", async () => {
  const context = await libraryWith({ prompts, activePromptId: () => "open" })._prepareContext();
  assert.deepEqual(context.rows.map(row => row.id), ["draft", "closed", "open"]);
  assert.equal(context.rows.find(row => row.id === "open").isCurrent, true);
  assert.equal(context.rows.find(row => row.id === "draft").canArchive, true);
  assert.equal(context.hiddenArchivedMatch, true);
  assert.equal(context.showArchived, false);
});

test("library lists only Prompts owned by the current GM", async () => {
  const context = await libraryWith({ prompts: [...prompts, { ...prompts[0], id: "foreign", gmUserId: "other-gm" }] })._prepareContext();
  assert.equal(context.rows.some(row => row.id === "foreign"), false);
});

test("search is case-insensitive across Prompt name and text", () => {
  assert.deepEqual(filterAndSortPrompts([...prompts], { query: "FAMILIAR", showArchived: true }).map(prompt => prompt.id), ["draft"]);
  assert.deepEqual(filterAndSortPrompts([...prompts], { query: "tavern", showArchived: false }).map(prompt => prompt.id), []);
});

test("sorts by status in forward order and reverses the complete comparator", () => {
  const options = { showArchived: true, sortField: LIBRARY_SORT.STATUS, sortDirection: "asc" };
  const forward = filterAndSortPrompts([...prompts], options).map(prompt => prompt.id);
  const reverse = filterAndSortPrompts([...prompts], { ...options, sortDirection: "desc" }).map(prompt => prompt.id);
  assert.deepEqual(forward, ["open", "draft", "closed", "archived"]);
  assert.deepEqual(reverse, [...forward].reverse());
});

test("Date closed sorting places Open before dated rows and Draft last when newest-first", () => {
  assert.deepEqual(filterAndSortPrompts([...prompts], { showArchived: true, sortField: LIBRARY_SORT.CLOSED, sortDirection: "desc" }).map(prompt => prompt.id), ["open", "closed", "archived", "draft"]);
  assert.deepEqual(filterAndSortPrompts([...prompts], { showArchived: true, sortField: LIBRARY_SORT.CLOSED, sortDirection: "asc" }).map(prompt => prompt.id), ["archived", "closed", "open", "draft"]);
});

test("opening the library reuses and focuses its registered singleton", async () => {
  const first = await PromptLibrary.open();
  const second = await PromptLibrary.open();
  assert.strictEqual(second, first);
  assert.equal(first.renderCalls.length, 2);
  assert.equal(first.focusCalls, 2);
});

test("closing the Prompt Library releases the singleton for a fresh open", async () => {
  const first = await PromptLibrary.open(); first._onClose({});
  const reopened = await PromptLibrary.open();
  assert.notStrictEqual(reopened, first);
});

test("New, Open, and Open Copy delegate without mutating lifecycle", async () => {
  const calls = [];
  const library = libraryWith({
    openNew: async () => calls.push(["new"]),
    openManager: async id => calls.push(["open", id]),
    openCopy: async id => calls.push(["copy", id])
  });
  const target = { dataset: { promptId: "p-exact" } };
  await PromptLibrary.DEFAULT_OPTIONS.actions.newPrompt.call(library);
  await PromptLibrary.DEFAULT_OPTIONS.actions.openPrompt.call(library, null, target);
  await PromptLibrary.DEFAULT_OPTIONS.actions.openCopy.call(library, null, target);
  assert.deepEqual(calls, [["new"], ["open", "p-exact"], ["copy", "p-exact"]]);
  assert.deepEqual(library.renderCalls, [{ parts: ["body"] }, { parts: ["body"] }, { parts: ["body"] }]);
});

test("Archive and Restore apply to the selected Prompt and refresh", async () => {
  const calls = [];
  const library = libraryWith({ services: {
    archivePrompt: async id => calls.push(["archive", id]),
    restorePrompt: async id => calls.push(["restore", id])
  } });
  const target = id => ({ dataset: { promptId: id } });
  await PromptLibrary.DEFAULT_OPTIONS.actions.archivePrompt.call(library, null, target("draft"));
  await PromptLibrary.DEFAULT_OPTIONS.actions.restorePrompt.call(library, null, target("archived"));
  assert.deepEqual(calls, [["archive", "draft"], ["restore", "archived"]]);
  assert.deepEqual(library.renderCalls, [{ parts: ["body"] }, { parts: ["body"] }]);
});

test("Delete cancellation preserves the Prompt and confirmation deletes the exact Prompt", async () => {
  const deleted = [];
  const library = libraryWith({ services: { deletePrompt: async (id, options) => deleted.push([id, options]) } });
  const action = PromptLibrary.DEFAULT_OPTIONS.actions.deletePrompt;
  const target = { dataset: { promptId: "p-delete" } };
  await action.call(library, null, target);
  assert.deepEqual(deleted, []);
  TestDialogV2.result = true;
  await action.call(library, null, target);
  assert.deepEqual(deleted, [["p-delete", { confirmed: true }]]);
  assert.equal(TestDialogV2.calls.length, 2);
});

test("template uses unified rows, accessible details, and contextual More menus", () => {
  const template = readFileSync(new URL("../templates/prompt-library.hbs", import.meta.url), "utf8");
  assert.match(template, /dp-library-list/);
  assert.doesNotMatch(template, /dp-library-section/);
  assert.match(template, /aria-pressed="{{showArchived}}"/);
  assert.match(template, /dp-library-info/);
  assert.match(template, /dp-library-more/);
  assert.match(template, /data-action="openCopy"/);
});
