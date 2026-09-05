/**
 * Throw a localized GM-only error when the current user is not a GM.
 * @returns {void}
 */
export function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
}

/**
 * Resolve the socketlib initiator user id from handler context.
 * @param {object} socketContext Handler `this` context.
 * @returns {string|null} Initiator user id.
 */
export function getSocketInitiatorId(socketContext) {
  return socketContext?.socketdata?.userId ?? null;
}

/**
 * Test whether a user id refers to a connected GM.
 * @param {string|null|undefined} userId User id.
 * @param {Iterable<{id: string, isGM?: boolean}>} users User collection.
 * @returns {boolean} Whether the user is a GM.
 */
export function isGmUserId(userId, users) {
  if ( !userId ) return false;
  for ( const user of users ) {
    if ( user.id === userId ) return Boolean(user.isGM);
  }
  return false;
}

/**
 * Assert a socket initiator is a GM, using a Foundry-like users collection.
 * @param {string|null|undefined} userId Initiator user id.
 * @param {Iterable<{id: string, isGM?: boolean}>} users User collection.
 * @returns {void}
 */
export function assertGmInitiator(userId, users) {
  if ( !isGmUserId(userId, users) ) throw new Error("DRAWING-PROMPTS.errors.unauthorizedSocketInitiator");
}

/**
 * Assert prompt metadata references the same GM as the socket initiator.
 * @param {string|null|undefined} initiatorId Socket initiator user id.
 * @param {string|null|undefined} promptGmUserId Prompt owner id from payload.
 * @returns {void}
 */
export function assertPromptGmMatchesInitiator(initiatorId, promptGmUserId) {
  if ( !promptGmUserId || initiatorId !== promptGmUserId ) {
    throw new Error("DRAWING-PROMPTS.errors.unauthorizedSocketInitiator");
  }
}

/**
 * Assert the socket initiator is the player who owns the targeted assignment.
 * The wire `userId` is checked against the initiator first, as defense in depth:
 * a disagreement between the two means the payload is forged or malformed, which
 * is worth rejecting distinctly from a caller who simply targeted an assignment
 * that is not theirs. Only `initiatorId` is authoritative — it comes from
 * `socketdata`, not from the caller's arguments.
 * @param {string|null|undefined} initiatorId Socket initiator user id.
 * @param {string|null|undefined} wireUserId Player user id supplied by the caller.
 * @param {string|null|undefined} assignmentUserId Assignment owner user id.
 * @returns {void}
 */
export function assertSenderOwnsAssignment(initiatorId, wireUserId, assignmentUserId) {
  if ( !initiatorId || initiatorId !== wireUserId ) {
    throw new Error("DRAWING-PROMPTS.errors.unauthorizedSocketInitiator");
  }
  if ( !assignmentUserId || initiatorId !== assignmentUserId ) {
    throw new Error("DRAWING-PROMPTS.errors.notYourAssignment");
  }
}
