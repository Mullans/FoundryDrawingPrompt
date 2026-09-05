/**
 * Prompt lifecycle — create/send, finish, cancel, reopen, resend, redeliver.
 */

import { FILES_UPLOAD_PERMISSION, STATUS } from "../constants.mjs";
import { emit } from "../socket.mjs";
import { ensureDir, stagingDir } from "./asset-service.mjs";
import { clearFramingViewAssets, hasSavedFramingViewAssets } from "./dual-save.mjs";
import { prepareFramedBackgroundForSend } from "./framed-delivery.mjs";
import { clearPendingSubmission, resolveRestorationSubmission, setPendingSubmission } from "./pending-submission.mjs";
import {
  createPromptEntry,
  deletePromptEntry,
  loadAllPrompts,
  loadPrompt,
  savePrompt
} from "./persistence-service.mjs";
import { assertPromptOwner, requirePromptAssignment } from "./prompt-context.mjs";
import {
  deliverPromptAssignments,
  ensureFramedBackgroundDelivered,
  payloadFor,
  payloadForReopen
} from "./prompt-delivery.mjs";
import { DrawingPrompt } from "./prompt-models.mjs";
import { assertGM } from "./socket-auth.mjs";
import { refreshManager, setManagerWindowOpen } from "./ui-bridge.mjs";

/**
 * Create, persist, and send a prompt. Inactive users remain pending for later resend.
 * @param {object} draft Prompt draft.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export async function createAndSendPrompt(draft) {
  assertGM();
  const sentAt = Date.now();
  const timerSeconds = Number(draft.timerSeconds || 0);
  const prompt = DrawingPrompt.create({
    promptText: draft.promptText,
    drawingName: draft.drawingName,
    canvasWidth: Number(draft.canvasWidth),
    canvasHeight: Number(draft.canvasHeight),
    background: { ...draft.background },
    timerSeconds,
    sentAt,
    timerStatus: timerSeconds > 0 ? "running" : "none",
    deadlineAt: timerSeconds > 0 ? sentAt + (timerSeconds * 1000) : null,
    remainingMs: null
  }, draft.selectedUserIds);

  await createPromptEntry(prompt);
  try {
    await prepareFramedBackgroundForSend(prompt);
    // Prompt creation requires a full save to establish prompt-level and all assignment state.
    await savePrompt(prompt);
  } catch (err) {
    // Compensate: a failed Send must not leave a sticky undelivered prompt (retry would duplicate).
    try {
      await deletePromptEntry(prompt.id);
    } catch (cleanupError) {
      console.warn("drawing-prompts | could not remove prompt after failed send prep", cleanupError);
    }
    throw err;
  }
  Hooks.callAll("drawing-prompts.promptCreated", prompt);

  if ( Object.values(prompt.assignments).some(a => game.users.get(a.userId)?.can(FILES_UPLOAD_PERMISSION)) ) {
    try {
      await ensureDir(stagingDir());
    } catch (err) {
      console.warn("drawing-prompts | could not pre-create staging directory", err);
    }
  }

  const deliveries = await deliverPromptAssignments(prompt);
  if ( draft.awaitDeliveries ) await deliveries;
  return prompt;
}

/**
 * Create and send a drawing prompt via the public API.
 * @param {object} options Prompt options.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export async function createPrompt(options = {}) {
  const { awaitDeliveries, ...draft } = options;
  return createAndSendPrompt({ ...draft, awaitDeliveries });
}

/**
 * Cancel one assignment.
 * @param {string} assignmentId Assignment id.
 * @param {string|null} [userId] Optional user id guard.
 * @returns {Promise<void>}
 */
export async function cancelAssignment(assignmentId, userId = null) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  if ( userId && assignment.userId !== userId ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  assignment.markCancelled(Date.now());
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  if ( game.users.get(assignment.userId)?.active ) await emit.cancelDrawingPrompt(assignment.userId, assignment.id);
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentCancelled", prompt, assignment);
  await setManagerWindowOpen(assignment.id, false);
  await refreshManager();
}

