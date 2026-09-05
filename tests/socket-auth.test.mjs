import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertGmInitiator,
  assertPromptGmMatchesInitiator,
  assertSenderOwnsAssignment,
  getSocketInitiatorId,
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

test("getSocketInitiatorId reads the socketlib sender identity", () => {
  assert.equal(getSocketInitiatorId({ socketdata: { userId: "player1" } }), "player1");
  assert.equal(getSocketInitiatorId({ socketdata: {} }), null);
  assert.equal(getSocketInitiatorId(undefined), null);
});

test("assertSenderOwnsAssignment accepts the assignment owner's own call", () => {
  assert.doesNotThrow(() => assertSenderOwnsAssignment("player1", "player1", "player1"));
});

test("assertSenderOwnsAssignment rejects a sender spoofing another player", () => {
  // The attack: player1 emits drawingSubmitted(player2Assignment, "player2", …).
  assert.throws(
    () => assertSenderOwnsAssignment("player1", "player2", "player2"),
    /unauthorizedSocketInitiator/
  );
});

test("assertSenderOwnsAssignment rejects a wire userId that disagrees with the initiator", () => {
  assert.throws(
    () => assertSenderOwnsAssignment("player1", "player2", "player1"),
    /unauthorizedSocketInitiator/
  );
});

test("assertSenderOwnsAssignment rejects a sender targeting someone else's assignment", () => {
  assert.throws(
    () => assertSenderOwnsAssignment("player1", "player1", "player2"),
    /notYourAssignment/
  );
});

test("assertSenderOwnsAssignment fails closed on a missing initiator", () => {
  for ( const initiator of [null, undefined, ""] ) {
    assert.throws(
      () => assertSenderOwnsAssignment(initiator, initiator, initiator),
      /unauthorizedSocketInitiator/,
      `expected rejection for initiator ${JSON.stringify(initiator)}`
    );
  }
});

test("assertSenderOwnsAssignment fails closed on a missing assignment owner", () => {
  assert.throws(
    () => assertSenderOwnsAssignment("player1", "player1", null),
    /notYourAssignment/
  );
});
