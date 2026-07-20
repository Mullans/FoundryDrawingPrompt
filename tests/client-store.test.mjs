import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { STATUS } from "../scripts/constants.mjs";
import {
  getAssignment,
  listAssignments,
  updateTimerState,
  updateStatus,
  upsertAssignment
} from "../scripts/prompts/client-store.mjs";

beforeEach(() => {
  globalThis.game = { user: { id: "u1" } };
});

test("client store returns only assignments addressed to the current user", () => {
  upsertAssignment({
    assignment: { id: "a1", userId: "u1", status: STATUS.PENDING },
    prompt: { id: "p1", sentAt: 1000, promptText: "Draw a key" }
  });
  upsertAssignment({
    assignment: { id: "a2", userId: "u2", status: STATUS.PENDING },
    prompt: { id: "p2", sentAt: 2000, promptText: "Draw a door" }
  });

  assert.equal(getAssignment("a1").prompt.promptText, "Draw a key");
  assert.equal(getAssignment("a2"), null);
});

test("client store lists current user's assignments by descending sent time and updates status", () => {
  globalThis.game = { user: { id: "u3" } };
  upsertAssignment({
    assignment: { id: "old", userId: "u3", status: STATUS.PENDING },
    prompt: { id: "p1", sentAt: 1000 }
  });
  upsertAssignment({
    assignment: { id: "new", userId: "u3", status: STATUS.OPENED },
    prompt: { id: "p2", sentAt: 3000 }
  });

  assert.deepEqual(listAssignments().map(payload => payload.assignment.id), ["new", "old"]);
  updateStatus("old", STATUS.CANCELLED);
  assert.equal(getAssignment("old").assignment.status, STATUS.CANCELLED);
});

test("client store updates canonical timer state without replacing prompt data", () => {
  upsertAssignment({
    assignment: { id: "a1", userId: "u1", status: STATUS.OPENED },
    prompt: { id: "p1", promptText: "Draw", timerStatus: "running", deadlineAt: 1000, remainingMs: null }
  });

  const updated = updateTimerState("a1", {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: -5000
  });

  assert.equal(updated.prompt.promptText, "Draw");
  assert.deepEqual({
    timerStatus: updated.prompt.timerStatus,
    deadlineAt: updated.prompt.deadlineAt,
    remainingMs: updated.prompt.remainingMs
  }, {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: -5000
  });
  assert.equal(updateTimerState("missing", { timerStatus: "none", deadlineAt: null, remainingMs: null }), null);
});
