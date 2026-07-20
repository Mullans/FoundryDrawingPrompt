import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import { FLAG_PROMPT, MODULE_ID, STATUS } from "../scripts/constants.mjs";

let saveAssignment;
let DrawingAssignment;
let storedPrompt;

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
  ({ DrawingAssignment } = await import("../scripts/prompts/prompt-models.mjs"));
  ({ saveAssignment } = await import("../scripts/prompts/prompt-service.mjs"));
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
    i18n: { localize: key => key }
  };
  globalThis.Hooks = { callAll: () => {} };
});

test("saveAssignment backfills the save gate timestamp when cached submission data is gone", async () => {
  const assignment = await saveAssignment("a-saved");

  assert.equal(assignment.savedSubmissionTs, 123_456);
  assert.equal(storedPrompt.assignments["a-saved"].savedSubmissionTs, 123_456);
});
