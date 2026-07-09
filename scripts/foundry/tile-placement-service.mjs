/**
 * Clamp a tile's top-left position so the tile stays inside scene bounds.
 * @param {{x: number, y: number}} center Desired tile center in scene pixels.
 * @param {{width: number, height: number}} tile Tile dimensions in scene pixels.
 * @param {{width: number, height: number}} scene Scene dimensions in scene pixels.
 * @returns {{x: number, y: number}} Clamped tile top-left position.
 */
export function clampedTilePosition(center, tile, scene) {
  const width = Math.max(1, Math.round(Number(tile.width) || 1));
  const height = Math.max(1, Math.round(Number(tile.height) || 1));
  const sceneWidth = Math.max(0, Number(scene.width) || 0);
  const sceneHeight = Math.max(0, Number(scene.height) || 0);
  return {
    x: clamp(Math.round(Number(center.x) - (width / 2)), 0, Math.max(0, sceneWidth - width)),
    y: clamp(Math.round(Number(center.y) - (height / 2)), 0, Math.max(0, sceneHeight - height))
  };
}

/**
 * Build TileDocument creation data for Foundry v14.
 * @param {object} options Options.
 * @param {string} options.src Merged asset path.
 * @param {string} [options.name] Tile name.
 * @param {number} options.width Tile width.
 * @param {number} options.height Tile height.
 * @param {{x: number, y: number}} options.center Viewport center.
 * @param {{width: number, height: number}} options.scene Scene dimensions.
 * @param {boolean} [options.hidden=false] Whether the tile is hidden.
 * @returns {object} Tile creation data.
 */
export function buildTileData({ src, name, width, height, center, scene, hidden = false }) {
  const tileWidth = Math.max(1, Math.round(Number(width) || 1));
  const tileHeight = Math.max(1, Math.round(Number(height) || 1));
  const position = clampedTilePosition(center, { width: tileWidth, height: tileHeight }, scene);
  return {
    name: String(name ?? "").trim(),
    texture: { src },
    width: tileWidth,
    height: tileHeight,
    x: position.x,
    y: position.y,
    hidden: Boolean(hidden)
  };
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
