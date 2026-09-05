/**
 * Player wire payloads and GM→player delivery for drawing prompts.
 */

import { MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { PlayerPromptList } from "../apps/player-prompt-list.mjs";
import { emit } from "../socket.mjs";
import { getAssignment as getClientAssignment } from "./client-store.mjs";
import { prepareFramedBackgroundForSend, serializeBackgroundForPlayer } from "./framed-delivery.mjs";
import { savePrompt } from "./persistence-service.mjs";
import { assertGM, assertSenderOwnsAssignment } from "./socket-auth.mjs";
import { requirePromptAssignment } from "./prompt-context.mjs";

/**
 * Validate that this GM owns the prompt and the socket sender owns the assignment.
 * `initiatorId` leads the signature because it is the authoritative identity: it
 * comes from `socketdata`, while `userId` is caller-supplied wire data.
 * @param {string|null} initiatorId Socket initiator user id (from `socketdata`).
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id claimed by the payload.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment}}
 */
export function validateOwningGMSender(initiatorId, assignmentId, userId) {
  assertGM();
  const pair = requirePromptAssignment(assignmentId);
  if ( pair.prompt.gmUserId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notPromptOwner"));
  assertSenderOwnsAssignment(initiatorId, userId, pair.assignment.userId);
  return pair;
}

/**
 * Validate a player-side payload is addressed to this user.
 * @param {object} payload Socket payload.
 * @returns {object}
 */
export function validatePlayerPayload(payload) {
  if ( payload?.assignment?.userId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  return payload;
}

/**
 * Validate a known player-side assignment id.
 * @param {string} assignmentId Assignment id.
 * @returns {{assignment: object, prompt: object}}
 */
export function validateKnownPlayerAssignment(assignmentId) {
  const payload = getClientAssignment(assignmentId);
  if ( payload?.assignment?.userId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  return payload;
}

/**
 * Validate a player assignment for active-only remote handlers.
 * @param {string} assignmentId Assignment id.
 * @param {string} action Handler action name.
 * @returns {{assignment: object, prompt: object}|null} Player payload or null.
 */
export function validateKnownActivePlayerAssignment(assignmentId, action) {
  let payload;
  try {
    payload = validateKnownPlayerAssignment(assignmentId);
  } catch (err) {
    console.debug(`drawing-prompts | ignored ${action} for unknown player assignment ${assignmentId}`, err);
    return null;
  }
  if ( ![STATUS.PENDING, STATUS.OPENED].includes(payload.assignment.status) ) {
    console.debug(`drawing-prompts | ignored ${action} for inactive player assignment ${assignmentId}: ${payload.assignment.status}`);
    return null;
  }
  return payload;
}

/**
 * Build a player-safe wire payload for one assignment.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{assignment: object, prompt: object}}
 */
export function payloadFor(prompt, assignment) {
  return {
    assignment: assignment.toObject(),
    prompt: playerPromptPayload(prompt)
  };
}

/**
 * Build the player-safe prompt slice for wire payloads.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {object}
 */
export function playerPromptPayload(prompt) {
  return {
    id: prompt.id,
    gmUserId: prompt.gmUserId,
    promptText: prompt.promptText,
    drawingName: prompt.drawingName,
    canvasWidth: prompt.canvasWidth,
    canvasHeight: prompt.canvasHeight,
    background: serializeBackgroundForPlayer(prompt),
    sentAt: prompt.sentAt,
    timerSeconds: prompt.timerSeconds,
    ...prompt.timerState
  };
}

/**
 * Build a reopen payload that restores the player's last submission without
 * echoing the full pending blob on the assignment record.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {object|null} restorationSubmission Submission to restore.
 * @returns {object}
 */
export function payloadForReopen(prompt, assignment, restorationSubmission) {
  const assignmentObj = assignment.toObject();
  delete assignmentObj.pendingSubmission;
  return {
    assignment: assignmentObj,
    prompt: playerPromptPayload(prompt),
    restorationSubmission: restorationSubmission ?? null
  };
}

/**
 * Ensure a sent prompt has a baked Framed background before player delivery.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<void>}
 */
export async function ensureFramedBackgroundDelivered(prompt) {
  const background = prompt.background ?? {};
  if ( !background.path || background.framedPath ) return;
  await prepareFramedBackgroundForSend(prompt);
  await savePrompt(prompt);
}

/**
 * Deliver active assignments for a prompt and return their settlement promise.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<PromiseSettledResult<void>[]>}
 */
export async function deliverPromptAssignments(prompt) {
  await ensureFramedBackgroundDelivered(prompt);
  const deliveries = Object.values(prompt.assignments)
    .filter(assignment => game.users.get(assignment.userId)?.active)
    .map(assignment => emit.openDrawingPrompt(assignment.userId, payloadFor(prompt, assignment))
      .then(() => Hooks.callAll("drawing-prompts.assignmentSent", prompt, assignment))
      .catch(err => {
        console.warn(`drawing-prompts | delivery failed for ${assignment.userName}`, err);
        ui.notifications.warn(game.i18n.format("DRAWING-PROMPTS.errors.deliveryFailed", { name: assignment.userName }));
        throw err;
      }));
  return Promise.allSettled(deliveries);
}

/**
 * Notify a player if enabled.
 * @param {string} key Localization key.
 * @returns {void}
 */
export function notifyPlayer(key) {
  if ( game.settings.get(MODULE_ID, SETTINGS.NOTIFY_PLAYER) ) ui.notifications.info(game.i18n.localize(key));
}

/**
 * Refresh the player prompt list if present.
 * @returns {Promise<void>}
 */
export async function refreshPromptList() {
  PlayerPromptList.refreshOpen();
}
