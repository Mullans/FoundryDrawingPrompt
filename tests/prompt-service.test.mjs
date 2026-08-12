import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import { FLAG_PROMPT, MODULE_ID, STATUS } from "../scripts/constants.mjs";

let saveAssignment;
let stagedFetchUrl;
let buildRestorationSubmissionFromSavedAssets;
let reopenAssignment;
let DrawingAssignment;
let DrawingPrompt;
let storedPrompt;
let emit;

before(async () => {
  class ApplicationV2 {}
  globalThis.foundry = {
    applications: {
      api: {
        ApplicationV2,
        DialogV2: class {},
        HandlebarsApplicationMixin: Base => class extends Base {}
      }
    }
  };
  ({ DrawingAssignment, DrawingPrompt } = await import("../scripts/prompts/prompt-models.mjs"));
  ({
    saveAssignment,
    stagedFetchUrl,
    buildRestorationSubmissionFromSavedAssets,
    reopenAssignment
  } = await import("../scripts/prompts/prompt-service.mjs"));
  ({ emit } = await import("../scripts/socket.mjs"));
});

beforeEach(() => {
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
    }
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
    i18n: { localize: key => key }
  };
  globalThis.Hooks = { callAll: () => {} };
  globalThis.sessionStorage = {
    store: new Map(),
    setItem(key, value) { this.store.set(key, value); },
    getItem(key) { return this.store.get(key) ?? null; },
    removeItem(key) { this.store.delete(key); }
  };
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

test("buildRestorationSubmissionFromSavedAssets returns staged path-only payload", async () => {
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
    assert.deepEqual(submission.opLog, { ops: [{ type: "stroke" }] });
    assert.equal(submission.width, 800);
    assert.equal(submission.height, 600);
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
    assert.equal(reopenPayload?.restorationSubmission?.staged?.overlayPath, "drawings/griffin.webp");
    assert.equal(reopenPayload?.assignment?.pendingSubmission, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    emit.reopenDrawingPrompt = originalReopen;
    game.users.get("u1").active = false;
  }
});
