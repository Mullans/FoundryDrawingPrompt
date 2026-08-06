import { FILES_UPLOAD_PERMISSION, FRAMING_VIEW, MODULE_ID, SETTINGS, STATUS } from "../constants.mjs";
import { PlayerDrawingApp } from "../apps/player-drawing-app.mjs";
import { PlayerPromptList } from "../apps/player-prompt-list.mjs";
import { buildTileData } from "../foundry/tile-placement-service.mjs";
import { isForge, resolvePromptAssetLocation } from "../foundry/path-provider.mjs";
import { PLACE_MODES, buildTokenData, pickActorType, validatePlaceSelection } from "../foundry/token-placement-service.mjs";
import { CALLS, emit } from "../socket.mjs";
import { browseFiles, defaultAssetFolder, ensureDir, normalizePath, pendingDir, stagingDir, uploadBlob, uploadDataUrl, uploadJson } from "./asset-service.mjs";
import { getAssignment as getClientAssignment, updateStatus, updateTimerState, upsertAssignment } from "./client-store.mjs";
import { createPromptEntry, deletePromptEntry, getPromptIdForAssignment, loadAllPrompts, loadPrompt, savePrompt } from "./persistence-service.mjs";
import { defaultAssignmentAssetName, promptAssetFolderName, uniqueDrawingAssetFilenames } from "./naming-service.mjs";
import { prepareFramedBackgroundForSend, serializeBackgroundForPlayer } from "./framed-delivery.mjs";
import {
  bakeAndEncodeSourceFraming,
  clearFramingViewAssets,
  decodeImageToRgba,
  hasSavedFramingViewAssets,
  hasSourceBackground,
  normalizeFramingView,
  resolveFramingViewAssetPath,
  resolveSubmissionOverlaySize
} from "./dual-save.mjs";
import { DrawingPrompt } from "./prompt-models.mjs";
import { assertGM, assertPromptGmMatchesInitiator } from "./socket-auth.mjs";
import { adjustTimer, evaluateSubmissionTiming, normalizeTimerState, pauseTimer, resetTimer, resumeTimer, stopTimer } from "./timer-service.mjs";
import { TimerUpdateQueue } from "./timer-update-queue.mjs";
import { evaluateOpened, evaluateRejection, evaluateSnapshot, evaluateSubmission, isSaveGateOpen, validateSubmissionPayload } from "./transitions.mjs";
import { receiveManagerSnapshot, refreshManager, setManagerWindowOpen } from "./ui-bridge.mjs";
import { isValidSnapshotPayload } from "./wire-validation.mjs";

const pendingSubmissions = new Map();
const timerUpdateQueue = new TimerUpdateQueue();
const SUBMISSION_KEY_PREFIX = "drawing-prompts.sub.";
const SUBMISSION_INDEX_KEY = "drawing-prompts.sub.index";
const SUBMISSION_CACHE_LIMIT = 8 * 1024 * 1024;

/**
 * Build Actor artwork data for a saved drawing.
 * @param {string} name Actor name.
 * @param {string} src Saved drawing path.
 * @returns {object} Actor artwork data.
 */
function buildActorArtData(name, src) {
  return {
    name: String(name).trim(),
    img: src,
    prototypeToken: { texture: { src } }
  };
}

/**
 * Find the prompt and assignment pair for an assignment id.
 * @param {string} assignmentId Assignment id.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment}}
 */
function requirePromptAssignment(assignmentId) {
  const promptId = getPromptIdForAssignment(assignmentId);
  if ( promptId ) {
    const prompt = loadPrompt(promptId);
    const assignment = prompt?.getAssignment(assignmentId);
    if ( prompt && assignment ) return { prompt, assignment };
  }
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
      background: serializeBackgroundForPlayer(prompt),
      sentAt: prompt.sentAt,
      timerSeconds: prompt.timerSeconds,
      ...prompt.timerState
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
  await prepareFramedBackgroundForSend(prompt);
  // Prompt creation requires a full save to establish prompt-level and all assignment state.
  await savePrompt(prompt);
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
 * Pause a prompt timer at its current value, including overtime.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function pausePromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => pauseTimer(state, now));
}

