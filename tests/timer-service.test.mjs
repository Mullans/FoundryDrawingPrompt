import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adjustTimer,
  evaluateSubmissionTiming,
  isTimerExpired,
  normalizeTimerState,
  pauseTimer,
  resetTimer,
  resumeTimer,
  stopTimer
} from "../scripts/prompts/timer-service.mjs";

test("timer normalization canonicalizes legacy deadlines and rejects non-finite values", () => {
  assert.deepEqual(normalizeTimerState({ deadlineAt: 61_000 }), {
    timerStatus: "running",
    deadlineAt: 61_000,
    remainingMs: null
  });
  assert.deepEqual(normalizeTimerState({ timerStatus: "running", deadlineAt: Number.POSITIVE_INFINITY }), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(normalizeTimerState({ timerStatus: "paused", remainingMs: Number.NaN }), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
});

test("pause and resume preserve the remaining running time", () => {
  const paused = pauseTimer({ timerStatus: "running", deadlineAt: 300_000, remainingMs: null }, 240_000);
  assert.deepEqual(paused, { timerStatus: "paused", deadlineAt: null, remainingMs: 60_000 });

  assert.deepEqual(resumeTimer(paused, 500_000), {
    timerStatus: "running",
    deadlineAt: 560_000,
    remainingMs: null
  });
});

test("pause and resume preserve negative overtime", () => {
  const paused = pauseTimer({ timerStatus: "running", deadlineAt: 100_000, remainingMs: null }, 103_000);
  assert.deepEqual(paused, { timerStatus: "paused", deadlineAt: null, remainingMs: -3_000 });

  assert.deepEqual(resumeTimer(paused, 200_000), {
    timerStatus: "running",
    deadlineAt: 197_000,
    remainingMs: null
  });
});

test("adjusting a running timer shifts its deadline without restarting it", () => {
  const oneMinuteLeft = { timerStatus: "running", deadlineAt: 360_000, remainingMs: null };
  assert.deepEqual(adjustTimer(oneMinuteLeft, 120_000, 300_000), {
    timerStatus: "running",
    deadlineAt: 480_000,
    remainingMs: null
  });
});

test("extending a running timer in overtime moves the existing deadline", () => {
  const threeMinutesOvertime = { timerStatus: "running", deadlineAt: 120_000, remainingMs: null };
  const adjusted = adjustTimer(threeMinutesOvertime, 120_000, 300_000);

  assert.deepEqual(adjusted, { timerStatus: "running", deadlineAt: 240_000, remainingMs: null });
  assert.deepEqual(evaluateSubmissionTiming(adjusted, 300_000), { late: true, overtimeMs: 60_000 });
});

test("adjusting a paused timer shifts its frozen clock including across zero", () => {
  assert.deepEqual(
    adjustTimer({ timerStatus: "paused", deadlineAt: null, remainingMs: 30_000 }, -60_000, 500_000),
    { timerStatus: "paused", deadlineAt: null, remainingMs: -30_000 }
  );
  assert.deepEqual(
    adjustTimer({ timerStatus: "paused", deadlineAt: null, remainingMs: -90_000 }, 120_000, 500_000),
    { timerStatus: "paused", deadlineAt: null, remainingMs: 30_000 }
  );
});

test("reset restarts the original duration and stop clears timer state", () => {
  const reset = resetTimer({ timerStatus: "paused", deadlineAt: null, remainingMs: -90_000 }, 300, 1_000_000);
  assert.deepEqual(reset, { timerStatus: "running", deadlineAt: 1_300_000, remainingMs: null });
  assert.deepEqual(stopTimer(reset), { timerStatus: "none", deadlineAt: null, remainingMs: null });
});

test("expiry is derived only for a running timer strictly past its deadline", () => {
  assert.equal(isTimerExpired({ timerStatus: "running", deadlineAt: 10_000, remainingMs: null }, 10_000), false);
  assert.equal(isTimerExpired({ timerStatus: "running", deadlineAt: 10_000, remainingMs: null }, 10_001), true);
  assert.equal(isTimerExpired({ timerStatus: "paused", deadlineAt: null, remainingMs: -1 }, 10_001), false);
  assert.equal(isTimerExpired({ timerStatus: "none", deadlineAt: null, remainingMs: null }, 10_001), false);
});

test("submission timing is judged against the running deadline at event time", () => {
  const running = { timerStatus: "running", deadlineAt: 10_000, remainingMs: null };
  assert.deepEqual(evaluateSubmissionTiming(running, 10_000), { late: false, overtimeMs: null });
  assert.deepEqual(evaluateSubmissionTiming(running, 12_500), { late: true, overtimeMs: 2_500 });
});

test("paused and untimed submissions are never late", () => {
  assert.deepEqual(
    evaluateSubmissionTiming({ timerStatus: "paused", deadlineAt: null, remainingMs: -30_000 }, 500_000),
    { late: false, overtimeMs: null }
  );
  assert.deepEqual(
    evaluateSubmissionTiming({ timerStatus: "none", deadlineAt: null, remainingMs: null }, 500_000),
    { late: false, overtimeMs: null }
  );
});

test("invalid transition inputs never produce non-finite timer values", () => {
  const running = { timerStatus: "running", deadlineAt: 10_000, remainingMs: null };
  const paused = { timerStatus: "paused", deadlineAt: null, remainingMs: -5_000 };

  assert.deepEqual(pauseTimer(running, Number.NaN), running);
  assert.deepEqual(resumeTimer(paused, Number.POSITIVE_INFINITY), paused);
  assert.deepEqual(resetTimer(running, Number.NaN, 20_000), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(resetTimer(running, 60, Number.NEGATIVE_INFINITY), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(resetTimer(running, -1, 20_000), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(evaluateSubmissionTiming(running, Number.NaN), { late: false, overtimeMs: null });
  assert.equal(isTimerExpired(running, Number.POSITIVE_INFINITY), false);
});

test("finite inputs that overflow arithmetic leave timer state JSON-finite", () => {
  const latest = { timerStatus: "running", deadlineAt: Number.MAX_VALUE, remainingMs: null };
  const earliest = { timerStatus: "running", deadlineAt: -Number.MAX_VALUE, remainingMs: null };
  const longPause = { timerStatus: "paused", deadlineAt: null, remainingMs: Number.MAX_VALUE };

  assert.deepEqual(pauseTimer(latest, -Number.MAX_VALUE), latest);
  assert.deepEqual(resumeTimer(longPause, Number.MAX_VALUE), longPause);
  assert.deepEqual(adjustTimer(latest, Number.MAX_VALUE, 0), latest);
  assert.deepEqual(adjustTimer(longPause, Number.MAX_VALUE, 0), longPause);
  assert.deepEqual(resetTimer(latest, Number.MAX_VALUE, 0), {
    timerStatus: "none",
    deadlineAt: null,
    remainingMs: null
  });
  assert.deepEqual(evaluateSubmissionTiming(earliest, Number.MAX_VALUE), { late: true, overtimeMs: null });
});
