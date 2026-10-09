import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { MODULE_ID, FLAG_PROMPT, PROMPT_STATUS, STATUS } from "../scripts/constants.mjs";
import { savePrompt } from "../scripts/prompts/persistence-service.mjs";
import { DrawingPrompt } from "../scripts/prompts/prompt-models.mjs";

let storedPrompt;
let blockNextSetFlag;
let setFlagCallCount;
let blockedSetFlagStarted;
let resolveBlockedSetFlagStarted;
let releaseBlockedSetFlag;

beforeEach(() => {
  blockNextSetFlag = false;
  setFlagCallCount = 0;
  blockedSetFlagStarted = new Promise(resolve => {
    resolveBlockedSetFlagStarted = resolve;
  });
  releaseBlockedSetFlag = () => {};
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
      setFlagCallCount += 1;
      if ( blockNextSetFlag ) {
        blockNextSetFlag = false;
        resolveBlockedSetFlagStarted();
        await new Promise(resolve => {
          releaseBlockedSetFlag = resolve;
        });
      }
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
  await savePrompt(staleAssignmentUpdate, { assignmentOnly: "a1" });

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
  assignmentUpdate.assetFolderName = "drawing-prompts";
  const staleTimerUpdate = DrawingPrompt.fromObject({
    ...structuredClone(storedPrompt),
    assignments: {
      a1: { id: "a1", promptId: "p1", userId: "u1", status: STATUS.OPENED }
    },
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: 45_000
  });

  await savePrompt(assignmentUpdate, { assignmentOnly: "a1" });
  await savePrompt(staleTimerUpdate, { timerOnly: true });

  assert.equal(storedPrompt.assignments.a1.status, STATUS.SUBMITTED);
  assert.equal(storedPrompt.timerStatus, "paused");
  assert.equal(storedPrompt.remainingMs, 45_000);
  assert.equal(staleTimerUpdate.assetFolderName, "drawing-prompts");
});

test("assignment-scoped saves synchronize the caller with newer persisted state", async () => {
  storedPrompt.assignments.a2 = { id: "a2", promptId: "p1", userId: "u2", status: STATUS.OPENED };
  const assignmentUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  const savedAssignment = assignmentUpdate.getAssignment("a1");
  savedAssignment.status = STATUS.SUBMITTED;

  const timerUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  timerUpdate.timerState = { timerStatus: "paused", deadlineAt: null, remainingMs: 30_000 };
  await savePrompt(timerUpdate, { timerOnly: true });

  const siblingUpdate = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  siblingUpdate.getAssignment("a2").status = STATUS.SUBMITTED;
  siblingUpdate.assetFolderName = "drawing-prompts";
  await savePrompt(siblingUpdate, { assignmentOnly: "a2" });

  await savePrompt(assignmentUpdate, { assignmentOnly: "a1" });

  assert.strictEqual(assignmentUpdate.getAssignment("a1"), savedAssignment);
  assert.equal(assignmentUpdate.getAssignment("a1").status, STATUS.SUBMITTED);
  assert.equal(assignmentUpdate.getAssignment("a2").status, STATUS.SUBMITTED);
  assert.deepEqual(assignmentUpdate.timerState, {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: 30_000
  });
  assert.equal(assignmentUpdate.assetFolderName, "drawing-prompts");
});

test("assignment-scoped saves preserve interleaved sibling assignment updates", async () => {
  storedPrompt.assignments.a2 = { id: "a2", promptId: "p1", userId: "u2", status: STATUS.OPENED };
  const firstSave = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  const staleSecondSave = DrawingPrompt.fromObject(structuredClone(storedPrompt));

  firstSave.getAssignment("a1").status = STATUS.SUBMITTED;
  firstSave.getAssignment("a1").assets.overlayPath = "worlds/demo/drawing-prompts/a1.webp";
  firstSave.assetFolderName = "drawing-prompts";
  staleSecondSave.getAssignment("a2").status = STATUS.SUBMITTED;
  staleSecondSave.getAssignment("a2").assets.overlayPath = "worlds/demo/drawing-prompts/a2.webp";

  blockNextSetFlag = true;
  const firstSavePromise = savePrompt(firstSave, { assignmentOnly: "a1" });
  const secondSavePromise = savePrompt(staleSecondSave, { assignmentOnly: "a2" });
  await blockedSetFlagStarted;
  try {
    assert.equal(setFlagCallCount, 1, "second setFlag must wait for the blocked first save");
  } finally {
    releaseBlockedSetFlag();
  }
  await Promise.all([firstSavePromise, secondSavePromise]);

  assert.equal(storedPrompt.assignments.a1.status, STATUS.SUBMITTED);
  assert.equal(storedPrompt.assignments.a1.assets.overlayPath, "worlds/demo/drawing-prompts/a1.webp");
  assert.equal(storedPrompt.assignments.a2.status, STATUS.SUBMITTED);
  assert.equal(storedPrompt.assignments.a2.assets.overlayPath, "worlds/demo/drawing-prompts/a2.webp");
  assert.equal(storedPrompt.assetFolderName, "drawing-prompts");
});

test("lifecycle saves preserve newer assignment state while freezing the timer", async () => {
  const closing = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  closing.timerState = { timerStatus: "paused", deadlineAt: null, remainingMs: 12_000 };
  closing.markClosed(500);

  const receipt = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  receipt.getAssignment("a1").delivery.status = "received";
  await savePrompt(receipt, { deliveryOnly: "a1" });
  await savePrompt(closing, { lifecycleOnly: true });

  assert.equal(storedPrompt.lifecycleStatus, PROMPT_STATUS.CLOSED);
  assert.equal(storedPrompt.closedAt, 500);
  assert.equal(storedPrompt.timerStatus, "paused");
  assert.equal(storedPrompt.remainingMs, 12_000);
  assert.equal(storedPrompt.assignments.a1.delivery.status, "received");
});

test("Draft-only saves preserve identity, timestamps, and concurrent assignment data", async () => {
  storedPrompt = {
    ...storedPrompt,
    promptName: "Old name",
    promptText: "Old text",
    lifecycleStatus: PROMPT_STATUS.DRAFT,
    createdAt: 123,
    selectedUserIds: ["u1"]
  };
  const update = DrawingPrompt.fromObject(structuredClone(storedPrompt));
  update.promptName = "New name";
  update.promptText = "New text";
  update.selectedUserIds = ["u1", "u2"];

  await savePrompt(update, { draftOnly: true });

  assert.equal(storedPrompt.promptName, "New name");
  assert.equal(storedPrompt.promptText, "New text");
  assert.equal(storedPrompt.createdAt, 123);
  assert.deepEqual(storedPrompt.selectedUserIds, ["u1", "u2"]);
  assert.equal(storedPrompt.assignments.a1.status, STATUS.OPENED);
});

test("Draft-only saves reject lifecycle changes", async () => {
  const update = DrawingPrompt.fromObject({ ...structuredClone(storedPrompt), lifecycleStatus: PROMPT_STATUS.DRAFT });
  await assert.rejects(() => savePrompt(update, { draftOnly: true }), /Illegal Draft update/);
});
