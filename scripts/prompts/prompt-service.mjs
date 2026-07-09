import { MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { DrawingPromptManager } from "../apps/drawing-prompt-manager.mjs";
import { PlayerDrawingApp } from "../apps/player-drawing-app.mjs";
import { PlayerPromptList } from "../apps/player-prompt-list.mjs";
import { buildTileData } from "../foundry/tile-placement-service.mjs";
import { CALLS, emit } from "../socket.mjs";
import { browseFiles, defaultAssetFolder, ensureDir, normalizePath, uploadDataUrl, uploadJson } from "./asset-service.mjs";
import { getAssignment as getClientAssignment, updateStatus, upsertAssignment } from "./client-store.mjs";
import { createPromptEntry, loadAllPrompts, loadPrompt, savePrompt } from "./persistence-service.mjs";
import { defaultAssignmentAssetName, uniqueDrawingAssetFilenames } from "./naming-service.mjs";
import { DrawingPrompt } from "./prompt-models.mjs";

const pendingSubmissions = new Map();

/**
 * Throw a localized GM-only error when the current user is not a GM.
 * @returns {void}
 */
function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
}

/**
 * Find the prompt and assignment pair for an assignment id.
 * @param {string} assignmentId Assignment id.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment}}
 */
function requirePromptAssignment(assignmentId) {
  for ( const prompt of loadAllPrompts() ) {
    const assignment = prompt.getAssignment(assignmentId);
    if ( assignment ) return { prompt, assignment };
  }
  throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.assignmentNotFound"));
}

/**
 * Validate that this GM owns the prompt and the sender user matches the assignment.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment}}
 */
