/**
 * Place / Transform — Tile, Token, and controlled-token artwork application.
 */

import { FRAMING_VIEW } from "../constants.mjs";
import { buildTileData } from "../foundry/tile-placement-service.mjs";
import { PLACE_MODES, buildTokenData, pickActorType, validatePlaceSelection } from "../foundry/token-placement-service.mjs";
import {
  isStagedSubmission,
  submissionTileHeight,
  submissionTileWidth
} from "./assignment-save.mjs";
import {
  hasSourceBackground,
  normalizeFramingView,
  resolveFramingViewAssetPath,
  resolveTileDimensionsForFramingView
} from "./dual-save.mjs";
import { getPendingSubmission } from "./pending-submission.mjs";
import { savePrompt } from "./persistence-service.mjs";
import { assertPromptOwner, requirePromptAssignment } from "./prompt-context.mjs";
import { assertGM } from "./socket-auth.mjs";
import { isSaveGateOpen } from "./transitions.mjs";
import { refreshManager } from "./ui-bridge.mjs";

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
 * Place an assignment as a Scene Tile.
 * @param {string} assignmentId Assignment id.
 * @param {{hidden?: boolean, name?: string, framingView?: string, interactive?: boolean}} [options] Placement options.
 * @returns {Promise<object|null>}
 */
export async function placeAssignmentAsTile(assignmentId, {
  hidden = false,
  name = "",
  framingView = FRAMING_VIEW.PROMPT_CANVAS,
  interactive = false
} = {}) {
  const { prompt, assignment, scene, imagePath } = requirePlacementContext(assignmentId, framingView);
  const submission = getPendingSubmission(assignmentId);
  const promptCanvasFallback = {
    width: assignment.assets.tileWidth ?? submissionTileWidth(submission, prompt),
    height: assignment.assets.tileHeight ?? submissionTileHeight(submission, prompt)
  };
  const { width: tileWidth, height: tileHeight } = resolveTileDimensionsForFramingView(
    prompt,
    assignment,
    framingView,
    promptCanvasFallback
  );
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

  let tile = null;
  if ( interactive ) {
    const { placeWithLayerPreview } = await import("../foundry/canvas-place-preview.mjs");
    tile = await placeWithLayerPreview({ layerName: "tiles", createData: tileData });
    if ( !tile ) return null;
  } else {
    [tile] = await scene.createEmbeddedDocuments("Tile", [tileData]);
  }

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
export async function placeAssignmentAsToken(assignmentId, {
  mode,
  name = "",
  actorUuid = "",
  hidden = false,
  framingView = FRAMING_VIEW.PROMPT_CANVAS,
  interactive = false
} = {}) {
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
    const tokenData = tokenDocument.toObject();
    if ( interactive ) {
      const { placeWithLayerPreview } = await import("../foundry/canvas-place-preview.mjs");
      token = await placeWithLayerPreview({ layerName: "tokens", createData: tokenData });
      if ( !token ) {
        if ( createdActor && actor?.id ) {
          try {
            await actor.delete();
          } catch ( _cleanupError ) {
            // Best effort.
          }
        }
        return null;
      }
    } else {
      [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
    }
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
