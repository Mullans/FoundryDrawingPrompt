import assert from "node:assert/strict";
import { test } from "node:test";

import { createRecoverySaveCoordinator } from "../scripts/drawing/recovery-save-coordinator.mjs";

test("a committed action starts artwork publication before deferred history", async () => {
  const calls = [];
  let deferred;
  const coordinator = createRecoverySaveCoordinator({
    store: { save: async (...args) => calls.push(args) },
    schedule: callback => { deferred = callback; return 1; },
    cancel: () => {},
    warn: error => { throw error; }
  });
  const identity = { assignmentId: "assignment" };
  const snapshot = { cursor: 1 };

  coordinator.changed(identity, snapshot);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [identity, snapshot, { artworkOnly: true }]);

  deferred();
  await coordinator.settled();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [identity, snapshot, { artworkOnly: false }]);
});

test("a newer action publishes its artwork immediately while an older save is unresolved", async () => {
  const calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const coordinator = createRecoverySaveCoordinator({
    store: { save: async (...args) => { calls.push(args); if ( calls.length === 1 ) await blocked; } },
    schedule: () => 1,
    cancel: () => {},
    warn: error => { throw error; }
  });
  const identity = { assignmentId: "assignment" };

  coordinator.changed(identity, { cursor: 1 });
  coordinator.changed(identity, { cursor: 2 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].cursor, 2);
  release();
  await coordinator.settled();
});
