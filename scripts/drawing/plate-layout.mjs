/**
 * Pure layout helpers for aspect-true Canvas plates inside a host pane.
 * Letterbox / pillarbox the plate; never stretch aspect to fill the void.
 */

/**
 * Read the host pane size used to letterbox an aspect-true plate.
 * @param {Element|null|undefined} stage Plate stage element.
 * @returns {{containerWidth: number, containerHeight: number}}
 */
export function measurePlateContainer(stage) {
  const containerWidth = Math.max(1, Math.floor(Number(stage?.clientWidth) || 1));
  const containerHeight = Math.max(1, Math.floor(Number(stage?.clientHeight) || 1));
  return { containerWidth, containerHeight };
}

/**
 * Size a plate element to fit its stage while preserving content aspect.
 * @param {HTMLElement|null|undefined} plate Plate element.
 * @param {Element|null|undefined} stage Host stage element.
 * @param {{width: number, height: number}} content Logical content size.
 * @returns {{width: number, height: number}|null}
 */
export function layoutPlateInStage(plate, stage, content) {
  if ( !plate || !stage ) return null;
  const size = fitPlateInBox({
    contentWidth: content.width,
    contentHeight: content.height,
    ...measurePlateContainer(stage)
  });
  plate.style.width = `${size.width}px`;
  plate.style.height = `${size.height}px`;
  return size;
}

/**
 * Fit a content box inside a container while preserving aspect ratio (contain).
 * @param {object} sizes Sizes in CSS pixels (or any consistent unit).
 * @param {number} sizes.contentWidth Logical plate width (e.g. Prompt canvas W).
 * @param {number} sizes.contentHeight Logical plate height (e.g. Prompt canvas H).
 * @param {number} sizes.containerWidth Host pane width.
 * @param {number} sizes.containerHeight Host pane height.
 * @returns {{width: number, height: number}} Display size of the plate inside the host.
 */
export function fitPlateInBox(sizes = {}) {
  const contentWidth = positive(sizes.contentWidth, 1);
  const contentHeight = positive(sizes.contentHeight, 1);
  const containerWidth = positive(sizes.containerWidth, 1);
  const containerHeight = positive(sizes.containerHeight, 1);
  const scale = Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
  return {
    width: Math.max(1, Math.floor(contentWidth * scale)),
    height: Math.max(1, Math.floor(contentHeight * scale))
  };
}

/**
 * @param {number} value Value.
 * @param {number} fallback Fallback when not a positive finite number.
 * @returns {number}
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
