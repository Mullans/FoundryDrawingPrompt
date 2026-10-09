/**
 * Player wire payloads and GM→player delivery for drawing prompts.
 */

import { MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { PlayerPromptList } from "../apps/player-prompt-list.mjs";
import { emit } from "../socket.mjs";
import { getAssignment as getClientAssignment } from "./client-store.mjs";
import { prepareFramedBackgroundForSend, serializeBackgroundForPlayer } from "./framed-delivery.mjs";
import { loadAllPrompts, loadPrompt, savePrompt } from "./persistence-service.mjs";
import { assertGM, assertSenderOwnsAssignment } from "./socket-auth.mjs";
import { requirePromptAssignment } from "./prompt-context.mjs";
import { refreshManager } from "./ui-bridge.mjs";

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
  if ( pair.assignment.delivery.status === "withdrawn" ) throw new Error("DRAWING-PROMPTS.errors.invalidInvitation");
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
    promptName: prompt.promptName,
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
export const DELIVERY_TIMEOUT_MS = 10_000;
const attempts = new Map();
const receiptWaiters = new Map();

/**
 * Reconcile interrupted receipt attempts when the GM reloads. Drawing data is untouched.
 * An in-memory attempt owns its deadline; only orphaned pending metadata needs a decision.
 */
export async function recoverInterruptedPromptDeliveries() {
  if ( !game.user.isGM ) return;
  for ( const prompt of loadAllPrompts() ) {
    if ( prompt.gmUserId !== game.user.id || attempts.has(prompt.id) ) continue;
    const unresolved = Object.values(prompt.assignments).filter(assignment => assignment.isActive
      && ["pending", "sending"].includes(assignment.delivery.status));
    if ( !unresolved.length ) continue;
    // Share the same gate as dispatch: an invitation started during reconciliation queues
    // behind this metadata update, while an already-running attempt was skipped above.
    const recovery = { ids: [], generations: {}, promise: (async () => {
      for ( const assignment of unresolved ) {
        await updateDelivery(prompt.id, assignment.id, "failed", "interrupted", assignment.delivery.generation);
      }
    })() };
    attempts.set(prompt.id, recovery);
    try { await recovery.promise; }
    finally { if ( attempts.get(prompt.id) === recovery ) attempts.delete(prompt.id); }
  }
}

/** Persist only delivery metadata, merging against current lifecycle/timer state. */
async function updateDelivery(promptId, assignmentId, status, error = null, generation = null) {
  const prompt = loadPrompt(promptId);
  const assignment = prompt?.getAssignment(assignmentId);
  if ( !assignment ) return null;
  if ( generation !== null && assignment.delivery.generation !== generation ) return prompt;
  assignment.delivery = { ...assignment.delivery, status, error,
    receivedAt: status === "received" ? assignment.delivery.receivedAt ?? Date.now() : assignment.delivery.receivedAt };
  await savePrompt(prompt, { deliveryOnly: assignmentId });
  Hooks.callAll("drawing-prompts.deliveryUpdated", prompt, prompt.deliverySummary);
  await refreshManager();
  return prompt;
}

/** Automatic authenticated client receipt; unknown/withdrawn invitations fail explicitly. */
export async function acknowledgePromptDelivery(initiatorId, assignmentId, userId, generation = 0) {
  let pair;
  try { pair = validateOwningGMSender(initiatorId, assignmentId, userId); }
  catch (error) {
    console.debug("drawing-prompts | ignored assignment receipt", error);
    return { accepted: false, reason: "invalid-invitation" };
  }
  if ( generation !== pair.assignment.delivery.generation ) return { accepted: false, reason: "stale-invitation" };
  if ( !pair.assignment.isActive ) return { accepted: false, reason: "inactive-assignment" };
  const prompt = await updateDelivery(pair.prompt.id, assignmentId, "received", null, generation);
  const assignment = prompt?.getAssignment(assignmentId);
  if ( assignment && assignment.delivery.generation !== generation ) return { accepted: false, reason: "stale-invitation" };
  if ( !assignment || assignment.delivery.status === "withdrawn" ) return { accepted: false, reason: "invalid-invitation" };
  if ( !assignment.isActive ) return { accepted: false, reason: "inactive-assignment" };
  if ( assignment.delivery.status !== "received" ) return { accepted: false, reason: "invalid-invitation" };
  const waiter = receiptWaiters.get(assignmentId);
  if ( waiter?.generation === generation ) waiter.resolve();
  const initialAttempt = attempts.get(prompt.id);
  if ( initialAttempt?.initial ) await initialAttempt.promise;
  const resolvedPrompt = loadPrompt(prompt.id) ?? prompt;
  return { accepted: true, timerState: resolvedPrompt.timerState };
}

/** Bounded receipt resolution: OPEN completion is diagnostic, never proof of receipt. */
export async function deliverPromptAssignments(prompt, {
  assignmentIds = null,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  initial = false
} = {}) {
  const ids = assignmentIds ?? Object.values(prompt.assignments).filter(a => a.isActive).map(a => a.id);
  if ( attempts.has(prompt.id) ) {
    const previous = attempts.get(prompt.id);
    const result = await previous.promise;
    const latest = loadPrompt(prompt.id);
    if ( latest ) { prompt.assignments = latest.assignments; prompt.timerState = latest.timerState; }
    const additional = ids.filter(id => !previous.ids.includes(id)
      || previous.generations[id] !== prompt.getAssignment(id)?.delivery.generation);
    if ( additional.length && latest ) return deliverPromptAssignments(prompt, { assignmentIds: additional, timeoutMs, initial });
    return result;
  }
  const attempt = { ids, initial,
    generations: Object.fromEntries(ids.map(id => [id, prompt.getAssignment(id)?.delivery.generation])),
    promise: runDeliveries(prompt, { assignmentIds: ids, timeoutMs, initial }) };
  attempts.set(prompt.id, attempt);
  try { return await attempt.promise; }
  finally { if ( attempts.get(prompt.id) === attempt ) attempts.delete(prompt.id); }
}

async function runDeliveries(prompt, { assignmentIds, timeoutMs, initial }) {
  await ensureFramedBackgroundDelivered(prompt);
  const selected = Object.values(prompt.assignments).filter(a => a.isActive && (!assignmentIds || assignmentIds.includes(a.id)));
  await Promise.all(selected.map(async assignment => {
    const start = performance.now();
    if ( !game.users.get(assignment.userId)?.active ) {
      await updateDelivery(prompt.id, assignment.id, "failed", "offline", assignment.delivery.generation);
      return;
    }
    await updateDelivery(prompt.id, assignment.id, "sending", null, assignment.delivery.generation);
    let timer;
    let settle;
    const receipt = new Promise(resolve => { settle = resolve; });
    const waiter = { resolve: settle, generation: assignment.delivery.generation };
    receiptWaiters.set(assignment.id, waiter);
    timer = setTimeout(() => settle("timeout"), Math.max(1, Math.min(timeoutMs, DELIVERY_TIMEOUT_MS)));
    Promise.resolve().then(() => {
      const dispatchedAt = performance.now();
      const request = emit.openDrawingPrompt(assignment.userId, payloadFor(loadPrompt(prompt.id) ?? prompt, assignment));
      Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, assignmentId: assignment.id, stage: "dispatch", elapsedMs: performance.now() - dispatchedAt });
      return request;
    })
      .then(() => Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, assignmentId: assignment.id, stage: "client-open", elapsedMs: performance.now() - start }))
      .catch(() => settle("transport"));
    const error = await receipt;
    clearTimeout(timer);
    if ( receiptWaiters.get(assignment.id) === waiter ) receiptWaiters.delete(assignment.id);
    if ( error ) await updateDelivery(prompt.id, assignment.id, "failed", error, assignment.delivery.generation);
    else {
      const latest = loadPrompt(prompt.id);
      if ( latest ) Hooks.callAll("drawing-prompts.assignmentSent", latest, latest.getAssignment(assignment.id));
    }
    Hooks.callAll("drawing-prompts.deliveryTiming", { promptId: prompt.id, assignmentId: assignment.id, stage: "receipt", elapsedMs: performance.now() - start, error: error ?? null });
  }));
  let latest = loadPrompt(prompt.id);
  if ( initial && latest?.deliverySummary.hasRecipients && latest.timerStatus === "paused" ) {
    const remainingMs = Number(latest.remainingMs ?? (latest.timerSeconds * 1000));
    latest.timerState = {
      timerStatus: "running",
      deadlineAt: Date.now() + remainingMs,
      remainingMs: null
    };
    await savePrompt(latest, { timerOnly: true });
    latest = loadPrompt(prompt.id) ?? latest;
  }
  if ( latest ) { prompt.assignments = latest.assignments; prompt.timerState = latest.timerState; }
  Hooks.callAll("drawing-prompts.deliveryUpdated", prompt, prompt.deliverySummary);
  return prompt.deliverySummary;
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
