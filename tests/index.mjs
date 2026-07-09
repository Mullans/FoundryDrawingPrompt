import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const TEST_FILES = [
  "tests/background-layout.test.mjs",
  "tests/background-source-service.test.mjs",
  "tests/client-store.test.mjs",
  "tests/drawing-engine.test.mjs",
  "tests/fill-tool.test.mjs",
  "tests/operation-log.test.mjs",
  "tests/phase-b-assets.test.mjs",
  "tests/phase-d-helpers.test.mjs",
  "tests/prompt-models.test.mjs",
  "tests/timer-chip.test.mjs"
];

test("repository test suite", () => {
  const result = spawnSync(process.execPath, ["--test", ...TEST_FILES], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
