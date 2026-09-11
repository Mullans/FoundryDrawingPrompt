import assert from "node:assert/strict";
import { test } from "node:test";

import { createMapStorageAdapter, createRecoveryCopyModule } from "../scripts/drawing/recovery-copy.mjs";

const identity = Object.freeze({
  worldId: "world-1",
  userId: "user-1",
  assignmentId: "assignment-1",
  promptId: "prompt-1",
  width: 640,
  height: 480,
  existingAssignment: true
});

const stroke = Object.freeze({
  id: "op-1",
  type: "stroke",
  ts: 10,
  size: 4,
  color: "#112233",
  opacity: 0.8,
  points: [{ x: 1, y: 2 }, { x: 3, y: 4 }]
});

function moduleWith(map = new Map()) {
  return { map, recovery: createRecoveryCopyModule({ storage: createMapStorageAdapter(map), now: () => 1234 }) };
}

test("Recovery copy round-trips the complete operation log including its redo tail", () => {
  const { recovery } = moduleWith();
  recovery.saveRecoveryCopy(identity, { ops: [stroke, { id: "op-2", type: "clear", ts: 11 }], pointer: 1 });

  const resolved = recovery.resolveRecovery(identity, null);

  assert.deepEqual(resolved, {
    kind: "local",
    opLog: { ops: [stroke, { id: "op-2", type: "clear", ts: 11 }], pointer: 1 },
    historyMissing: false
  });
});

test("Recovery copy isolates world, user, prompt, assignment, and canvas identity", () => {
  const { recovery } = moduleWith();
  recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 });

  for ( const mismatch of [
    { worldId: "world-2" }, { userId: "user-2" }, { assignmentId: "assignment-2" },
    { promptId: "prompt-2" }, { width: 641 }, { height: 481 }
  ] ) {
    assert.equal(recovery.resolveRecovery({ ...identity, ...mismatch }, null).kind, "blank");
  }
});

test("Recovery copy removes corrupt and unknown-schema records", () => {
  const { map, recovery } = moduleWith();
  const key = "drawing-prompts.recovery.v1.world-1.user-1.assignment-1";
  map.set(key, "not json");
  assert.equal(recovery.resolveRecovery(identity, null).kind, "blank");
  assert.equal(map.has(key), false);

  map.set(key, JSON.stringify({ schema: 2 }));
  assert.equal(recovery.resolveRecovery(identity, null).kind, "blank");
  assert.equal(map.has(key), false);
});

test("Recovery copy rejects malformed operations and pointer bounds", () => {
  const { map, recovery } = moduleWith();
  const key = "drawing-prompts.recovery.v1.world-1.user-1.assignment-1";
  map.set(key, JSON.stringify({ schema: 1, ...identity, savedAt: 1, opLog: { ops: [{ type: "script" }], pointer: 1 } }));
  assert.equal(recovery.resolveRecovery(identity, null).kind, "blank");
  assert.equal(map.has(key), false);

  assert.throws(() => recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 2 }), /operation log/i);
});

test("Local recovery takes precedence over every GM fallback", () => {
  const { recovery } = moduleWith();
  recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 });
  const fallback = { recoveryKind: "full-submission", assignmentId: identity.assignmentId, width: 640, height: 480,
    receiptTs: 9999, overlay: { dataUrl: "data:image/webp;base64,full" } };

  assert.equal(recovery.resolveRecovery(identity, fallback).kind, "local");
});

test("Only the newest exact-size full submission is eligible as GM fallback", () => {
  const { recovery } = moduleWith();
  const candidates = [
    { recoveryKind: "quick-preview", assignmentId: "assignment-1", width: 640, height: 480, receiptTs: 500, overlay: { dataUrl: "quick" } },
    { recoveryKind: "saved-preview", assignmentId: "assignment-1", width: 640, height: 480, receiptTs: 600, overlay: { dataUrl: "saved" } },
    { recoveryKind: "full-submission", assignmentId: "other", width: 640, height: 480, receiptTs: 700, overlay: { dataUrl: "other" } },
    { recoveryKind: "full-submission", assignmentId: "assignment-1", width: 320, height: 240, receiptTs: 800, overlay: { dataUrl: "scaled" } },
    { recoveryKind: "full-submission", assignmentId: "assignment-1", width: 640, height: 480, receiptTs: 100, overlay: { dataUrl: "older" } },
    { recoveryKind: "full-submission", assignmentId: "assignment-1", width: 640, height: 480, receiptTs: 200, overlay: { dataUrl: "newest" } }
  ];

  const resolved = recovery.resolveRecovery(identity, candidates);
  assert.equal(resolved.kind, "full-submission");
  assert.equal(resolved.submission.overlay.dataUrl, "newest");
  assert.equal(resolved.historyMissing, true);
});

