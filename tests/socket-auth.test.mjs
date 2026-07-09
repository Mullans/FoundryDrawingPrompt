import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertGmInitiator,
  assertPromptGmMatchesInitiator,
  isGmUserId
} from "../scripts/prompts/socket-auth.mjs";

const USERS = [
  { id: "gm1", isGM: true },
  { id: "player1", isGM: false }
];

test("isGmUserId identifies GM users", () => {
  assert.equal(isGmUserId("gm1", USERS), true);
  assert.equal(isGmUserId("player1", USERS), false);
  assert.equal(isGmUserId("missing", USERS), false);
});

test("assertGmInitiator rejects non-GM initiators", () => {
  assert.throws(() => assertGmInitiator("player1", USERS));
  assert.doesNotThrow(() => assertGmInitiator("gm1", USERS));
});

test("assertPromptGmMatchesInitiator requires matching GM ids", () => {
  assert.throws(() => assertPromptGmMatchesInitiator("gm1", "player1"));
  assert.throws(() => assertPromptGmMatchesInitiator("gm1", null));
  assert.doesNotThrow(() => assertPromptGmMatchesInitiator("gm1", "gm1"));
});
