/**
 * Refresh the GM manager if present.
 * @returns {Promise<void>}
 */
export async function refreshManager() {
  if ( !game.user.isGM ) return;
  const { DrawingPromptManager } = await import("../apps/drawing-prompt-manager.mjs");
  await DrawingPromptManager.refreshOpen();
}

/**
 * Update the manager's window-open state.
 * @param {string} assignmentId Assignment id.
 * @param {boolean} open Whether open.
 * @returns {Promise<void>}
 */
export async function setManagerWindowOpen(assignmentId, open) {
  if ( !game.user.isGM ) return;
  const { DrawingPromptManager } = await import("../apps/drawing-prompt-manager.mjs");
  DrawingPromptManager.setWindowOpen(assignmentId, open);
}

/**
 * Deliver a snapshot to the open manager, if any.
 * @param {string} assignmentId Assignment id.
 * @param {string|{composite?: string, overlay?: string}} snapshotPayload Snapshot payload.
 * @returns {void}
 */
export function receiveManagerSnapshot(assignmentId, snapshotPayload) {
  if ( !game.user.isGM ) return;
  void import("../apps/drawing-prompt-manager.mjs").then(({ DrawingPromptManager }) => {
    DrawingPromptManager.receiveSnapshotOpen(assignmentId, snapshotPayload);
  });
}