/**
 * Cancel all active assignments for a prompt.
 * @param {string} promptId Prompt id.
 * @returns {Promise<void>}
 */
export async function cancelAllAssignments(promptId) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  for ( const assignment of Object.values(prompt.assignments) ) {
    if ( assignment.isActive ) await cancelAssignment(assignment.id);
  }
}

/**
 * Finish a prompt, cancelling still-active assignments and dropping unsaved submission payloads.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export async function finishPrompt(promptId) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  const now = Date.now();
  for ( const assignment of Object.values(prompt.assignments) ) {
    if ( assignment.isActive ) {
      assignment.markCancelled(now);
      if ( game.users.get(assignment.userId)?.active ) await emit.cancelDrawingPrompt(assignment.userId, assignment.id);
      Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
      Hooks.callAll("drawing-prompts.assignmentCancelled", prompt, assignment);
      await setManagerWindowOpen(assignment.id, false);
    }
    clearPendingSubmission(assignment.id);
  }
  await deletePromptEntry(promptId);
  await refreshManager();
  return prompt;
}

/**
 * Reopen a submitted or rejected assignment.
 * @param {string} assignmentId Assignment id.
 * @param {string|null} [userId] Optional user id guard.
 * @returns {Promise<void>}
 */
export async function reopenAssignment(assignmentId, userId = null) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  if ( userId && assignment.userId !== userId ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  const restorationSubmission = await resolveRestorationSubmission(assignment, prompt);
  if ( hasSavedFramingViewAssets(assignment) ) clearFramingViewAssets(assignment);
  assignment.markReopened();
  if ( restorationSubmission ) {
    setPendingSubmission(assignment.id, restorationSubmission);
  }
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  await ensureFramedBackgroundDelivered(prompt);
  if ( game.users.get(assignment.userId)?.active ) {
    await emit.reopenDrawingPrompt(
      assignment.userId,
      payloadForReopen(prompt, assignment, restorationSubmission)
    );
  }
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentReopened", prompt, assignment);
  await refreshManager();
}

/**
 * Resend an assignment to an active user.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
export async function resendAssignment(assignmentId) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  if ( assignment.status === STATUS.CANCELLED ) {
    assignment.markResent();
    await savePrompt(prompt, { assignmentOnly: assignment.id });
  } else if ( ![STATUS.PENDING, STATUS.OPENED].includes(assignment.status) ) {
    return;
  }
  if ( game.users.get(assignment.userId)?.active ) {
    await ensureFramedBackgroundDelivered(prompt);
    await emit.openDrawingPrompt(assignment.userId, payloadFor(prompt, assignment));
    Hooks.callAll("drawing-prompts.assignmentSent", prompt, assignment);
  }
  await refreshManager();
}

/**
 * Deliver pending/opened assignments of this GM's active prompts to a user who
 * just connected, so late joiners and reloaded players receive their prompt
 * without a manual resend.
 * @param {string} userId Connected user id.
 * @returns {Promise<void>}
 */
export async function redeliverAssignmentsForUser(userId) {
  if ( !game.user.isGM ) return;
  for ( const prompt of loadAllPrompts({ activeOnly: true }) ) {
    if ( prompt.gmUserId !== game.user.id ) continue;
    const assignment = prompt.assignmentForUser(userId);
    if ( assignment && [STATUS.PENDING, STATUS.OPENED].includes(assignment.status) ) {
      await resendAssignment(assignment.id);
    }
  }
}

/**
 * Resend all pending or cancelled assignments for a prompt.
 * @param {string} promptId Prompt id.
 * @returns {Promise<void>}
 */
export async function resendAllAssignments(promptId) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  for ( const assignment of Object.values(prompt.assignments) ) {
    if ( [STATUS.PENDING, STATUS.OPENED, STATUS.CANCELLED].includes(assignment.status) ) await resendAssignment(assignment.id);
  }
}

/**
 * Ask the player client to show a drawing window.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
export async function showPlayerWindow(assignmentId) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  if ( !game.users.get(assignment.userId)?.active ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.manager.warnings.userOffline"));
    return;
  }
  await emit.showDrawingPrompt(assignment.userId, assignment.id);
}
