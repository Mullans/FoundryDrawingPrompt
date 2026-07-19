import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { MODULE_ID, FLAG_PROMPT, STATUS } from "../scripts/constants.mjs";
import { savePrompt } from "../scripts/prompts/persistence-service.mjs";
import { DrawingPrompt } from "../scripts/prompts/prompt-models.mjs";

let storedPrompt;

beforeEach(() => {
  storedPrompt = {
    id: "p1",
    gmUserId: "gm1",
    timerSeconds: 300,
    timerStatus: "running",
    deadlineAt: 300_000,
    remainingMs: null,
    assignments: {
      a1: { id: "a1", promptId: "p1", userId: "u1", status: STATUS.OPENED }
    }
  };
  const entry = {
    getFlag: (moduleId, flag) => moduleId === MODULE_ID && flag === FLAG_PROMPT ? storedPrompt : null,
    setFlag: async (_moduleId, _flag, value) => {
      storedPrompt = structuredClone(value);
      return entry;
    }
  };
  globalThis.game = {
    user: { id: "gm1", isGM: true },
    journal: new Map([["p1", entry]]),
    i18n: { localize: key => key }
  };
});

test("assignment saves preserve a newer timer-only update", async () => {
  const staleAssignmentUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  staleAssignmentUpdate.getAssignment("a1").status = STATUS.SUBMITTED;

  const timerUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  timerUpdate.timerState = { timerStatus: "paused", deadlineAt: null, remainingMs: -5_000 };

  await savePrompt(timerUpdate, { timerOnly: true });
  await savePrompt(staleAssignmentUpdate);

  assert.equal(storedPrompt.assignments.a1.status, STATUS.SUBMITTED);
  assert.deepEqual({
    timerStatus: storedPrompt.timerStatus,
    deadlineAt: storedPrompt.deadlineAt,
    remainingMs: storedPrompt.remainingMs
  }, {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: -5_000
  });
});

test("timer-only saves preserve newer assignment state", async () => {
  const assignmentUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  assignmentUpdate.getAssignment("a1").status = STATUS.SUBMITTED;
  await savePrompt(assignmentUpdate);

  const staleTimerUpdate = DrawingPrompt.fromObject({
    ...structuredClone(storedPrompt),
    assignments: {
      a1: { id: "a1", promptId: "p1", userId: "u1", status: STATUS.OPENED }
    },
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: 45_000
  });
  await savePrompt(staleTimerUpdate, { timerOnly: true });

  assert.equal(storedPrompt.assignments.a1.status, STATUS.SUBMITTED);
  assert.equal(storedPrompt.timerStatus, "paused");
  assert.equal(storedPrompt.remainingMs, 45_000);
});
