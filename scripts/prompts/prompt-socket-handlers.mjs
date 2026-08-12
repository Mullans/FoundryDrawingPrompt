/**
 * Socket handlers for drawing-prompt open/reopen/timer/cancel/show/snapshot/lifecycle events.
 */

import { MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { PlayerDrawingApp } from "../apps/player-drawing-app.mjs";
import { CALLS } from "../socket.mjs";
import { isStagedSubmission } from "./assignment-save.mjs";
import { updateStatus, updateTimerState, upsertAssignment } from "./client-store.mjs";
import { clearFramingViewAssets, hasSavedFramingViewAssets } from "./dual-save.mjs";
import {
  persistSocketSubmission,
  setPendingSubmission,
  submissionPreviewSrc,
  submissionValidationContext
} from "./pending-submission.mjs";
import { savePrompt } from "./persistence-service.mjs";
import {
  notifyPlayer,
  refreshPromptList,
  validateKnownActivePlayerAssignment,
  validateKnownPlayerAssignment,
  validateOwningGMSender,
  validatePlayerPayload
} from "./prompt-delivery.mjs";
import { assertPromptGmMatchesInitiator } from "./socket-auth.mjs";
import { evaluateSubmissionTiming, normalizeTimerState } from "./timer-service.mjs";
import { evaluateOpened, evaluateRejection, evaluateSnapshot, evaluateSubmission, validateSubmissionPayload } from "./transitions.mjs";
import { receiveManagerSnapshot, refreshManager, setManagerWindowOpen } from "./ui-bridge.mjs";
import { isValidSnapshotPayload } from "./wire-validation.mjs";

/**
 * Build all socket handlers for this phase.
 * @returns {Record<string, Function>}
 */
export function getSocketHandlers() {
  return {
    [CALLS.OPEN]: handleOpenPrompt,
    [CALLS.REOPEN]: handleReopenPrompt,
    [CALLS.TIMER_UPDATED]: handleTimerUpdated,
    [CALLS.CANCEL]: handleCancelPrompt,
    [CALLS.SHOW]: handleShowPrompt,
    [CALLS.REQUEST_SNAPSHOT]: handleRequestSnapshot,
    [CALLS.OPENED]: handleAssignmentOpened,
    [CALLS.SNAPSHOT]: handleDrawingSnapshot,
    [CALLS.SUBMITTED]: handleDrawingSubmitted,
    [CALLS.REJECTED]: handleDrawingRejected,
    [CALLS.WINDOW_CLOSED]: handlePlayerWindowClosed
  };
}

/**
 * Handle prompt open on the player client.
 * @param {object} payload Assignment payload.
 * @returns {Promise<void>}
 */
async function handleOpenPrompt(payload) {
  try {
    payload = validatePlayerPayload(payload);
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored open prompt", err);
    return;
  }
  upsertAssignment(payload);
  notifyPlayer("DRAWING-PROMPTS.player.notifications.received");
  await refreshPromptList();
  if ( game.settings.get(MODULE_ID, SETTINGS.AUTO_OPEN_PLAYER_WINDOW) ) {
    await PlayerDrawingApp.open(payload, { mode: "live" });
  }
}

/**
 * Handle prompt reopen on the player client.
 * @param {object} payload Assignment payload.
 * @returns {Promise<void>}
 */
async function handleReopenPrompt(payload) {
  try {
    payload = validatePlayerPayload(payload);
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored reopen prompt", err);
    return;
  }
  payload.assignment.status = STATUS.OPENED;
  upsertAssignment(payload);
  notifyPlayer("DRAWING-PROMPTS.player.notifications.reopened");
  await refreshPromptList();
  await PlayerDrawingApp.open(payload, { mode: "live" });
}

/**
 * Handle a persisted GM timer change on an assigned player client.
 * @param {string} assignmentId Assignment id.
 * @param {object} timerState Canonical timer state.
 * @returns {Promise<void>}
 */
async function handleTimerUpdated(assignmentId, timerState) {
  let payload;
  try {
    payload = validateKnownPlayerAssignment(assignmentId);
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored timer update", err);
    return;
  }
  const state = normalizeTimerState(timerState);
  updateTimerState(assignmentId, state);
  await PlayerDrawingApp.updateTimer(assignmentId, state);
}

/**
 * Handle prompt cancellation on the player client.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
async function handleCancelPrompt(assignmentId) {
  const payload = validateKnownActivePlayerAssignment(assignmentId, "cancel");
  if ( !payload ) return;
  try {
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored cancel prompt", err);
    return;
  }
  updateStatus(assignmentId, STATUS.CANCELLED);
  await refreshPromptList();
  await PlayerDrawingApp.closeAssignment(assignmentId, { silent: true });
}

/**
 * Handle GM force-show on the player client.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
async function handleShowPrompt(assignmentId) {
  const payload = validateKnownActivePlayerAssignment(assignmentId, "show");
  if ( !payload ) return;
  try {
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored show prompt", err);
    return;
  }
  await PlayerDrawingApp.open(payload, { mode: "live" });
}

/**
 * Handle a GM request for the current player-side snapshot.
 * @param {string} assignmentId Assignment id.
 * @param {{includeOverlay?: boolean}} [options] Request options from the GM.
 * @returns {Promise<void>}
 */
async function handleRequestSnapshot(assignmentId, options = {}) {
  const payload = validateKnownActivePlayerAssignment(assignmentId, "request-snapshot");
  if ( !payload ) return;
  try {
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored snapshot request", err);
    return;
  }
  await PlayerDrawingApp.sendSnapshotForAssignment(assignmentId, {
    includeOverlay: options?.includeOverlay === true
  });
}

/**
 * Handle assignment opened on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @returns {Promise<void>}
 */
async function handleAssignmentOpened(assignmentId, userId) {
  const { prompt, assignment } = validateOwningGMSender(assignmentId, userId);
  const decision = evaluateOpened(assignment);
  if ( !decision.apply ) return debugIgnoredTransition("opened", assignment, decision.reason);
  assignment.markOpened(Date.now());
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentOpened", prompt, assignment);
  await setManagerWindowOpen(assignment.id, true);
  await refreshManager();
}

/**
 * Handle a snapshot on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @param {string|{composite?: string, overlay?: string}} snapshotPayload Snapshot payload.
 * @returns {Promise<void>}
 */
async function handleDrawingSnapshot(assignmentId, userId, snapshotPayload) {
  const { assignment } = validateOwningGMSender(assignmentId, userId);
  if ( !isValidSnapshotPayload(snapshotPayload) ) {
    console.debug(`${MODULE_ID} | ignored invalid snapshot payload shape for assignment ${assignmentId}`);
    return;
  }
  const decision = evaluateSnapshot(assignment);
  if ( !decision.apply ) return debugIgnoredTransition("snapshot", assignment, decision.reason);
  receiveManagerSnapshot(assignmentId, snapshotPayload);
}

/**
 * Handle a submission on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @param {object} submissionPayload Submission payload.
 * @returns {Promise<void>}
 */
async function handleDrawingSubmitted(assignmentId, userId, submissionPayload) {
  const { prompt, assignment } = validateOwningGMSender(assignmentId, userId);
  const validation = validateSubmissionPayload(submissionPayload, submissionValidationContext(assignmentId));
  if ( !validation.ok ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.invalidSubmissionPayload"));
    console.warn(`${MODULE_ID} | rejected submission for assignment ${assignmentId}: ${validation.reason} check failed; ${validation.detail}`);
    return;
  }
  const decision = evaluateSubmission(assignment);
  if ( !decision.apply ) return debugIgnoredTransition("submitted", assignment, decision.reason);
  if ( hasSavedFramingViewAssets(assignment) ) clearFramingViewAssets(assignment);
  const now = Date.now();
  if ( assignment.status === STATUS.PENDING ) assignment.markOpened(now);
  const timing = evaluateSubmissionTiming(prompt.timerState, now);
  assignment.markSubmitted({ ts: now, ...timing });
  let receivedSubmission = { ...submissionPayload, receiptTs: now };
  if ( !isStagedSubmission(receivedSubmission) ) {
    try {
      receivedSubmission = await persistSocketSubmission(assignmentId, receivedSubmission);
    } catch (err) {
      console.warn("drawing-prompts | could not persist socket submission to pending folder", assignmentId, err);
    }
  }
  setPendingSubmission(assignment.id, receivedSubmission);
  assignment.pendingSubmission = receivedSubmission;
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentSubmitted", prompt, assignment, receivedSubmission);
  const previewSrc = submissionPreviewSrc(receivedSubmission);
  if ( previewSrc ) receiveManagerSnapshot(assignment.id, previewSrc);
  await setManagerWindowOpen(assignment.id, false);
  await refreshManager();
}

/**
 * Handle a rejection on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @param {*} reason Reason payload.
 * @returns {Promise<void>}
 */
async function handleDrawingRejected(assignmentId, userId, reason) {
  const { prompt, assignment } = validateOwningGMSender(assignmentId, userId);
  const decision = evaluateRejection(assignment);
  if ( !decision.apply ) return debugIgnoredTransition("rejected", assignment, decision.reason);
  assignment.markRejected(Date.now());
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentRejected", prompt, assignment, reason);
  await setManagerWindowOpen(assignment.id, false);
  await refreshManager();
}

/**
 * Handle player window close on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @returns {Promise<void>}
 */
async function handlePlayerWindowClosed(assignmentId, userId) {
  const { assignment } = validateOwningGMSender(assignmentId, userId);
  await setManagerWindowOpen(assignment.id, false);
  await refreshManager();
}

/**
 * Log an ignored lifecycle transition.
 * @param {string} event Event name.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {string} reason Ignore reason.
 * @returns {void}
 */
function debugIgnoredTransition(event, assignment, reason) {
  console.debug(`drawing-prompts | ignored ${event} for assignment ${assignment?.id ?? "unknown"}: ${reason ?? "inactive"}`);
}