function validateOwningGMSender(assignmentId, userId) {
  assertGM();
  const pair = requirePromptAssignment(assignmentId);
  if ( pair.prompt.gmUserId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notPromptOwner"));
  if ( pair.assignment.userId !== userId ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  return pair;
}

/**
 * Validate a player-side payload is addressed to this user.
 * @param {object} payload Socket payload.
 * @returns {object}
 */
function validatePlayerPayload(payload) {
  if ( payload?.assignment?.userId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  return payload;
}

/**
 * Validate a known player-side assignment id.
 * @param {string} assignmentId Assignment id.
 * @returns {{assignment: object, prompt: object}}
 */
function validateKnownPlayerAssignment(assignmentId) {
  const payload = getClientAssignment(assignmentId);
  if ( payload?.assignment?.userId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notYourAssignment"));
  return payload;
}

/**
 * Build a player-safe wire payload for one assignment.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{assignment: object, prompt: object}}
 */
function payloadFor(prompt, assignment) {
  return {
    assignment: assignment.toObject(),
    prompt: {
      id: prompt.id,
      gmUserId: prompt.gmUserId,
      promptText: prompt.promptText,
      drawingName: prompt.drawingName,
      canvasWidth: prompt.canvasWidth,
      canvasHeight: prompt.canvasHeight,
      background: { ...prompt.background },
      sentAt: prompt.sentAt,
      timerSeconds: prompt.timerSeconds,
      deadlineAt: prompt.deadlineAt
    }
  };
}

/**
 * Build all socket handlers for this phase.
 * @returns {Record<string, Function>}
 */
export function getSocketHandlers() {
  return {
    [CALLS.OPEN]: handleOpenPrompt,
    [CALLS.REOPEN]: handleReopenPrompt,
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
    deadlineAt: timerSeconds ? sentAt + (timerSeconds * 1000) : null
  }, draft.selectedUserIds);

  await createPromptEntry(prompt);
  await savePrompt(prompt);
  Hooks.callAll("drawing-prompts.promptCreated", prompt);

  // Dispatch deliveries in parallel and never let one player's slow or failed
  // remote handler block or fail the send: the assignment stays pending and can
  // be resent, which is the same recovery path as an offline player.
  const deliveries = Object.values(prompt.assignments)
    .filter(assignment => game.users.get(assignment.userId)?.active)
    .map(assignment => emit.openDrawingPrompt(assignment.userId, payloadFor(prompt, assignment))
      .then(() => Hooks.callAll("drawing-prompts.assignmentSent", prompt, assignment))
      .catch(err => {
        console.warn(`drawing-prompts | delivery failed for ${assignment.userName}`, err);
        ui.notifications.warn(game.i18n.format("DRAWING-PROMPTS.errors.deliveryFailed", { name: assignment.userName }));
      }));
  Promise.allSettled(deliveries);
  return prompt;
}

/**
 * Open the GM prompt manager.
 * @returns {Promise<void>}
 */
export async function openPromptManager() {
  if ( !game.user.isGM ) {
    ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
    return;
  }
  await DrawingPromptManager.open();
}

/**
 * Open the player prompt list.
 * @returns {Promise<void>}
 */
export async function openPlayerPromptList() {
  await PlayerPromptList.open();
}

/**
 * Create and send a drawing prompt via the public API.
 * @param {object} options Prompt options.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export async function createPrompt(options) {
  return createAndSendPrompt(options);
}

/**
 * Load a prompt by id.
 * @param {string} promptId Prompt id.
 * @returns {import("./prompt-models.mjs").DrawingPrompt|null}
 */
export function getPrompt(promptId) {
  return loadPrompt(promptId);
}

/**
 * Find an assignment by id across persisted prompts.
 * @param {string} assignmentId Assignment id.
 * @returns {import("./prompt-models.mjs").DrawingAssignment|null}
 */
export function getAssignment(assignmentId) {
  for ( const prompt of loadAllPrompts() ) {
    const assignment = prompt.getAssignment(assignmentId);
    if ( assignment ) return assignment;
  }
  return null;
}

/**
 * Get a pending in-memory submission payload.
 * @param {string} assignmentId Assignment id.
 * @returns {object|null}
 */
export function getPendingSubmission(assignmentId) {
  return pendingSubmissions.get(assignmentId) ?? null;
}

/**
 * Save assignment assets.
 * @param {string} assignmentId Assignment id.
 * @param {{name?: string, folder?: string}} [options] Save options.
 * @returns {Promise<import("./prompt-models.mjs").DrawingAssignment>}
 */
export async function saveAssignment(assignmentId, { name, folder } = {}) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  const resolvedName = resolveDrawingName(prompt, assignment, name);
  if ( !resolvedName ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.nameRequired"));

  const alreadySaved = Boolean(assignment.primaryImagePath && assignment.assets?.overlayPath && assignment.assets?.oplogPath);
  const submission = pendingSubmissions.get(assignment.id);
  if ( !submission && !alreadySaved ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.pendingSubmissionLost"));

  if ( submission ) {
    const dir = normalizePath(folder || assignment.assets?.folder || game.settings.get(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER) || defaultAssetFolder());
    await ensureDir(dir);
    const hasMerged = Boolean(submission.merged?.dataUrl);
    const filenames = uniqueDrawingAssetFilenames({
      name: resolvedName,
      extension: extensionFor((hasMerged ? submission.merged?.format : submission.overlay?.format) ?? "webp"),
      hasMerged,
      existingFiles: await browseFiles(dir),
      fallback: game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.defaultSlug")
    });
    const primaryDataUrl = hasMerged ? submission.merged?.dataUrl : submission.overlay?.dataUrl;
    const uploads = [
      uploadDataUrl(dir, filenames.primary, primaryDataUrl),
      uploadJson(dir, filenames.opLog, submission.opLog ?? {})
    ];
    if ( hasMerged ) uploads.push(uploadDataUrl(dir, filenames.overlay, submission.overlay?.dataUrl));
    const [primary, opLog, overlay] = await Promise.all(uploads);
    assignment.assets.overlayPath = hasMerged ? overlay.path : primary.path;
    assignment.assets.mergedPath = hasMerged ? primary.path : null;
    assignment.assets.oplogPath = opLog.path;
    assignment.assets.folder = dir;
    await game.settings.set(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER, dir);
    pendingSubmissions.delete(assignment.id);
  }

  assignment.assets.name = resolvedName;
  await savePrompt(prompt);
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentSaved", prompt, assignment);
  await refreshManager();
  return assignment;
}

/**
 * Place an assignment as a Scene Tile.
 * @param {string} assignmentId Assignment id.
 * @param {{hidden?: boolean}} [options] Placement options.
 * @returns {Promise<object>}
 */
export async function placeAssignmentAsTile(assignmentId, { hidden = false } = {}) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  if ( !assignment.primaryImagePath ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.saveBeforePlace"));

  const scene = globalThis.canvas?.scene;
  if ( !scene ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.noScene"));
  const tileData = buildTileData({
    src: assignment.primaryImagePath,
    name: assignment.assets.name,
    width: prompt.canvasWidth,
    height: prompt.canvasHeight,
    center: {
      x: globalThis.canvas.stage?.pivot?.x ?? (Number(scene.width) / 2),
      y: globalThis.canvas.stage?.pivot?.y ?? (Number(scene.height) / 2)
    },
    scene: { width: scene.width, height: scene.height },
    hidden
  });
  const [tile] = await scene.createEmbeddedDocuments("Tile", [tileData]);
  assignment.placements.push({
    tileId: tile?.id ?? tile?._id ?? null,
    sceneId: scene.id,
    hidden: Boolean(hidden),
    placedAt: Date.now()
  });
  await savePrompt(prompt);
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentPlaced", prompt, assignment, tile);
  await refreshManager();
  return tile;
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
  await savePrompt(prompt);
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
    pendingSubmissions.delete(assignment.id);
  }
  await savePrompt(prompt);
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
  assignment.markReopened();
  await savePrompt(prompt);
  if ( game.users.get(assignment.userId)?.active ) await emit.reopenDrawingPrompt(assignment.userId, payloadFor(prompt, assignment));
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
    await savePrompt(prompt);
  } else if ( ![STATUS.PENDING, STATUS.OPENED].includes(assignment.status) ) {
    return;
  }
  if ( game.users.get(assignment.userId)?.active ) {
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

/**
 * Handle prompt open on the player client.
 * @param {object} payload Assignment payload.
 * @returns {Promise<void>}
 */
async function handleOpenPrompt(payload) {
  payload = validatePlayerPayload(payload);
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
  payload = validatePlayerPayload(payload);
  payload.assignment.status = STATUS.OPENED;
  upsertAssignment(payload);
  notifyPlayer("DRAWING-PROMPTS.player.notifications.reopened");
  await refreshPromptList();
  await PlayerDrawingApp.open(payload, { mode: "live" });
}

/**
 * Handle prompt cancellation on the player client.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
async function handleCancelPrompt(assignmentId) {
  validateKnownPlayerAssignment(assignmentId);
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
  const payload = validateKnownPlayerAssignment(assignmentId);
  if ( ![STATUS.PENDING, STATUS.OPENED].includes(payload.assignment.status) ) return;
  await PlayerDrawingApp.open(payload, { mode: "live" });
}

/**
 * Handle a GM request for the current player-side snapshot.
 * @param {string} assignmentId Assignment id.
 * @returns {Promise<void>}
 */
async function handleRequestSnapshot(assignmentId) {
  validateKnownPlayerAssignment(assignmentId);
  await PlayerDrawingApp.sendSnapshotForAssignment(assignmentId);
}

/**
 * Handle assignment opened on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @returns {Promise<void>}
 */
async function handleAssignmentOpened(assignmentId, userId) {
  const { prompt, assignment } = validateOwningGMSender(assignmentId, userId);
  assignment.markOpened(Date.now());
  await savePrompt(prompt);
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentOpened", prompt, assignment);
  await setManagerWindowOpen(assignment.id, true);
  await refreshManager();
}

/**
 * Handle a snapshot on the owning GM.
 * @param {string} assignmentId Assignment id.
 * @param {string} userId Player user id.
 * @param {string} snapshotDataUrl Snapshot data URL.
 * @returns {Promise<void>}
 */
async function handleDrawingSnapshot(assignmentId, userId, snapshotDataUrl) {
  validateOwningGMSender(assignmentId, userId);
  DrawingPromptManager.receiveSnapshotOpen(assignmentId, snapshotDataUrl);
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
  const now = Date.now();
  if ( assignment.status === STATUS.PENDING ) assignment.markOpened(now);
  const late = prompt.deadlineAt ? now > prompt.deadlineAt : false;
  const overtimeMs = late ? now - prompt.deadlineAt : null;
  assignment.markSubmitted({ ts: now, late, overtimeMs });
  pendingSubmissions.set(assignment.id, submissionPayload);
  await savePrompt(prompt);
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentSubmitted", prompt, assignment, submissionPayload);
  const previewDataUrl = submissionPayload?.merged?.dataUrl ?? submissionPayload?.overlay?.dataUrl;
  if ( previewDataUrl ) DrawingPromptManager.receiveSnapshotOpen(assignment.id, previewDataUrl);
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
  assignment.markRejected(Date.now());
  await savePrompt(prompt);
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
 * Verify prompt ownership.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {void}
 */
function assertPromptOwner(prompt) {
  if ( prompt.gmUserId !== game.user.id ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.notPromptOwner"));
}

/**
 * Notify a player if enabled.
 * @param {string} key Localization key.
 * @returns {void}
 */
function notifyPlayer(key) {
  if ( game.settings.get(MODULE_ID, SETTINGS.NOTIFY_PLAYER) ) ui.notifications.info(game.i18n.localize(key));
}

/**
 * Refresh the GM manager if present.
 * @returns {Promise<void>}
 */
async function refreshManager() {
  if ( !game.user.isGM ) return;
  DrawingPromptManager.refreshOpen();
}

/**
 * Update the manager's window-open state.
 * @param {string} assignmentId Assignment id.
 * @param {boolean} open Whether open.
 * @returns {Promise<void>}
 */
async function setManagerWindowOpen(assignmentId, open) {
  if ( !game.user.isGM ) return;
  DrawingPromptManager.setWindowOpen(assignmentId, open);
}

/**
 * Refresh the player prompt list if present.
 * @returns {Promise<void>}
 */
async function refreshPromptList() {
  PlayerPromptList.refreshOpen();
}

/**
 * Resolve a non-empty drawing asset name.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {string|undefined} explicitName Explicit name.
 * @returns {string}
 */
function resolveDrawingName(prompt, assignment, explicitName) {
  return String(explicitName ?? defaultAssignmentAssetName({
    drawingName: prompt.drawingName,
    promptText: prompt.promptText,
    userName: assignment.userName
  })).trim();
}

/**
 * Convert an exported format to a file extension.
 * @param {string} format Export format.
 * @returns {string}
 */
function extensionFor(format) {
  return format === "png" ? "png" : "webp";
}
