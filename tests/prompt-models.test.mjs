import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { STATUS } from "../scripts/constants.mjs";
import { DrawingAssignment, DrawingPrompt } from "../scripts/prompts/prompt-models.mjs";

beforeEach(() => {
  let nextId = 0;
  globalThis.foundry = {
    utils: {
      randomID: () => `id${++nextId}`
    }
  };
  globalThis.game = {
    user: { id: "gm1" },
    users: new Map([
      ["u1", { id: "u1", name: "Ada" }],
      ["u2", { id: "u2", name: "Bert" }]
    ])
  };
});

test("DrawingAssignment follows the allowed lifecycle transitions", () => {
  const assignment = DrawingAssignment.create({ promptId: "p1", userId: "u1", userName: "Ada" });

  assert.equal(assignment.status, STATUS.PENDING);
  assert.equal(assignment.isActive, true);

  assignment.markOpened(100);
  assert.equal(assignment.status, STATUS.OPENED);
  assert.equal(assignment.openedAt, 100);

  assignment.markSubmitted({ ts: 200, late: true, overtimeMs: 5000 });
  assert.equal(assignment.status, STATUS.SUBMITTED);
  assert.equal(assignment.late, true);
  assert.equal(assignment.overtimeMs, 5000);
  assert.equal(assignment.isActive, false);
  assert.throws(() => assignment.markSubmitted({ ts: 300, late: false, overtimeMs: null }), /Illegal transition/);

  assignment.markReopened();
  assert.equal(assignment.status, STATUS.OPENED);
  assert.equal(assignment.reopenedCount, 1);
});

test("DrawingAssignment tolerates missing serialized fields", () => {
  const assignment = DrawingAssignment.fromObject({ id: "a1", promptId: "p1", userId: "u1" });
  const serialized = assignment.toObject();

  assert.equal(serialized.id, "a1");
  assert.equal(serialized.status, STATUS.PENDING);
  assert.deepEqual(serialized.assets, {
    name: null,
    overlayPath: null,
    mergedPath: null,
    oplogPath: null,
    thumbPath: null,
    folder: null
  });
  assert.deepEqual(serialized.placements, []);
});

test("DrawingAssignment primaryImagePath prefers merged assets and falls back to overlay", () => {
  const overlayOnly = DrawingAssignment.fromObject({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    assets: { overlayPath: "worlds/demo/drawing-prompts/camp.webp", mergedPath: null }
  });
  assert.equal(overlayOnly.primaryImagePath, "worlds/demo/drawing-prompts/camp.webp");

  const merged = DrawingAssignment.fromObject({
    id: "a2",
    promptId: "p1",
    userId: "u1",
    assets: {
      overlayPath: "worlds/demo/drawing-prompts/camp-overlay.webp",
      mergedPath: "worlds/demo/drawing-prompts/camp.webp"
    }
  });
  assert.equal(merged.primaryImagePath, "worlds/demo/drawing-prompts/camp.webp");
});

test("DrawingPrompt creates per-user assignments and round-trips JSON data", () => {
  const prompt = DrawingPrompt.create({
    promptText: "Draw a door",
    drawingName: "Door",
    canvasWidth: 640,
    canvasHeight: 480,
    background: { sourceType: "blank", path: null, fitMode: "fit-width" },
    timerSeconds: 60,
    createdAt: 1000,
    sentAt: 1100,
    deadlineAt: 61000
  }, ["u1", "u2"]);

  assert.equal(Object.keys(prompt.assignments).length, 2);
  assert.equal(prompt.assignmentForUser("u1").userName, "Ada");
  assert.equal(prompt.assignmentForUser("missing"), null);

  const roundTrip = DrawingPrompt.fromObject(JSON.parse(JSON.stringify(prompt.toObject())));
  assert.equal(roundTrip.promptText, "Draw a door");
  assert.equal(roundTrip.isActive, true);
  assert.equal(roundTrip.assignmentForUser("u2").userName, "Bert");
});
