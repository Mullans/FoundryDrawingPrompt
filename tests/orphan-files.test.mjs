import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, test } from "node:test";

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
class Application {
  constructor() { this.renders = []; }
  async render(options) { this.renders.push(options); return this; }
  bringToFront() {}
  _onClose() {}
}
let OrphanFiles;
let PromptLibrary;
before(async () => {
  globalThis.foundry = { applications: { api: {
    ApplicationV2: Application, DialogV2: {}, HandlebarsApplicationMixin: Base => class extends Base {}
  } } };
  globalThis.game = {
    user: { id: "gm", isGM: true }, i18n: { lang: "en", localize: key => english[key] ?? key },
    settings: { get: () => undefined }
  };
  globalThis.ui = { notifications: { error() {} } };
  ({ OrphanFiles } = await import("../scripts/apps/orphan-files.mjs"));
  ({ PromptLibrary } = await import("../scripts/apps/prompt-library.mjs"));
});
beforeEach(() => { game.user.isGM = true; });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const record = {
  id: "one", path: "https://assets.forge-vtt.com/account/internal/overlay.png", promptName: "Goblin",
  playerName: "Pat", account: "account", folder: "internal", orphanedAt: 1, status: "denied", error: "Forbidden"
};
function service(overrides = {}) {
  return { getOrphanFiles: () => [record], refreshOrphanFiles: async () => {}, reconcileFileCleanup: async () => {}, ...overrides };
}

test("fallback metadata preserves original ownership and reports access failure", async () => {
  const app = new OrphanFiles({}, { service: async () => service() });
  const { rows } = await app._prepareContext();
  assert.equal(rows[0].filename, "overlay.png");
  assert.equal(rows[0].path, record.path);
  assert.equal(rows[0].promptName, "Goblin");
  assert.equal(rows[0].playerName, "Pat");
  assert.equal(rows[0].account, "account");
  assert.equal(rows[0].status, "Access denied");
  assert.equal(rows[0].error, english["DRAWING-PROMPTS.orphans.reason.denied"]);
  assert.equal(rows[0].error.includes("Forbidden"), false);
});

test("fallback explanations localize stable statuses and deferred or uncertain request states", async () => {
  const records = [
    ...["unsupported", "unavailable", "denied", "unconfirmed", "unableToVerify", "failed"].map(status => ({ ...record, id: status, status })),
    { ...record, id: "deferred", deferred: true },
    { ...record, id: "uncertainDeletion", deferred: true, uncertainDeletion: true }
  ];
  const app = new OrphanFiles({}, { service: async () => service({ getOrphanFiles: () => records }) });
  const { rows } = await app._prepareContext();
  for ( const row of rows ) assert.equal(row.error, english[`DRAWING-PROMPTS.orphans.reason.${row.id}`]);
});

test("players cannot open, inspect, refresh or copy registry metadata", async () => {
  const app = new OrphanFiles({}, { service: async () => service() });
  game.user.isGM = false;
  await assert.rejects(OrphanFiles.open(), /Only a GM/);
  await assert.rejects(app._prepareContext(), /Only a GM/);
  await assert.rejects(app.refresh(), /Only a GM/);
  await assert.rejects(OrphanFiles.DEFAULT_OPTIONS.actions.copyPath.call(app, null, { dataset: { fileId: "one" } }), /Only a GM/);
});

test("Refresh verifies only; explicit retry delegates deletion", async () => {
  const calls = [];
  const app = new OrphanFiles({}, { service: async () => service({
    refreshOrphanFiles: async () => calls.push("verify"),
    reconcileFileCleanup: async options => calls.push(options)
  }) });
  await app.refresh();
  await app.refresh({ retry: true });
  assert.deepEqual(calls, ["verify", { retry: true, manual: true }]);
});

test("overlapping checks coalesce and an explicit retry waits for verification", async () => {
  const check = deferred();
  let verifies = 0; let retries = 0;
  const app = new OrphanFiles({}, { service: async () => service({
    refreshOrphanFiles: async () => { verifies++; await check.promise; },
    reconcileFileCleanup: async () => { retries++; }
  }) });
  const first = app.refresh();
  const second = app.refresh();
  const retry = app.refresh({ retry: true });
  await Promise.resolve();
  assert.equal(verifies, 1); assert.equal(retries, 0);
  check.resolve();
  await Promise.all([first, second, retry]);
  assert.equal(verifies, 1); assert.equal(retries, 1);
});

test("closing during verification prevents completion from reopening the window", async () => {
  const check = deferred();
  const app = new OrphanFiles({}, { service: async () => service({ refreshOrphanFiles: () => check.promise }) });
  const refresh = app.refresh();
  await Promise.resolve(); await Promise.resolve();
  app._onClose({});
  const renders = app.renders.length;
  check.resolve(); await refresh;
  assert.equal(app.renders.length, renders);
});

test("failed verification releases busy state and permits a later refresh", async () => {
  let calls = 0;
  const app = new OrphanFiles({}, { service: async () => service({ refreshOrphanFiles: async () => {
    if ( ++calls === 1 ) throw new Error("Connection lost");
  } }) });
  await assert.rejects(app.refresh(), /Connection lost/);
  assert.equal((await app._prepareContext()).busy, false);
  await app.refresh();
  assert.equal(calls, 2);
});

test("copy resolves the current record rather than trusting a DOM-provided path", async () => {
  const copies = [];
  const app = new OrphanFiles({}, { service: async () => service(), copy: async path => copies.push(path) });
  const action = OrphanFiles.DEFAULT_OPTIONS.actions.copyPath;
  await action.call(app, null, { dataset: { fileId: "one", path: "wrong" } });
  await action.call(app, null, { dataset: { fileId: "removed" } });
  assert.deepEqual(copies, [record.path]);
});

test("library count uses world fallback rows regardless of Prompt owner and delegates opening", async () => {
  let opens = 0;
  const library = new PromptLibrary({}, {
    loadPrompts: () => [], getOrphanFiles: () => [record, { ...record, id: "other" }],
    openOrphanFiles: async () => { opens++; }
  });
  assert.equal((await library._prepareContext()).orphanCount, 2);
  await PromptLibrary.DEFAULT_OPTIONS.actions.orphanFiles.call(library);
  assert.equal(opens, 1);
});

test("opening paints cached records and reuses its singleton while verification is pending", async () => {
  const check = deferred(); let verifies = 0;
  const first = await OrphanFiles.open({ service: async () => service({ refreshOrphanFiles: async () => { verifies++; await check.promise; } }) });
  assert.ok(first.renders.length > 0);
  const second = await OrphanFiles.open();
  assert.equal(second, first); assert.equal(verifies, 1);
  first._onClose({}); check.resolve();
});