/**
 * Resume a paused prompt timer without counting paused time.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function resumePromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => resumeTimer(state, now));
}

/**
 * Shift a prompt's running deadline or paused remaining time.
 * @param {string} promptId Prompt id.
 * @param {number} deltaMs Signed adjustment in milliseconds.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function adjustPromptTimer(promptId, deltaMs) {
  return updatePromptTimer(promptId, (state, prompt, now) => adjustTimer(state, deltaMs, now));
}

/**
 * Restart a prompt timer from its original configured duration.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function resetPromptTimer(promptId) {
  return updatePromptTimer(promptId, (state, prompt, now) => resetTimer(state, prompt.timerSeconds, now));
}

/**
 * Stop a prompt timer and make the prompt untimed.
 * @param {string} promptId Prompt id.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
export function stopPromptTimer(promptId) {
  return updatePromptTimer(promptId, state => stopTimer(state));
}

/**
 * Apply, persist, and deliver one GM-owned timer transition.
 * @param {string} promptId Prompt id.
 * @param {Function} transition Pure timer transition.
 * @returns {Promise<import("./prompt-models.mjs").DrawingPrompt>}
 */
function updatePromptTimer(promptId, transition) {
  return timerUpdateQueue.enqueue(promptId, async () => {
    assertGM();
    const prompt = loadPrompt(promptId);
    if ( !prompt ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.promptNotFound"));
    assertPromptOwner(prompt);
    prompt.timerState = transition(prompt.timerState, prompt, Date.now());
    await savePrompt(prompt, { timerOnly: true });
    Hooks.callAll("drawing-prompts.timerUpdated", prompt, prompt.timerState);
    await broadcastTimerState(prompt);
    await refreshManager();
    return prompt;
  });
}

/**
 * Deliver the current timer state to every online assigned player.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<void>}
 */
async function broadcastTimerState(prompt) {
  const deliveries = Object.values(prompt.assignments)
    .filter(assignment => game.users.get(assignment.userId)?.active)
    .map(assignment => emit.timerUpdated(assignment.userId, assignment.id, prompt.timerState));
  const results = await Promise.allSettled(deliveries);
  for ( const result of results ) {
    if ( result.status === "rejected" ) console.warn("drawing-prompts | timer update delivery failed", result.reason);
  }
}

/**
 * Ensure a sent prompt has a baked Framed background before player delivery.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<void>}
 */
async function ensureFramedBackgroundDelivered(prompt) {
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
async function deliverPromptAssignments(prompt) {
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
export async function createPrompt(options = {}) {
  const { awaitDeliveries, ...draft } = options;
  return createAndSendPrompt({ ...draft, awaitDeliveries });
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
  const promptId = getPromptIdForAssignment(assignmentId);
  if ( promptId ) {
    const assignment = loadPrompt(promptId)?.getAssignment(assignmentId);
    if ( assignment ) return assignment;
  }
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
  const submission = pendingSubmissions.get(assignmentId) ?? readCachedSubmission(assignmentId);
  if ( submission && !pendingSubmissions.has(assignmentId) ) pendingSubmissions.set(assignmentId, submission);
  if ( submission ) return submission;
  const assignment = getAssignment(assignmentId);
  if ( assignment?.pendingSubmission ) {
    pendingSubmissions.set(assignmentId, assignment.pendingSubmission);
    return assignment.pendingSubmission;
  }
  return null;
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
  const resolvedName = resolveDrawingName(prompt, name);
  if ( !resolvedName ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.nameRequired"));

  const alreadySaved = Boolean(assignment.primaryImagePath && assignment.assets?.overlayPath && assignment.assets?.oplogPath);
  const submission = pendingSubmissions.get(assignment.id) ?? readCachedSubmission(assignment.id);
  if ( submission && !pendingSubmissions.has(assignment.id) ) pendingSubmissions.set(assignment.id, submission);
  if ( !submission && !alreadySaved ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.pendingSubmissionLost"));

  if ( submission ) {
    prompt.assetFolderName ??= promptAssetFolderName({
      promptId: prompt.id,
      promptText: prompt.promptText,
      sentAt: prompt.sentAt,
      createdAt: prompt.createdAt
    });
    const location = resolvePromptAssetLocation({
      selectedParent: folder,
      rememberedParent: game.settings.get(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER),
      defaultParent: defaultAssetFolder(),
      assignmentFolder: assignment.assets?.folder,
      promptFolderName: prompt.assetFolderName
    });
    const dir = location.final;
    await ensureDir(dir);
    const hasMerged = hasMergedSubmission(submission);
    const writeSourceFull = hasSourceBackground(prompt);
    const filenames = uniqueDrawingAssetFilenames({
      name: resolvedName,
      playerName: assignment.userName,
      extension: extensionFor(primarySubmissionFormat(submission, hasMerged)),
      hasMerged,
      hasSourceFull: writeSourceFull,
      existingFiles: await browseFiles(dir),
      fallback: game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.defaultSlug")
    });
    const [primary, opLog, overlay] = await uploadSubmissionAssets(dir, filenames, submission, hasMerged);
    assignment.assets.overlayPath = hasMerged ? overlay.path : primary.path;
    assignment.assets.mergedPath = hasMerged ? primary.path : null;
    assignment.assets.oplogPath = opLog.path;
    if ( writeSourceFull ) {
      const full = await uploadSourceFramingAsset({
        dir,
        filename: filenames.sourceFull,
        submission,
        prompt,
        format: extensionFor(primarySubmissionFormat(submission, hasMerged))
      });
      assignment.assets.fullPath = full.path;
    } else {
      assignment.assets.fullPath = null;
    }
    assignment.assets.folder = dir;
    assignment.assets.tileWidth = submissionTileWidth(submission, prompt);
    assignment.assets.tileHeight = submissionTileHeight(submission, prompt);
    assignment.pendingSubmission = null;
    assignment.savedSubmissionTs = assignment.submittedAt;
    await game.settings.set(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER, location.parent);
    pendingSubmissions.delete(assignment.id);
    clearCachedSubmission(assignment.id);
  } else if ( alreadySaved && assignment.status === STATUS.SUBMITTED && assignment.primaryImagePath ) {
    assignment.savedSubmissionTs ??= assignment.submittedAt;
  }

  assignment.assets.name = resolvedName;
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentSaved", prompt, assignment);
  await refreshManager();
  return assignment;
}

/**
 * Place an assignment as a Scene Tile.
 * @param {string} assignmentId Assignment id.
 * @param {{hidden?: boolean, name?: string, framingView?: string}} [options] Placement options.
 * @returns {Promise<object>}
 */
export async function placeAssignmentAsTile(assignmentId, { hidden = false, name = "", framingView = FRAMING_VIEW.PROMPT_CANVAS } = {}) {
  const { prompt, assignment, scene, imagePath } = requirePlacementContext(assignmentId, framingView);
  const submission = getPendingSubmission(assignmentId);
  const tileWidth = assignment.assets.tileWidth ?? submissionTileWidth(submission, prompt);
  const tileHeight = assignment.assets.tileHeight ?? submissionTileHeight(submission, prompt);
  if ( submission?.wireScaled && !isStagedSubmission(submission) ) {
    ui.notifications.warn(game.i18n.format("DRAWING-PROMPTS.manager.warnings.wireScaledPlacement", {
      width: tileWidth,
      height: tileHeight
    }));
  }
  const tileData = buildTileData({
    src: imagePath,
    name: String(name || assignment.assets.name || "").trim(),
    width: tileWidth,
    height: tileHeight,
    center: {
      x: globalThis.canvas.stage?.pivot?.x ?? (Number(scene.width) / 2),
      y: globalThis.canvas.stage?.pivot?.y ?? (Number(scene.height) / 2)
    },
    scene: { width: scene.width, height: scene.height },
    hidden
  });
  // Tile#name only exists on Foundry v14+; strip it on older schemas (v13).
  if ( !CONFIG.Tile.documentClass.schema.fields.name ) delete tileData.name;
  const [tile] = await scene.createEmbeddedDocuments("Tile", [tileData]);
  assignment.placements.push({
    kind: "tile",
    tileId: tile?.id ?? tile?._id ?? null,
    sceneId: scene.id,
    hidden: Boolean(hidden),
    placedAt: Date.now()
  });
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentPlaced", prompt, assignment, tile, { kind: "tile" });
  await refreshManager();
  return tile;
}

/**
 * Place an assignment as a Token using a new, copied, or existing world Actor.
 * @param {string} assignmentId Assignment id.
 * @param {object} options Placement options.
 * @param {string} options.mode Place mode.
 * @param {string} [options.name] Actor name for New Actor or Copy Actor.
 * @param {string} [options.actorUuid] Source world Actor UUID.
 * @param {boolean} [options.hidden=false] Whether the Token is hidden.
 * @param {string} [options.framingView] Framing View whose saved raster is placed.
 * @returns {Promise<object>}
 */
export async function placeAssignmentAsToken(assignmentId, { mode, name = "", actorUuid = "", hidden = false, framingView = FRAMING_VIEW.PROMPT_CANVAS } = {}) {
  const { prompt, assignment, scene, imagePath } = requirePlacementContext(assignmentId, framingView);
  const validationError = mode === PLACE_MODES.TILE ? "invalidMode" : validatePlaceSelection({ mode, name, actorUuid });
  if ( validationError ) {
    throw new Error(game.i18n.localize(`DRAWING-PROMPTS.placeDialog.validation.${validationError}`));
  }

  const src = imagePath;
  let actor;
  let createdActor = false;
  if ( mode === PLACE_MODES.NEW_ACTOR ) {
    const type = pickActorType(game.system.id, game.documentTypes.Actor);
    if ( !type ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.noActorType"));
    actor = await CONFIG.Actor.documentClass.create({ type, ...buildActorArtData(name, src) });
    createdActor = true;
  } else {
    const sourceActor = findWorldActor(actorUuid);
    if ( !sourceActor ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.actorNotFound"));
    actor = mode === PLACE_MODES.COPY_ACTOR
      ? await sourceActor.clone(buildActorArtData(name, src), { save: true })
      : sourceActor;
    createdActor = mode === PLACE_MODES.COPY_ACTOR;
  }

  let token;
  try {
    const tokenOverrides = buildTokenData({
      actorId: actor.id,
      src,
      center: {
        x: globalThis.canvas.stage?.pivot?.x ?? (Number(scene.width) / 2),
        y: globalThis.canvas.stage?.pivot?.y ?? (Number(scene.height) / 2)
      },
      scene: { width: scene.width, height: scene.height },
      gridSize: scene.grid?.size ?? globalThis.canvas.dimensions?.size ?? 1,
      hidden
    });
    const tokenDocument = await actor.getTokenDocument(tokenOverrides, { parent: scene });
    [token] = await scene.createEmbeddedDocuments("Token", [tokenDocument.toObject()]);
    if ( !token ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.tokenPlacementFailed"));
  } catch (err) {
    if ( createdActor && actor?.id ) {
      try {
        await actor.delete();
      } catch (cleanupError) {
        console.warn("drawing-prompts | could not remove Actor after Token placement failed", cleanupError);
      }
    }
    throw err;
  }
  assignment.placements.push({
    kind: "token",
    tokenId: token?.id ?? token?._id ?? null,
    actorId: actor.id,
    sceneId: scene.id,
    hidden: Boolean(hidden),
    placedAt: Date.now()
  });
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  Hooks.callAll("drawing-prompts.assignmentUpdated", prompt, assignment);
  Hooks.callAll("drawing-prompts.assignmentPlaced", prompt, assignment, token, { kind: "token" });
  await refreshManager();
  return token;
}

/**
 * Apply a saved assignment drawing to the GM's currently controlled tokens.
 * @param {string} assignmentId Assignment id.
 * @param {{framingView?: string}} [options] Framing View whose saved raster is applied.
 * @returns {Promise<object[]>} Token placeables that received the drawing.
 */
export async function applyAssignmentTransform(assignmentId, { framingView = FRAMING_VIEW.PROMPT_CANVAS } = {}) {
  const { assignment, imagePath } = requireTransformContext(assignmentId, framingView);
  const { applyTransformToControlledTokens } = await import("../foundry/token-transform-service.mjs");
  return applyTransformToControlledTokens(assignment, { imagePath });
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
    pendingSubmissions.delete(assignment.id);
    clearCachedSubmission(assignment.id);
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
  if ( hasSavedFramingViewAssets(assignment) ) clearFramingViewAssets(assignment);
  assignment.markReopened();
  assignment.pendingSubmission = null;
  pendingSubmissions.delete(assignment.id);
  clearCachedSubmission(assignment.id);
  await savePrompt(prompt, { assignmentOnly: assignment.id });
  await ensureFramedBackgroundDelivered(prompt);
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
 * @returns {Promise<void>}
 */
async function handleRequestSnapshot(assignmentId) {
  const payload = validateKnownActivePlayerAssignment(assignmentId, "request-snapshot");
  if ( !payload ) return;
  try {
    assertPromptGmMatchesInitiator(this?.socketdata?.userId, payload.prompt?.gmUserId);
  } catch (err) {
    console.debug("drawing-prompts | ignored snapshot request", err);
    return;
  }
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
  pendingSubmissions.set(assignment.id, receivedSubmission);
  assignment.pendingSubmission = receivedSubmission;
  cacheSubmission(assignment.id, receivedSubmission);
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
 * Validate a player assignment for active-only remote handlers.
 * @param {string} assignmentId Assignment id.
 * @param {string} action Handler action name.
 * @returns {{assignment: object, prompt: object}|null} Player payload or null.
 */
function validateKnownActivePlayerAssignment(assignmentId, action) {
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
 * Log an ignored lifecycle transition.
 * @param {string} event Event name.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {string} reason Ignore reason.
 * @returns {void}
 */
function debugIgnoredTransition(event, assignment, reason) {
  console.debug(`drawing-prompts | ignored ${event} for assignment ${assignment?.id ?? "unknown"}: ${reason ?? "inactive"}`);
}

/**
 * Cache a pending submission in sessionStorage for same-session GM reloads.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Submission payload.
 * @returns {void}
 */
function cacheSubmission(assignmentId, submission) {
  if ( !game.user.isGM || !globalThis.sessionStorage ) return;
  try {
    const serialized = JSON.stringify(submission);
    sessionStorage.setItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`, serialized);
    const index = readSubmissionIndex();
    index[assignmentId] = { ts: Date.now(), size: serialized.length };
    writeSubmissionIndex(index);
    evictSubmissionCache(index);
  } catch (err) {
    if ( err?.name === "QuotaExceededError" ) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.submissionCacheQuota"));
    }
  }
}

/**
 * Read a cached submission payload.
 * @param {string} assignmentId Assignment id.
 * @returns {object|null} Cached submission or null.
 */
function readCachedSubmission(assignmentId) {
  if ( !globalThis.sessionStorage ) return null;
  try {
    const serialized = sessionStorage.getItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    if ( !serialized ) return null;
    return JSON.parse(serialized);
  } catch (_err) {
    clearCachedSubmission(assignmentId);
    return null;
  }
}

/**
 * Clear one cached submission.
 * @param {string} assignmentId Assignment id.
 * @returns {void}
 */
function clearCachedSubmission(assignmentId) {
  if ( !globalThis.sessionStorage ) return;
  try {
    sessionStorage.removeItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    const index = readSubmissionIndex();
    delete index[assignmentId];
    writeSubmissionIndex(index);
  } catch (_err) {
    // Ignore storage failures.
  }
}

/**
 * Read submission cache index.
 * @returns {Record<string, {ts: number, size: number}>} Cache index.
 */
function readSubmissionIndex() {
  try {
    return JSON.parse(sessionStorage.getItem(SUBMISSION_INDEX_KEY) || "{}");
  } catch (_err) {
    return {};
  }
}

/**
 * Write submission cache index.
 * @param {Record<string, {ts: number, size: number}>} index Cache index.
 * @returns {void}
 */
function writeSubmissionIndex(index) {
  try {
    sessionStorage.setItem(SUBMISSION_INDEX_KEY, JSON.stringify(index));
  } catch (_err) {
    // Ignore storage failures.
  }
}

/**
 * Evict old cached submissions when the coarse quota is exceeded.
 * @param {Record<string, {ts: number, size: number}>} index Cache index.
 * @returns {void}
 */
function evictSubmissionCache(index) {
  let total = Object.values(index).reduce((sum, item) => sum + Number(item.size || 0), 0);
  const protectedIds = new Set(
    [...pendingSubmissions.keys()].filter(assignmentId => {
      const submission = pendingSubmissions.get(assignmentId);
      return submission && !submissionPersistedOnDisk(submission);
    })
  );
  const entries = Object.entries(index).sort((a, b) => Number(a[1].ts || 0) - Number(b[1].ts || 0));
  for ( const [assignmentId, item] of entries ) {
    if ( total <= SUBMISSION_CACHE_LIMIT ) break;
    if ( protectedIds.has(assignmentId) ) continue;
    sessionStorage.removeItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    total -= Number(item.size || 0);
    delete index[assignmentId];
  }
  writeSubmissionIndex(index);
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
 * Validate common server-side placement requirements.
 * @param {string} assignmentId Assignment id.
 * @param {string} [framingView] Framing View whose asset is placed.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment, scene: object, imagePath: string}}
 */
function requirePlacementContext(assignmentId, framingView = FRAMING_VIEW.PROMPT_CANVAS) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  const imagePath = resolveFramingViewAssetPath(
    assignment,
    normalizeFramingView(framingView, { hasSource: hasSourceBackground(prompt) })
  );
  if ( !imagePath || !isSaveGateOpen(assignment) ) {
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.saveBeforePlace"));
  }
  const scene = globalThis.canvas?.scene;
  if ( !scene ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.noScene"));
  return { prompt, assignment, scene, imagePath };
}

/**
 * Validate common server-side transform requirements without requiring an active Scene.
 * @param {string} assignmentId Assignment id.
 * @param {string} [framingView] Framing View whose asset is applied.
 * @returns {{prompt: import("./prompt-models.mjs").DrawingPrompt, assignment: import("./prompt-models.mjs").DrawingAssignment, imagePath: string}}
 */
function requireTransformContext(assignmentId, framingView = FRAMING_VIEW.PROMPT_CANVAS) {
  assertGM();
  const { prompt, assignment } = requirePromptAssignment(assignmentId);
  assertPromptOwner(prompt);
  const imagePath = resolveFramingViewAssetPath(
    assignment,
    normalizeFramingView(framingView, { hasSource: hasSourceBackground(prompt) })
  );
  if ( !imagePath || !isSaveGateOpen(assignment) ) {
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.transform.saveFirst"));
  }
  return { prompt, assignment, imagePath };
}

/**
 * Resolve a world Actor by UUID.
 * @param {string} uuid Actor UUID.
 * @returns {object|null}
 */
function findWorldActor(uuid) {
  return Array.from(game.actors ?? []).find(actor => actor.uuid === uuid) ?? null;
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
 * Refresh the player prompt list if present.
 * @returns {Promise<void>}
 */
async function refreshPromptList() {
  PlayerPromptList.refreshOpen();
}

/**
 * Build validation context for inbound submission payloads.
 * @param {string} assignmentId Assignment id.
 * @returns {{assignmentId: string, stagingRoot: string, pendingRoot: string, forge: boolean}}
 */
function submissionValidationContext(assignmentId) {
  return {
    assignmentId,
    stagingRoot: stagingDir(),
    pendingRoot: pendingDir(assignmentId),
    forge: isForge()
  };
}

/**
 * Persist a socket-lane submission to the GM pending folder and rewrite as staged paths.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Socket submission payload.
 * @returns {Promise<object>} Staged-shaped persisted submission.
 */
async function persistSocketSubmission(assignmentId, submission) {
  const dir = pendingDir(assignmentId);
  await ensureDir(dir);
  const hasMerged = Boolean(submission.merged?.dataUrl);
  const overlayExt = extensionFor(submission.overlay?.format);
  const overlay = await uploadDataUrl(dir, `overlay.${overlayExt}`, submission.overlay.dataUrl);
  let merged = null;
  if ( hasMerged ) {
    merged = await uploadDataUrl(dir, `merged.${extensionFor(submission.merged.format)}`, submission.merged.dataUrl);
  }
  return {
    mode: "staged",
    staged: {
      overlayPath: overlay.path,
      mergedPath: merged?.path ?? null
    },
    formats: {
      overlay: submission.overlay?.format ?? "webp",
      merged: hasMerged ? submission.merged?.format ?? "webp" : null
    },
    opLog: submission.opLog,
    width: submission.width,
    height: submission.height,
    originalWidth: submission.originalWidth,
    originalHeight: submission.originalHeight,
    wireScaled: submission.wireScaled,
    opLogTruncated: submission.opLogTruncated,
    receiptTs: submission.receiptTs
  };
}

/**
 * Test whether a submission is already persisted on the server data source.
 * @param {object} submission Submission payload.
 * @returns {boolean} Whether persisted on disk.
 */
function submissionPersistedOnDisk(submission) {
  return isStagedSubmission(submission);
}

/**
 * Resolve tile width from a submission payload.
 * @param {object|null} submission Submission payload.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {number}
 */
function submissionTileWidth(submission, prompt) {
  return Number(submission?.originalWidth ?? submission?.width ?? prompt.canvasWidth);
}

/**
 * Resolve tile height from a submission payload.
 * @param {object|null} submission Submission payload.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {number}
 */
function submissionTileHeight(submission, prompt) {
  return Number(submission?.originalHeight ?? submission?.height ?? prompt.canvasHeight);
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

/**
 * Upload submission assets through the shared naming tail.
 * @param {string} dir Target directory.
 * @param {object} filenames Resolved filenames.
 * @param {object} submission Submission payload.
 * @param {boolean} hasMerged Whether a merged image exists.
 * @returns {Promise<[{path: string}, {path: string}, {path: string}|undefined]>} Uploaded assets.
 */
async function uploadSubmissionAssets(dir, filenames, submission, hasMerged) {
  if ( isStagedSubmission(submission) ) {
    const primaryPath = hasMerged ? submission.staged.mergedPath : submission.staged.overlayPath;
    const uploads = [
      uploadStagedPath(dir, filenames.primary, primaryPath, submission.receiptTs),
      uploadJson(dir, filenames.opLog, submission.opLog ?? {})
    ];
    if ( hasMerged ) uploads.push(uploadStagedPath(dir, filenames.overlay, submission.staged.overlayPath, submission.receiptTs));
    return Promise.all(uploads);
  }

  const primaryDataUrl = hasMerged ? submission.merged?.dataUrl : submission.overlay?.dataUrl;
  const uploads = [
    uploadDataUrl(dir, filenames.primary, primaryDataUrl),
    uploadJson(dir, filenames.opLog, submission.opLog ?? {})
  ];
  if ( hasMerged ) uploads.push(uploadDataUrl(dir, filenames.overlay, submission.overlay?.dataUrl));
  return Promise.all(uploads);
}

/**
 * Upload a staged file path into the GM-selected final folder.
 * @param {string} dir Target directory.
 * @param {string} filename Target filename.
 * @param {string} path Staged source path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {Promise<{path: string}>} Uploaded final asset.
 */
async function uploadStagedPath(dir, filename, path, receiptTs) {
  const blob = await fetchStagedBlob(path, receiptTs);
  return uploadBlob(dir, filename, blob);
}

/**
 * Load a submission overlay as an RGBA buffer in Prompt canvas coordinates.
 * Wire-scaled submissions are decoded to originalWidth/originalHeight so Source
 * Framing bake maps strokes as if on the full Prompt canvas.
 * @param {object} submission Submission payload.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}>}
 */
async function loadSubmissionOverlayRgba(submission, prompt) {
  const { width, height } = resolveSubmissionOverlaySize(submission, prompt);
  if ( isStagedSubmission(submission) ) {
    const blob = await fetchStagedBlob(submission.staged.overlayPath, submission.receiptTs);
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await decodeImageToRgba(objectUrl, width, height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  return decodeImageToRgba(submission.overlay.dataUrl, width, height);
}

/**
 * Bake and upload the Source Framing `_full` raster for one submission.
 * @param {object} options Upload options.
 * @param {string} options.dir Target directory.
 * @param {string} options.filename Target filename.
 * @param {object} options.submission Submission payload.
 * @param {import("./prompt-models.mjs").DrawingPrompt} options.prompt Prompt.
 * @param {string} options.format Output format.
 * @returns {Promise<{path: string}>}
 */
async function uploadSourceFramingAsset({ dir, filename, submission, prompt, format }) {
  const overlay = await loadSubmissionOverlayRgba(submission, prompt);
  const encoded = await bakeAndEncodeSourceFraming({ overlay, prompt, format });
  return uploadBlob(dir, filename, encoded.blob);
}

/**
 * Fetch a staged server file as a Blob.
 * @param {string} path Staged source path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {Promise<Blob>} Staged Blob.
 */
async function fetchStagedBlob(path, receiptTs) {
  try {
    const response = await fetch(stagedFetchUrl(path, receiptTs));
    if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  } catch (err) {
    console.warn("drawing-prompts | staged submission file fetch failed", path, err);
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.stagedSubmissionUnavailable"));
  }
}

/**
 * Resolve whether a submission uses staged file paths.
 * @param {object} submission Submission payload.
 * @returns {boolean} Whether staged.
 */
function isStagedSubmission(submission) {
  return submission?.mode === "staged";
}

/**
 * Resolve whether a submission includes merged output.
 * @param {object} submission Submission payload.
 * @returns {boolean} Whether merged output exists.
 */
function hasMergedSubmission(submission) {
  return isStagedSubmission(submission)
    ? Boolean(submission.staged?.mergedPath)
    : Boolean(submission.merged?.dataUrl);
}

/**
 * Resolve the primary image format for naming.
 * @param {object} submission Submission payload.
 * @param {boolean} hasMerged Whether merged output exists.
 * @returns {string} Export format.
 */
function primarySubmissionFormat(submission, hasMerged) {
  if ( isStagedSubmission(submission) ) return (hasMerged ? submission.formats?.merged : submission.formats?.overlay) ?? "webp";
  return (hasMerged ? submission.merged?.format : submission.overlay?.format) ?? "webp";
}

/**
 * Resolve a preview image source for a pending submission.
 * @param {object} submission Submission payload.
 * @returns {string|null} Preview source.
 */
function submissionPreviewSrc(submission) {
  if ( isStagedSubmission(submission) ) {
    const path = submission.staged?.mergedPath ?? submission.staged?.overlayPath;
    return path ? cacheBustedAssetSrc(path, submission.receiptTs) : null;
  }
  return submission?.merged?.dataUrl ?? submission?.overlay?.dataUrl ?? null;
}

/**
 * Build a fetch URL for a staged asset. Absolute URLs (e.g. Forge's Assets
 * Library) are used as-is; local paths are treated as root-relative.
 * @param {string} path Asset path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {string} Fetch URL.
 */
export function stagedFetchUrl(path, receiptTs) {
  const ts = `ts=${encodeURIComponent(String(receiptTs ?? Date.now()))}`;
  if ( /^https?:\/\//i.test(path) ) return `${path}${path.includes("?") ? "&" : "?"}${ts}`;
  return `/${encodeURI(normalizePath(path))}?${ts}`;
}

/**
 * Add a cache-buster query to an image asset source.
 * @param {string} path Asset path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {string} Image source.
 */
function cacheBustedAssetSrc(path, receiptTs) {
  return `${encodeURI(path)}?ts=${encodeURIComponent(String(receiptTs ?? Date.now()))}`;
}

/**
 * Convert an exported format to a file extension.
 * @param {string} format Export format.
 * @returns {string}
 */
function extensionFor(format) {
  return format === "png" ? "png" : "webp";
}
