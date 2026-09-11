/**
 * Prompt lifecycle — create/send, finish, cancel, reopen, resend, redeliver.
 */

import { FILES_UPLOAD_PERMISSION, INTERNAL, MODULE_ID, STATUS } from "../constants.mjs";
import { emit } from "../socket.mjs";
import { deleteDataFile, ensureDir, stagingDir } from "./asset-service.mjs";
import { clearFramingViewAssets, hasSavedFramingViewAssets } from "./dual-save.mjs";
import { prepareFramedBackgroundForSend } from "./framed-delivery.mjs";
import {
  clearPendingSubmission,
  getPendingSubmission,
  persistSocketSubmission,
  resolveRestorationSubmission,
  setPendingSubmission
} from "./pending-submission.mjs";
import { isStagedSubmission } from "./assignment-save.mjs";
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
import { pauseTimer } from "./timer-service.mjs";

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
    timerStatus: timerSeconds > 0 ? "paused" : "none",
    deadlineAt: null,
    remainingMs: timerSeconds > 0 ? timerSeconds * 1000 : null
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
  const deliveries = deliverPromptAssignments(prompt, { initial: true });
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
  await deliverPromptAssignments(prompt, {
    assignmentIds: Object.values(prompt.assignments)
      .filter(a => ["pending", "sending", "failed"].includes(a.delivery.status)).map(a => a.id),
    initial: !prompt.deliverySummary.hasRecipients
  });
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
export async function closePrompt(promptId, { closeWithoutCaptures = false, availablePreviews = null } = {}) {
  assertGM();
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
  const now = Date.now();
  prompt.timerState = pauseTimer(prompt.timerState, now);
  await savePrompt(prompt, { lifecycleOnly: true });
  if ( availablePreviews ) await retainAvailablePreviews(prompt, availablePreviews);
  if ( !closeWithoutCaptures ) {
    const failures = await retainFullCaptures(prompt);
    if ( failures.length ) {
      const error = new Error(`Could not retain drawings for: ${failures.map(a => a.userName).join(", ")}`);
      error.code = "RETAINED_CAPTURE_FAILED";
      error.assignmentIds = failures.map(a => a.id);
      throw error;
    }
  }
  for ( const assignment of Object.values(prompt.assignments) ) {
    if ( !assignment.isActive ) continue;
    assignment.markCancelled(now);
    await savePrompt(prompt, { assignmentOnly: assignment.id });
    if ( game.users.get(assignment.userId)?.active ) {
      try {
        await emit.cancelDrawingPrompt(assignment.userId, assignment.id, assignment.delivery.generation);
      } catch (err) {
        console.warn("drawing-prompts | could not close retained player window", assignment.id, err);
      }
    }
    Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
    Hooks.callAll("drawing-prompts.assignmentCancelled", prompt, assignment);
    await setManagerWindowOpen(assignment.id, false);
  }
  prompt.markClosed(now);
  await savePrompt(prompt, { lifecycleOnly: true });
  Hooks.callAll("drawing-prompts.promptClosed", prompt);
  await refreshManager();
  return prompt;
}

async function retainAvailablePreviews(prompt, previews) {
  for ( const assignment of Object.values(prompt.assignments) ) {
    const dataUrl = previews[assignment.id];
    if ( !dataUrl || assignment.retainedCapture?.kind === "full-submission" ) continue;
    try {
      const format = /^data:image\/png/i.test(dataUrl) ? "png" : "webp";
      const stored = await persistSocketSubmission(assignment.id, {
        overlay: { dataUrl, format }, width: prompt.canvasWidth, height: prompt.canvasHeight,
        receiptTs: Date.now(), opLog: { ops: [], pointer: 0 }
      });
      assignment.retainedCapture = {
        kind: "saved-preview", receiptTs: stored.receiptTs,
        width: prompt.canvasWidth, height: prompt.canvasHeight,
        overlayPath: stored.staged.overlayPath, mergedPath: null
      };
      await savePrompt(prompt, { assignmentOnly: assignment.id });
    } catch (err) {
      console.warn("drawing-prompts | could not retain available preview", assignment.id, err);
    }
  }
}

async function retainFullCaptures(prompt) {
  const failures = [];
  for ( const assignment of Object.values(prompt.assignments) ) {
    try {
      if ( assignment.retainedCapture?.kind === "full-submission" && assignment.retainedCapture.overlayPath ) continue;
      if ( assignment.assets?.overlayPath ) {
        assignment.retainedCapture = {
          kind: "full-submission",
          receiptTs: assignment.submittedAt ?? Date.now(),
          width: assignment.assets.tileWidth ?? prompt.canvasWidth,
          height: assignment.assets.tileHeight ?? prompt.canvasHeight,
          overlayPath: assignment.assets.overlayPath,
          mergedPath: assignment.assets.mergedPath
        };
        await savePrompt(prompt, { assignmentOnly: assignment.id });
        continue;
      }
      let submission = getPendingSubmission(assignment.id);
      if ( !submission && assignment.isActive && game.users.get(assignment.userId)?.active ) {
        const requestId = foundry.utils.randomID();
        const response = await emit.requestRetainedCapture(assignment.userId, assignment.id, requestId);
        if ( response?.requestId !== requestId || response?.assignmentId !== assignment.id ) throw new Error("Stale retained capture response");
        submission = response.submission;
      }
      if ( !submission || Number(submission.width) !== prompt.canvasWidth || Number(submission.height) !== prompt.canvasHeight || submission.wireScaled ) {
        if ( assignment.isActive ) failures.push(assignment);
        continue;
      }
      submission = { ...submission, recoveryKind: "full-submission", assignmentId: assignment.id, receiptTs: submission.receiptTs ?? Date.now() };
      if ( !isStagedSubmission(submission) ) submission = await persistSocketSubmission(assignment.id, submission);
      setPendingSubmission(assignment.id, submission);
      assignment.retainedCapture = {
        kind: "full-submission",
        receiptTs: submission.receiptTs,
        width: prompt.canvasWidth,
        height: prompt.canvasHeight,
        overlayPath: submission.staged?.overlayPath ?? null,
        mergedPath: submission.staged?.mergedPath ?? null
      };
      await savePrompt(prompt, { assignmentOnly: assignment.id });
    } catch (err) {
      console.warn("drawing-prompts | retained capture failed", assignment.id, err);
      if ( assignment.isActive ) failures.push(assignment);
    }
  }
  return failures;
}

