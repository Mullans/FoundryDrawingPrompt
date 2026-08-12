import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const TEST_FILES = [
  "tests/application-lifecycle.test.mjs",
  "tests/assignment-review.test.mjs",
  "tests/assignment-save.test.mjs",
  "tests/background-layout.test.mjs",
  "tests/background-source-service.test.mjs",
  "tests/canvas-chrome.test.mjs",
  "tests/canvas-place-preview.test.mjs",
  "tests/client-store.test.mjs",
  "tests/drawing-engine.test.mjs",
  "tests/fill-tool.test.mjs",
  "tests/operation-log.test.mjs",
  "tests/path-provider.test.mjs",
  "tests/pending-submission.test.mjs",
  "tests/phase-b-assets.test.mjs",
  "tests/phase-d-helpers.test.mjs",
  "tests/persistence-service.test.mjs",
  "tests/plate-layout.test.mjs",
  "tests/player-navigation.test.mjs",
  "tests/framed-background.test.mjs",
  "tests/framed-delivery.test.mjs",
  "tests/draft-framing-editor.test.mjs",
  "tests/dual-save.test.mjs",
  "tests/e2e-layout.test.mjs",
  "tests/line-tool.test.mjs",
  "tests/manager-canvas-yield.test.mjs",
  "tests/prompt-framing.test.mjs",
  "tests/prompt-service.test.mjs",
  "tests/prompt-models.test.mjs",
  "tests/recent-colors.test.mjs",
  "tests/review-preview.test.mjs",
  "tests/transitions.test.mjs",
  "tests/wire-size.test.mjs",
  "tests/wire-validation.test.mjs",
  "tests/socket-auth.test.mjs",
  "tests/timer-service.test.mjs",
  "tests/timer-update-queue.test.mjs",
  "tests/timer-chip.test.mjs",
  "tests/token-placement.test.mjs",
  "tests/token-transform.test.mjs"
];

test("repository test suite", () => {
  const result = spawnSync(process.execPath, ["--test", ...TEST_FILES], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
