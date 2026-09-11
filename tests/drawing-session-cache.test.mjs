import assert from "node:assert/strict";
import { test } from "node:test";

import { DrawingSessionCache } from "../scripts/drawing/drawing-session-cache.mjs";

const identity = { worldId: "world", gmUserId: "gm", userId: "player", promptId: "prompt", assignmentId: "assignment", width: 2048, height: 2048 };

test("retained sessions require the complete drawing identity", () => {
  const cache = new DrawingSessionCache();
  const engine = fakeEngine(10);
  cache.retain(identity, engine);

  assert.equal(cache.take({ ...identity, userId: "other" }), null);
  assert.equal(cache.take(identity), engine);
  assert.equal(cache.size, 0);
});

test("retained session cache evicts least-recently-retained engines over 128 MiB", () => {
  let time = 0;
  const cache = new DrawingSessionCache({ budgetBytes: 128, now: () => ++time });
  const first = fakeEngine(80);
  const second = fakeEngine(80);
  cache.retain(identity, first);
  cache.retain({ ...identity, assignmentId: "second" }, second);

  assert.equal(first.destroyed, true);
  assert.equal(cache.take(identity), null);
  assert.equal(cache.take({ ...identity, assignmentId: "second" }), second);
});

test("permanent invalidation destroys a retained engine", () => {
  const cache = new DrawingSessionCache();
  const engine = fakeEngine(10);
  cache.retain(identity, engine);
  cache.invalidate(identity);
  assert.equal(engine.destroyed, true);
  assert.equal(cache.take(identity), null);
});

function fakeEngine(recoveryBytes) {
  return { recoveryBytes, destroyed: false, destroy() { this.destroyed = true; } };
}
