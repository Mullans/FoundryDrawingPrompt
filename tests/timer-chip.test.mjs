import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTimerAdjustment, formatTimerChip, formatTimerState } from "../scripts/utils/timer-chip.mjs";

test("formatTimerChip shows remaining whole seconds before the deadline", () => {
  assert.deepEqual(formatTimerChip(125_000, 5_000), {
    text: "02:00 left",
    overtime: false
  });
});

test("formatTimerChip shows overtime after the deadline", () => {
  assert.deepEqual(formatTimerChip(60_000, 65_200), {
    text: "+00:06 over",
    overtime: true
  });
});

test("formatTimerChip returns an empty non-overtime chip without a deadline", () => {
  assert.deepEqual(formatTimerChip(null, 65_200), {
    text: "",
    overtime: false
  });
});

test("formatTimerState renders running and paused clocks from the same state shape", () => {
  assert.deepEqual(formatTimerState({ timerStatus: "running", deadlineAt: 125_000, remainingMs: null }, 5_000), {
    text: "02:00 left",
    overtime: false
  });
  assert.deepEqual(formatTimerState({ timerStatus: "paused", deadlineAt: null, remainingMs: 90_000 }, 999_000), {
    text: "01:30 left",
    overtime: false
  });
});

test("formatTimerState freezes paused overtime and hides stopped timers", () => {
  assert.deepEqual(formatTimerState({ timerStatus: "paused", deadlineAt: null, remainingMs: -5_200 }, 999_000), {
    text: "+00:06 over",
    overtime: true
  });
  assert.deepEqual(formatTimerState({ timerStatus: "none", deadlineAt: null, remainingMs: null }, 999_000), {
    text: "",
    overtime: false
  });
});

test("formatTimerAdjustment produces compact signed button labels", () => {
  assert.equal(formatTimerAdjustment(30, 1), "+30s");
  assert.equal(formatTimerAdjustment(120, 1), "+2m");
  assert.equal(formatTimerAdjustment(30, -1), "−30s");
  assert.equal(formatTimerAdjustment(150, -1), "−2m 30s");
});
