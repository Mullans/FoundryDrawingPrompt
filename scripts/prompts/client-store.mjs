const assignments = new Map();

/**
 * Store or replace a player-side assignment payload.
 * @param {{assignment: object, prompt: object}} payload Assignment payload.
 * @returns {{assignment: object, prompt: object}|null}
 */
export function upsertAssignment(payload) {
  if ( payload?.assignment?.userId !== game.user.id ) return null;
  assignments.set(payload.assignment.id, {
    assignment: { ...payload.assignment },
    prompt: { ...payload.prompt }
  });
  return getAssignment(payload.assignment.id);
}

/**
 * Get a stored assignment payload for this user.
 * @param {string} assignmentId Assignment id.
 * @returns {{assignment: object, prompt: object}|null}
 */
export function getAssignment(assignmentId) {
  const payload = assignments.get(assignmentId);
  if ( payload?.assignment?.userId !== game.user.id ) return null;
  return payload ?? null;
}

/**
 * List this user's session-known assignments.
 * @returns {{assignment: object, prompt: object}[]}
 */
export function listAssignments() {
  return Array.from(assignments.values())
    .filter(payload => payload.assignment.userId === game.user.id)
    .sort((a, b) => Number(b.prompt.sentAt ?? 0) - Number(a.prompt.sentAt ?? 0));
}

/**
 * Update a stored assignment status.
 * @param {string} assignmentId Assignment id.
 * @param {string} status New status.
 * @returns {{assignment: object, prompt: object}|null}
 */
export function updateStatus(assignmentId, status) {
  const payload = getAssignment(assignmentId);
  if ( !payload ) return null;
  payload.assignment.status = status;
  assignments.set(assignmentId, payload);
  return payload;
}
