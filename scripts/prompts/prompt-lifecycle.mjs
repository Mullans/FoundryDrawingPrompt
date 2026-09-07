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
import { DrawingAssignment, DrawingPrompt } from "./prompt-models.mjs";
import { assertGM } from "./socket-auth.mjs";
import { refreshManager, setManagerWindowOpen } from "./ui-bridge.mjs";

/**
 * Create, persist, and send a prompt. Inactive users remain pending for later resend.
 * @param {object} draft Prompt draft.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export async function createAndSendPrompt(draft) {
  assertGM();
  const started = performance.now();
  const selectedUserIds = [...new Set(draft.selectedUserIds ?? [])];
  if ( !selectedUserIds.length || selectedUserIds.some(id => !game.users.get(id)?.active || game.users.get(id)?.isGM) ) {
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.onlineRecipientsRequired"));
  }
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
  }, selectedUserIds);

  const storageStarted = performance.now();
  await createPromptEntry(prompt);
  Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, stage: "storage-create", elapsedMs: performance.now() - storageStarted });
  try {
    const framingStarted = performance.now();
    await prepareFramedBackgroundForSend(prompt);
    Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, stage: "framing", elapsedMs: performance.now() - framingStarted });
    // Prompt creation requires a full save to establish prompt-level and all assignment state.
    const saveStarted = performance.now();
    await savePrompt(prompt);
    Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, stage: "storage-save", elapsedMs: performance.now() - saveStarted });
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

  Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, stage: "preparation", elapsedMs: performance.now() - started });
  const deliveries = deliverPromptAssignments(prompt);
  // Attach a rejection handler even in nonblocking API mode.
  if ( draft.awaitDeliveries !== false ) await deliveries;
  else void deliveries.catch(err => console.warn("drawing-prompts | background delivery failed", err));
  return prompt;
}

/** Retry only unresolved invitations, preserving their assignment identities. */
export async function retryPromptDeliveries(promptId) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  await deliverPromptAssignments(prompt, { assignmentIds: Object.values(prompt.assignments)
    .filter(a => ["pending", "sending", "failed"].includes(a.delivery.status)).map(a => a.id) });
  return prompt;
}

/** Withdraw unconfirmed invitations. Retain successful recipients; discard empty setup. */
export async function continuePromptDeliveries(promptId) {
  assertGM();
  let prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  for ( const id of Object.keys(prompt.assignments) ) {
    prompt = loadPrompt(promptId);
    const assignment = prompt.getAssignment(id);
    if ( ["received", "withdrawn"].includes(assignment.delivery.status) ) continue;
    assignment.delivery.status = "withdrawn";
    await savePrompt(prompt, { deliveryOnly: id });
    if ( prompt.getAssignment(id).delivery.status === "withdrawn" && game.users.get(assignment.userId)?.active ) {
      void Promise.resolve().then(() => emit.cancelDrawingPrompt(assignment.userId, id, assignment.delivery.generation)).catch(err => console.debug("drawing-prompts | withdrawal notification failed", err));
    }
  }
  prompt = loadPrompt(promptId);
  if ( !prompt.deliverySummary.hasRecipients ) await deletePromptEntry(promptId);
  Hooks.callAll("drawing-prompts.deliveryUpdated", prompt, prompt.deliverySummary);
  return prompt;
}

/** Add online recipients with new invitation ids, preserving the shared deadline. */
export async function invitePromptRecipients(promptId, userIds) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  const ids = [...new Set(userIds)];
  if ( ids.some(id => !game.users.get(id)?.active || game.users.get(id)?.isGM) ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.onlineRecipientsRequired"));
  const assignmentIds = [];
  for ( const userId of ids ) {
    if ( prompt.assignmentForUser(userId) ) continue;
    const assignment = DrawingAssignment.create({ promptId, userId, userName: game.users.get(userId).name });
    prompt.assignments[assignment.id] = assignment;
    await savePrompt(prompt, { assignmentOnly: assignment.id });
    assignmentIds.push(assignment.id);
  }
  await deliverPromptAssignments(prompt, { assignmentIds });
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
  if ( game.users.get(assignment.userId)?.active ) await emit.cancelDrawingPrompt(assignment.userId, assignment.id, assignment.delivery.generation);
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
      if ( game.users.get(assignment.userId)?.active ) await emit.cancelDrawingPrompt(assignment.userId, assignment.id, assignment.delivery.generation);
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
  if ( assignment.delivery.status === "withdrawn" ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.invalidInvitation"));
  if ( assignment.status === STATUS.CANCELLED ) {
    assignment.markResent();
    await savePrompt(prompt, { assignmentOnly: assignment.id, restartInvitation: true });
  } else if ( ![STATUS.PENDING, STATUS.OPENED].includes(assignment.status) ) {
    return;
  }
  if ( game.users.get(assignment.userId)?.active ) {
    await ensureFramedBackgroundDelivered(prompt);
    await deliverPromptAssignments(prompt, { assignmentIds: [assignment.id] });
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
    if ( assignment.delivery.status !== "withdrawn" && assignment.status === STATUS.CANCELLED ) {
      assignment.markResent();
      await savePrompt(prompt, { assignmentOnly: assignment.id, restartInvitation: true });
    }
  }
  await deliverPromptAssignments(prompt);
  await refreshManager();
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
