/** Place dialog mode identifiers. */
export const PLACE_MODES = Object.freeze({
  TILE: "tile",
  NEW_ACTOR: "newActor",
  COPY_ACTOR: "copyActor",
  EXISTING_ACTOR: "existingActor"
});

/**
 * Clamp a token's top-left position so its pixel footprint stays inside scene bounds.
 * @param {{x: number, y: number}} center Desired token center in scene pixels.
 * @param {number} gridSize Scene grid size in pixels.
 * @param {{width: number, height: number}} scene Scene dimensions in scene pixels.
 * @returns {{x: number, y: number}} Clamped token top-left position.
 */
export function clampedTokenPosition(center, gridSize, scene) {
  const footprint = Math.max(1, Math.round(Number(gridSize) || 1));
  const sceneWidth = Math.max(0, Number(scene.width) || 0);
  const sceneHeight = Math.max(0, Number(scene.height) || 0);
  return {
    x: clamp(Math.round(Number(center.x) - (footprint / 2)), 0, Math.max(0, sceneWidth - footprint)),
    y: clamp(Math.round(Number(center.y) - (footprint / 2)), 0, Math.max(0, sceneHeight - footprint))
  };
}

/**
 * Build one-grid-square TokenDocument creation data.
 * @param {object} options Options.
 * @param {string} options.actorId Actor document ID.
 * @param {string} options.src Drawing image path.
 * @param {{x: number, y: number}} options.center Viewport center.
 * @param {{width: number, height: number}} options.scene Scene dimensions in pixels.
 * @param {number} options.gridSize Scene grid size in pixels.
 * @param {boolean} [options.hidden=false] Whether the token is hidden.
 * @returns {object} Token creation data.
 */
export function buildTokenData({ actorId, src, center, scene, gridSize, hidden = false }) {
  const position = clampedTokenPosition(center, gridSize, scene);
  return {
    actorId,
    texture: { src },
    width: 1,
    height: 1,
    x: position.x,
    y: position.y,
    hidden: Boolean(hidden)
  };
}

/**
 * Pick the minimal actor type for the active game system.
 * @param {string} systemId Active system ID.
 * @param {string[]} actorTypes Available Actor document types.
 * @returns {string|null} Chosen actor type, or null when none is available.
 */
export function pickActorType(systemId, actorTypes) {
  if ( systemId === "dnd5e" ) return "npc";
  return Array.from(actorTypes ?? []).find(type => type !== "base") ?? null;
}

/**
 * Validate the fields required by a place dialog selection.
 * @param {{mode?: string, name?: string, actorUuid?: string}} selection Selection fields.
 * @returns {"nameRequired"|"actorRequired"|"invalidMode"|null} Validation error identifier.
 */
export function validatePlaceSelection({ mode, name, actorUuid }) {
  const hasName = Boolean(String(name ?? "").trim());
  const hasActor = Boolean(String(actorUuid ?? "").trim());

  switch ( mode ) {
    case PLACE_MODES.TILE:
      return null;
    case PLACE_MODES.NEW_ACTOR:
      return hasName ? null : "nameRequired";
    case PLACE_MODES.COPY_ACTOR:
      if (!hasName) return "nameRequired";
      return hasActor ? null : "actorRequired";
    case PLACE_MODES.EXISTING_ACTOR:
      return hasActor ? null : "actorRequired";
    default:
      return "invalidMode";
  }
}

/**
 * Clamp a number.
 * @param {number} value Value.
 * @param {number} min Min.
 * @param {number} max Max.
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
