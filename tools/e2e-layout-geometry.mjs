/**
 * Pure geometry helpers for Foundry e2e layout coherence checks.
 * Bounding boxes are { x, y, width, height } in viewport CSS pixels (getBoundingClientRect).
 */

/**
 * @typedef {{x: number, y: number, width: number, height: number}} DomRectBox
 */

/**
 * Whether `inner` lies entirely inside `outer` (with optional pixel slack).
 * @param {DomRectBox|null|undefined} inner
 * @param {DomRectBox|null|undefined} outer
 * @param {{tolerance?: number}} [options]
 * @returns {boolean}
 */
export function isRectContainedIn(inner, outer, { tolerance = 1 } = {}) {
  if ( !isFiniteRect(inner) || !isFiniteRect(outer) ) return false;
  const t = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  return inner.x >= outer.x - t
    && inner.y >= outer.y - t
    && inner.x + inner.width <= outer.x + outer.width + t
    && inner.y + inner.height <= outer.y + outer.height + t;
}

/**
 * Whether two axis-aligned boxes overlap by more than `minOverlap` px on both axes.
 * @param {DomRectBox|null|undefined} a
 * @param {DomRectBox|null|undefined} b
 * @param {{minOverlap?: number}} [options]
 * @returns {boolean}
 */
export function doRectsOverlap(a, b, { minOverlap = 1 } = {}) {
  if ( !isFiniteRect(a) || !isFiniteRect(b) ) return false;
  const min = Number.isFinite(minOverlap) ? Math.max(0, minOverlap) : 0;
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > min && overlapY > min;
}

/**
 * Compose-mode manager: dimensions fields stay in the form column; form/preview do not overlap.
 * @param {{
 *   managerMain?: DomRectBox|null,
 *   dimensionsFields?: DomRectBox|null,
 *   previewPanel?: DomRectBox|null,
 *   widthInput?: DomRectBox|null,
 *   heightInput?: DomRectBox|null
 * }} boxes
 * @returns {string[]} Human-readable failure messages (empty = pass).
 */
export function collectComposeManagerLayoutFailures(boxes = {}) {
  const failures = [];
  const {
    managerMain,
    dimensionsFields,
    previewPanel,
    widthInput,
    heightInput
  } = boxes;

  if ( !isFiniteRect(managerMain) ) failures.push("compose: .dp-manager-main missing or zero-sized");
  if ( !isFiniteRect(dimensionsFields) ) failures.push("compose: dimensions .form-fields missing or zero-sized");
  if ( !isFiniteRect(previewPanel) ) failures.push("compose: .dp-preview-panel missing or zero-sized");

  if ( isFiniteRect(managerMain) && isFiniteRect(dimensionsFields)
    && !isRectContainedIn(dimensionsFields, managerMain) ) {
    failures.push("compose: dimensions .form-fields overflow .dp-manager-main");
  }
  if ( isFiniteRect(managerMain) && isFiniteRect(widthInput)
    && !isRectContainedIn(widthInput, managerMain) ) {
    failures.push("compose: canvasWidth input overflows .dp-manager-main");
  }
  if ( isFiniteRect(managerMain) && isFiniteRect(heightInput)
    && !isRectContainedIn(heightInput, managerMain) ) {
    failures.push("compose: canvasHeight input overflows .dp-manager-main");
  }
  if ( isFiniteRect(dimensionsFields) && isFiniteRect(previewPanel)
    && doRectsOverlap(dimensionsFields, previewPanel) ) {
    failures.push("compose: dimensions .form-fields overlaps .dp-preview-panel");
  }
  if ( isFiniteRect(managerMain) && isFiniteRect(previewPanel)
    && doRectsOverlap(managerMain, previewPanel, { minOverlap: 4 }) ) {
    failures.push("compose: .dp-manager-main overlaps .dp-preview-panel");
  }
  return failures;
}

/**
 * Live/review manager: player list and preview stay in their columns without overlapping.
 * @param {{
 *   playersFieldset?: DomRectBox|null,
 *   previewPanel?: DomRectBox|null,
 *   summaryBar?: DomRectBox|null,
 *   timerBlock?: DomRectBox|null
 * }} boxes
 * @returns {string[]}
 */
export function collectReviewManagerLayoutFailures(boxes = {}) {
  const failures = [];
  const { playersFieldset, previewPanel, summaryBar, timerBlock } = boxes;

  if ( !isFiniteRect(playersFieldset) ) failures.push("review: .dp-players-fieldset missing or zero-sized");
  if ( !isFiniteRect(previewPanel) ) failures.push("review: .dp-preview-panel missing or zero-sized");

  if ( isFiniteRect(playersFieldset) && isFiniteRect(previewPanel)
    && doRectsOverlap(playersFieldset, previewPanel, { minOverlap: 4 }) ) {
    failures.push("review: players column overlaps .dp-preview-panel");
  }
  if ( isFiniteRect(summaryBar) && isFiniteRect(timerBlock)
    && !isRectContainedIn(timerBlock, summaryBar) ) {
    failures.push("review: .dp-timer-block overflows .dp-summary-bar");
  }
  return failures;
}

/**
 * @param {DomRectBox|null|undefined} box
 * @returns {boolean}
 */
function isFiniteRect(box) {
  return Boolean(box)
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0;
}
