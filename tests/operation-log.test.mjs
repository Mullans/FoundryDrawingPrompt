import assert from "node:assert/strict";
import { test } from "node:test";

import { OperationLog } from "../scripts/drawing/operation-log.mjs";

test("OperationLog appends active operations and truncates redo tail", () => {
  const log = new OperationLog();
  const first = { id: "op1", type: "stroke", ts: 1, points: [{ x: 1, y: 2 }] };
  const second = { id: "op2", type: "clear", ts: 2 };
  const replacement = { id: "op3", type: "fill", ts: 3, seed: { x: 0, y: 0 }, color: "#ff0000" };

  log.append(first);
  log.append(second);
  assert.deepEqual(log.activeOps, [first, second]);

  assert.equal(log.undo(), 1);
  log.append(replacement);

  assert.deepEqual(log.activeOps, [first, replacement]);
  assert.deepEqual(log.toJSON(), { ops: [first, replacement], pointer: 2 });
  assert.equal(log.redo(), null);
});

test("OperationLog undo and redo move the active pointer within bounds", () => {
  const log = new OperationLog();
  log.append({ id: "op1", type: "stroke", ts: 1 });
  log.append({ id: "op2", type: "erase", ts: 2 });

  assert.equal(log.undo(), 1);
  assert.deepEqual(log.activeOps.map(op => op.id), ["op1"]);
  assert.equal(log.undo(), 0);
  assert.deepEqual(log.activeOps, []);
  assert.equal(log.undo(), null);

  assert.equal(log.redo(), 1);
  assert.deepEqual(log.activeOps.map(op => op.id), ["op1"]);
  assert.equal(log.redo(), 2);
  assert.deepEqual(log.activeOps.map(op => op.id), ["op1", "op2"]);
  assert.equal(log.redo(), null);
});
