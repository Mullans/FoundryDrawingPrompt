/**
 * Thin prompt-service adapter — re-exports use-case modules for API/socket
 * compatibility. Prefer importing from the deep modules when adding new callers.
 *
 * Remains here (SCR-29):
 * - UI open helpers (manager / player list)
 * - Save entry wrapper (auth + pending resolution around {@link saveAssignmentAssets})
 * - Public re-exports preserving `import … from "./prompt-service.mjs"` and `api.mjs`
 *
 * Carved out:
 * - {@link ./prompt-lifecycle.mjs} — create/send/finish/reopen/resend/cancel/redeliver
 * - {@link ./assignment-placement.mjs} — Place Tile/Token + Transform
 * - {@link ./pending-submission.mjs} — pending store, cache, restoration payloads
 * - {@link ./prompt-timer-bridge.mjs} — timer wrappers over timer-service
 * - {@link ./prompt-socket-handlers.mjs} — socket handler registration
 * - {@link ./prompt-delivery.mjs} — wire payloads + GM→player delivery
 * - {@link ./prompt-context.mjs} — lookup / ownership helpers
 */

import { STATUS } from "../constants.mjs";
import { PlayerPromptList } from "../apps/player-prompt-list.mjs";
import { saveAssignmentAssets } from "./assignment-save.mjs";
import { defaultAssignmentAssetName } from "./naming-service.mjs";
import {
  clearPendingSubmission,
  peekMemoryOrCachedSubmission
} from "./pending-submission.mjs";
import { savePrompt } from "./persistence-service.mjs";
import { assertPromptOwner, requirePromptAssignment } from "./prompt-context.mjs";
import { assertGM } from "./socket-auth.mjs";
import { refreshManager } from "./ui-bridge.mjs";

export { stagedFetchUrl } from "./assignment-save.mjs";
export {
  applyAssignmentTransform,
  placeAssignmentAsTile,
  placeAssignmentAsToken
} from "./assignment-placement.mjs";
export {
  buildRestorationSubmissionFromSavedAssets,
  buildRestorationSubmissionFromRetainedCapture,
  getPendingSubmission
} from "./pending-submission.mjs";
export { getAssignment, getPrompt } from "./prompt-context.mjs";
export {
  cancelAllAssignments,
  cancelAssignment,
  createAndSendPrompt,
  createPrompt,
  retryPromptDeliveries,
  continuePromptDeliveries,
  invitePromptRecipients,
  processRecoveryTombstonesForUser,
  closePrompt,
  reopenPrompt,
  archivePrompt,
  restorePrompt,
  deletePrompt,
  finishPrompt,
  redeliverAssignmentsForUser,
  reopenAssignment,
  resendAllAssignments,
  resendAssignment,
  showPlayerWindow
} from "./prompt-lifecycle.mjs";
export { getSocketHandlers } from "./prompt-socket-handlers.mjs";
export {
  adjustPromptTimer,
  pausePromptTimer,
  resetPromptTimer,
  resumePromptTimer,
  stopPromptTimer
} from "./prompt-timer-bridge.mjs";

/**
 * Open the GM prompt manager.
 * @returns {Promise<void>}
 */
export async function openPromptManager() {
  if ( !game.user.isGM ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    return;
  }
  const { DrawingPromptManager } = await import("../apps/drawing-prompt-manager.mjs");
  await DrawingPromptManager.open();
}

/** Open the singleton Closed/Archived Prompt library. */
export async function openPromptLibrary() {
  if ( !game.user.isGM ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    return;
  }
  const { PromptLibrary } = await import("../apps/prompt-library.mjs");
  await PromptLibrary.open();
}

/**
 * Open the player prompt list.
 * @returns {Promise<void>}
 */
export async function openPlayerPromptList() {
  await PlayerPromptList.open();
}

/**
 * Save assignment assets (public GM entry).
 * Dual Framing View write + Save gate live in {@link saveAssignmentAssets}; this
 * wrapper owns auth, pending resolution, journal persist, and hooks only.
 * @param {string} assignmentId Assignment id.
 * @param {{name?: string, folder?: string}} [options] Save options.
 * @returns {Promise<import("./prompt-models.mjs").DrawingAssignment>}
 */
export async function saveAssignment(assignmentId, { name, folder } = {}) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  const resolvedName = resolveDrawingName(prompt, name);
  if ( !resolvedName ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.nameRequired"));

  const alreadySaved = Boolean(assignment.primaryImagePath && assignment.assets?.overlayPath);
  const submission = peekMemoryOrCachedSubmission(assignment.id);
  if ( !submission && !alreadySaved ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.pendingSubmissionLost"));

  if ( submission ) {
    await saveAssignmentAssets({
      prompt,
      assignment,
      submission,
      name: resolvedName,
      folder
    });
    clearPendingSubmission(assignment.id);
  } else if ( alreadySaved && assignment.status === STATUS.SUBMITTED && assignment.primaryImagePath ) {
    assignment.savedSubmissionTs ??= assignment.submittedAt;
    assignment.assets.name = resolvedName;
  }

  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentSaved", prompt, assignment);
  await refreshManager();
  return assignment;
}

/**
 * Resolve a non-empty drawing asset name.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {string|undefined} explicitName Explicit name.
 * @returns {string}
 */
function resolveDrawingName(prompt, explicitName) {
  return String(explicitName ?? defaultAssignmentAssetName({
    drawingName: prompt.drawingName,
    promptText: prompt.promptText
  })).trim();
}
