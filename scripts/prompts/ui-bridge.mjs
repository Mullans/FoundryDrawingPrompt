/**
 * Refresh the GM manager if present.
 * @returns {Promise<void>}
 */
export async function refreshManager() {
  if ( !game.user.isGM ) return;
  const { DrawingPromptManager } = await import("../apps/drawing-prompt-manager.mjs");
  DrawingPromptManager.refreshOpen();
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
 * @param {string} dataUrl Snapshot data URL.
 * @returns {void}
 */
export function receiveManagerSnapshot(assignmentId, dataUrl) {
  if ( !game.user.isGM ) return;
  void import("../apps/drawing-prompt-manager.mjs").then(({ DrawingPromptManager }) => {
    DrawingPromptManager.receiveSnapshotOpen(assignmentId, dataUrl);
  });
}
