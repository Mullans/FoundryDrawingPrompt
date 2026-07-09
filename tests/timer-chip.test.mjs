import assert from "node:assert/strict";
import { test } from "node:test";

import { formatTimerChip } from "../scripts/utils/timer-chip.mjs";

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
