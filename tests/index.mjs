import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Discover every test file in this directory.
 * Derived rather than hand-listed: a hardcoded list silently skips any file
 * someone forgets to register, and the suite stays green while it does (SCR-39).
 * @returns {string[]} Absolute paths, sorted for stable ordering.
 */
function discoverTestFiles() {
  return readdirSync(TEST_DIR)
    .filter(name => name.endsWith(".test.mjs"))
    .sort()
    .map(name => join(TEST_DIR, name));
}

test("repository test suite", () => {
  const testFiles = discoverTestFiles();
  assert.ok(testFiles.length > 0, `no *.test.mjs files discovered in ${TEST_DIR}`);

  // Strip NODE_TEST_CONTEXT before spawning. When this file is itself run by
  // `node --test`, the child inherits that variable, and the nested runner then
  // reports success no matter what the inner tests do -- the suite silently
  // gates nothing. Verified: with it inherited, a deliberately failing test file
  // still exits 0.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    cwd: process.cwd(),
    encoding: "utf8",
    env
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});