/** @deprecated Finish now retains the Prompt using Close semantics. */
export async function finishPrompt(promptId) {
  return closePrompt(promptId);
}

/** Reopen a Closed Prompt with its remaining timer paused. */
export async function reopenPrompt(promptId) {
  assertGM();
  const prompt = requireOwnedPrompt(promptId);
  prompt.markReopened();
  if ( prompt.timerStatus !== "none" ) {
    prompt.timerState = { timerStatus: "paused", deadlineAt: null, remainingMs: prompt.remainingMs };
  }
  await savePrompt(prompt, { lifecycleOnly: true });
  Hooks.callAll("drawing-prompts.promptReopened", prompt);
  await refreshManager();
  return prompt;
}

/** Archive a Closed Prompt. */
export async function archivePrompt(promptId) {
  assertGM();
  const prompt = requireOwnedPrompt(promptId);
  prompt.markArchived(Date.now());
  await savePrompt(prompt, { lifecycleOnly: true });
  Hooks.callAll("drawing-prompts.promptArchived", prompt);
  await refreshManager();
  return prompt;
}

/** Restore an Archived Prompt to the Closed library. */
export async function restorePrompt(promptId) {
  assertGM();
  const prompt = requireOwnedPrompt(promptId);
  prompt.markRestored();
  await savePrompt(prompt, { lifecycleOnly: true });
  Hooks.callAll("drawing-prompts.promptRestored", prompt);
  await refreshManager();
  return prompt;
}

/** Permanently delete one Prompt after the caller obtains explicit confirmation. */
export async function deletePrompt(promptId, { confirmed = false } = {}) {
  assertGM();
  if ( !confirmed ) return false;
  const prompt = requireOwnedPrompt(promptId);
  const internalPaths = moduleOwnedPromptPaths(prompt);
  await Promise.all(internalPaths.map(path => deleteDataFile(path)));
  await deletePromptEntry(promptId);
  for ( const assignment of Object.values(prompt.assignments) ) clearPendingSubmission(assignment.id);
  await queueRecoveryTombstones(prompt);
  Hooks.callAll("drawing-prompts.promptDeleted", prompt);
  await refreshManager();
  return true;
}

function moduleOwnedPromptPaths(prompt) {
  const paths = new Set();
  for ( const assignment of Object.values(prompt.assignments)) {
    const exported = new Set(Object.values(assignment.assets ?? {}).filter(value => typeof value === "string"));
    const pending = getPendingSubmission(assignment.id);
    for ( const path of [
      pending?.staged?.overlayPath,
      pending?.staged?.mergedPath,
      assignment.retainedCapture?.overlayPath,
      assignment.retainedCapture?.mergedPath
    ]) {
      if ( typeof path === "string" && path && !exported.has(path) ) paths.add(path);
    }
  }
  return [...paths];
}

/** Clear queued browser Recovery copies for a player and retain only unacknowledged work. */
export async function processRecoveryTombstonesForUser(userId) {
  if ( !game.user?.isGM || !game.settings?.get || !game.settings?.set ) return;
  const tombstones = recoveryTombstones();
  const remaining = [];
  for ( const tombstone of tombstones ) {
    if ( tombstone.userId !== userId ) {
      remaining.push(tombstone);
      continue;
    }
    try {
      const cleared = await emit.clearRecoveryCopy(userId, tombstone);
      if ( !cleared ) remaining.push(tombstone);
    } catch (_err) {
      remaining.push(tombstone);
    }
  }
  if ( remaining.length !== tombstones.length ) {
    await game.settings.set(MODULE_ID, INTERNAL.RECOVERY_TOMBSTONES, remaining);
  }
}

async function queueRecoveryTombstones(prompt) {
  if ( !game.settings?.get || !game.settings?.set ) return;
  const additions = Object.values(prompt.assignments).map(assignment => ({
    worldId: game.world?.id ?? game.worldId,
    gmUserId: prompt.gmUserId,
    userId: assignment.userId,
    assignmentId: assignment.id,
    promptId: prompt.id,
    width: prompt.canvasWidth,
    height: prompt.canvasHeight
  }));
  const byAssignment = new Map(recoveryTombstones().map(item => [item.assignmentId, item]));
  for ( const item of additions ) byAssignment.set(item.assignmentId, item);
  await game.settings.set(MODULE_ID, INTERNAL.RECOVERY_TOMBSTONES, [...byAssignment.values()]);
  for ( const userId of new Set(additions.filter(item => game.users.get(item.userId)?.active).map(item => item.userId))) {
    await processRecoveryTombstonesForUser(userId);
  }
}

function recoveryTombstones() {
  const value = game.settings.get(MODULE_ID, INTERNAL.RECOVERY_TOMBSTONES);
  return Array.isArray(value) ? value : [];
}

function requireOwnedPrompt(promptId) {
  const prompt = loadPrompt(promptId);
  if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
  assertPromptOwner(prompt);
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
  for ( const assignmentId of Object.keys(prompt.assignments) ) {
    const assignment = prompt.getAssignment(assignmentId);
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
