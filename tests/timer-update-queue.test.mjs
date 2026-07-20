import assert from "node:assert/strict";
import { test } from "node:test";

import { TimerUpdateQueue } from "../scripts/prompts/timer-update-queue.mjs";

test("timer update queue serializes each prompt and recovers after rejection", async () => {
  const queue = new TimerUpdateQueue();
  const events = [];
  let releaseFirst;
  let reportBothStarted;
  let started = 0;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const bothStarted = new Promise(resolve => { reportBothStarted = resolve; });
  const recordStart = event => {
    events.push(event);
    started += 1;
    if ( started === 2 ) reportBothStarted();
  };

  const first = queue.enqueue("p1", async () => {
    recordStart("first-start");
    await firstGate;
    events.push("first-end");
    throw new Error("first failed");
  });
  const second = queue.enqueue("p1", async () => {
    events.push("second");
    return 2;
  });
  const otherPrompt = queue.enqueue("p2", async () => {
    recordStart("other");
    return 3;
  });

  await bothStarted;
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 2);
  assert.equal(await otherPrompt, 3);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
  assert.equal(queue.size, 0);
});
