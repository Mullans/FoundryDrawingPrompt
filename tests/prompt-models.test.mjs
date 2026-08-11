import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { BG_SOURCE, FIT_MODE, STATUS } from "../scripts/constants.mjs";
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
    fullPath: null,
    sourceOverlayPath: null,
    oplogPath: null,
    thumbPath: null,
    folder: null,
    tileWidth: null,
    tileHeight: null
  });
  assert.equal(serialized.pendingSubmission, null);
  assert.deepEqual(serialized.placements, []);
  assert.equal(serialized.savedSubmissionTs, null);
});

test("DrawingAssignment round-trips savedSubmissionTs", () => {
  const assignment = DrawingAssignment.fromObject({
    id: "a1", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED, submittedAt: 100, savedSubmissionTs: 150
  });
  const roundTrip = DrawingAssignment.fromObject(JSON.parse(JSON.stringify(assignment.toObject())));
  assert.equal(roundTrip.savedSubmissionTs, 150);

  const legacy = DrawingAssignment.fromObject({ id: "a2", promptId: "p1", userId: "u1", status: STATUS.SUBMITTED });
  assert.equal(legacy.savedSubmissionTs, null);
});

test("DrawingAssignment preserves tile and token placement identities", () => {
  const assignment = DrawingAssignment.fromObject({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    placements: [
      { tileId: "tile1", sceneId: "scene1", hidden: false, placedAt: 100 },
      { kind: "token", tokenId: "token1", actorId: "actor1", sceneId: "scene1", hidden: true, placedAt: 200 }
    ]
  });

  assert.deepEqual(assignment.toObject().placements, [
    {
      kind: "tile",
      tileId: "tile1",
      tokenId: null,
      actorId: null,
      sceneId: "scene1",
      hidden: false,
      placedAt: 100
    },
    {
      kind: "token",
      tileId: null,
      tokenId: "token1",
      actorId: "actor1",
      sceneId: "scene1",
      hidden: true,
      placedAt: 200
    }
  ]);
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
    timerStatus: "running",
    deadlineAt: 61000,
    remainingMs: null
  }, ["u1", "u2"]);

  assert.equal(Object.keys(prompt.assignments).length, 2);
  assert.equal(prompt.assignmentForUser("u1").userName, "Ada");
  assert.equal(prompt.assignmentForUser("missing"), null);

  const roundTrip = DrawingPrompt.fromObject(JSON.parse(JSON.stringify(prompt.toObject())));
  assert.equal(roundTrip.promptText, "Draw a door");
  assert.equal(roundTrip.isActive, true);
  assert.equal(roundTrip.assignmentForUser("u2").userName, "Bert");
  assert.deepEqual(roundTrip.timerState, {
    timerStatus: "running",
    deadlineAt: 61000,
    remainingMs: null
  });
});

test("DrawingPrompt round-trips paused overtime timer state", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    timerSeconds: 300,
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: -45_000
  });

  assert.deepEqual(DrawingPrompt.fromObject(JSON.parse(JSON.stringify(prompt.toObject()))).timerState, {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs: -45_000
  });
});

test("DrawingPrompt migrates legacy deadline state", () => {
  assert.deepEqual(DrawingPrompt.fromObject({ id: "p1", deadlineAt: 61_000 }).timerState, {
    timerStatus: "running",
    deadlineAt: 61_000,
    remainingMs: null
  });
  assert.deepEqual(DrawingPrompt.fromObject({ id: "p2", deadlineAt: null }).timerState, {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(DrawingPrompt.fromObject({ id: "p3" }).timerState, {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
});

test("DrawingPrompt timerState setter keeps serialization canonical", () => {
  const prompt = DrawingPrompt.fromObject({ id: "p1", deadlineAt: 61_000 });
  prompt.timerState = { timerStatus: "none", deadlineAt: 61_000, remainingMs: -10_000 };

  const serialized = prompt.toObject();
  assert.equal(serialized.timerStatus, "none");
  assert.equal(serialized.deadlineAt, null);
  assert.equal(serialized.remainingMs, null);
});

test("DrawingPrompt defaults background framing to null and round-trips explicit framing", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: 800,
      naturalHeight: 600
    }
  });

  assert.equal(prompt.background.framing, null);
  assert.equal(prompt.background.framedPath, null);

  prompt.background.framing = { x: 0, y: 0, width: 800, height: 600 };
  const roundTrip = DrawingPrompt.fromObject(JSON.parse(JSON.stringify(prompt.toObject())));
  assert.deepEqual(roundTrip.background.framing, { x: 0, y: 0, width: 800, height: 600 });
});

test("DrawingPrompt.applyBackgroundUpdate rejects locked fitMode and framing after send", () => {
  const prompt = DrawingPrompt.fromObject({
    id: "p1",
    sentAt: 1000,
    background: {
      sourceType: BG_SOURCE.FILE,
      path: "maps/dungeon.webp",
      fitMode: FIT_MODE.FIT_WIDTH,
      naturalWidth: 800,
      naturalHeight: 600,
      framing: { x: 0, y: 0, width: 800, height: 600 },
      framedPath: "drawing-prompts/staging/p1-framed.webp"
    }
  });

  assert.equal(prompt.isBackgroundLocked, true);
  assert.throws(() => prompt.applyBackgroundUpdate({ fitMode: FIT_MODE.STRETCH }), /locked/i);
  assert.throws(
    () => prompt.applyBackgroundUpdate({ framing: { x: 10, y: 0, width: 800, height: 600 } }),
    /locked/i
  );
  assert.doesNotThrow(() => prompt.applyBackgroundUpdate({ path: "maps/other.webp" }));
});

test("DrawingPrompt round-trips a nullable asset folder name without computing it", () => {
  const legacy = DrawingPrompt.fromObject({ id: "p1", createdAt: 1000 });
  assert.equal(legacy.assetFolderName, null);
  assert.equal(legacy.toObject().assetFolderName, null);

  const hydrated = DrawingPrompt.fromObject({ id: "p2", assetFolderName: "2026-07-19-draw-a-door-abcd" });
  const roundTrip = DrawingPrompt.fromObject(JSON.parse(JSON.stringify(hydrated.toObject())));
  assert.equal(roundTrip.assetFolderName, "2026-07-19-draw-a-door-abcd");
});