test("Restoration uses editable history locally and a flat image for GM fallback", async () => {
  const calls = [];
  const { recovery } = moduleWith();
  const engine = {
    loadOpLog: value => calls.push(["oplog", value]),
    loadOpLogOverCurrentDrawing: value => calls.push(["oplog-over-base", value]),
    loadOverlayRgba: value => calls.push(["rgba", value])
  };
  await recovery.restoreResolvedRecovery(engine, { kind: "local", opLog: { ops: [stroke], pointer: 1 } }, {});
  assert.deepEqual(calls, [["oplog", { ops: [stroke], pointer: 1 }]]);

  const fallbackModule = createRecoveryCopyModule({
    storage: createMapStorageAdapter(new Map()),
    restoreSubmission: async (target, submission) => {
      calls.push(["fallback", submission]);
      target.loadOverlayRgba({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
      return true;
    }
  });
  const submission = { overlay: { dataUrl: "full" } };
  await fallbackModule.restoreResolvedRecovery(engine, { kind: "full-submission", submission }, {});
  assert.equal(calls.at(-2)[0], "fallback");
  assert.equal(calls.at(-1)[0], "rgba");
});

test("A persisted flat fallback is restored before local edits are replayed", async () => {
  const map = new Map();
  const restored = [];
  const moduleA = createRecoveryCopyModule({
    storage: createMapStorageAdapter(map),
    restoreSubmission: async (_engine, submission) => { restored.push(submission.staged.overlayPath); return true; }
  });
  const fallback = { recoveryKind: "full-submission", assignmentId: identity.assignmentId,
    width: identity.width, height: identity.height, receiptTs: 50,
    staged: { overlayPath: "pending/base.webp" } };
  const first = moduleA.resolveRecovery(identity, fallback);
  await moduleA.restoreResolvedRecovery({ loadOpLog() {} }, first, {});
  moduleA.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 });

  const calls = [];
  const moduleB = createRecoveryCopyModule({
    storage: createMapStorageAdapter(map),
    restoreSubmission: async (_engine, submission) => { restored.push(submission.staged.overlayPath); return true; }
  });
  const second = moduleB.resolveRecovery(identity, null);
  await moduleB.restoreResolvedRecovery({
    loadOpLogOverCurrentDrawing: log => calls.push(log),
    loadOpLog: () => assert.fail("base recovery must preserve the restored flat drawing")
  }, second, {});

  assert.deepEqual(restored, ["pending/base.webp", "pending/base.webp"]);
  assert.deepEqual(calls, [{ ops: [stroke], pointer: 1 }]);
});

test("A failed durable-base decode still replays local history over blank and reports degradation", async () => {
  const calls = [];
  const recovery = createRecoveryCopyModule({
    storage: createMapStorageAdapter(new Map()),
    restoreSubmission: async () => false
  });
  const resolution = {
    kind: "local",
    baseSubmission: { staged: { overlayPath: "missing.webp" } },
    opLog: { ops: [stroke], pointer: 1 },
    historyMissing: false
  };

  assert.equal(await recovery.restoreResolvedRecovery({
    loadOpLog: log => calls.push(log),
    loadOpLogOverCurrentDrawing: () => assert.fail("a failed base cannot be retained")
  }, resolution, {}), true);
  assert.deepEqual(calls, [{ ops: [stroke], pointer: 1 }]);
  assert.equal(resolution.historyMissing, true);
});

test("A restored GM fallback becomes the durable flat base for later local recovery", async () => {
  const map = new Map();
  const restoreCalls = [];
  const module = createRecoveryCopyModule({
    storage: createMapStorageAdapter(map),
    restoreSubmission: async (_engine, submission) => {
      restoreCalls.push(submission.overlay.dataUrl);
      return true;
    }
  });
  const fallback = {
    recoveryKind: "full-submission",
    assignmentId: identity.assignmentId,
    width: identity.width,
    height: identity.height,
    receiptTs: 500,
    overlay: { dataUrl: "data:image/webp;base64,flat" }
  };

  const initial = module.resolveRecovery(identity, fallback);
  await module.restoreResolvedRecovery({}, initial, {});
  module.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 });

  const reloaded = module.resolveRecovery(identity, null);
  assert.equal(reloaded.kind, "local");
  assert.equal(reloaded.baseSubmission.overlay.dataUrl, fallback.overlay.dataUrl);
  await module.restoreResolvedRecovery({ loadOpLogOverCurrentDrawing() {} }, reloaded, {});
  assert.deepEqual(restoreCalls, [fallback.overlay.dataUrl, fallback.overlay.dataUrl]);
});

test("Storage failures are non-fatal and warned once per module instance", () => {
  let warnings = 0;
  const storage = { getItem: () => null, removeItem() {}, setItem() { throw new Error("quota"); } };
  const recovery = createRecoveryCopyModule({ storage, warn: () => warnings++ });

  assert.equal(recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 }), false);
  assert.equal(recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 }), false);
  assert.equal(warnings, 1);
});

test("A genuinely new blank assignment does not report missing history", () => {
  const { recovery } = moduleWith();
  assert.deepEqual(recovery.resolveRecovery({ ...identity, existingAssignment: false }, null), {
    kind: "blank",
    historyMissing: false
  });
  assert.equal(recovery.resolveRecovery(identity, null).historyMissing, true);
});

test("Clearing one Recovery copy leaves other assignments intact", () => {
  const { recovery } = moduleWith();
  const sibling = { ...identity, assignmentId: "assignment-2" };
  recovery.saveRecoveryCopy(identity, { ops: [stroke], pointer: 1 });
  recovery.saveRecoveryCopy(sibling, { ops: [stroke], pointer: 1 });

  assert.equal(recovery.clearRecoveryCopy(identity), true);
  assert.equal(recovery.resolveRecovery(identity, null).kind, "blank");
  assert.equal(recovery.resolveRecovery(sibling, null).kind, "local");
});
