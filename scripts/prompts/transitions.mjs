import { STATUS } from "../constants.mjs";

const ACTIVE_STATUSES = Object.freeze([STATUS.PENDING, STATUS.OPENED]);

/**
 * Decide whether an opened event should apply to an assignment.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{apply: boolean, reason?: string}} Transition decision.
 */
export function evaluateOpened(assignment) {
  return isActive(assignment) ? { apply: true } : { apply: false, reason: "inactive" };
}

/**
 * Decide whether a submission event should apply to an assignment.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{apply: boolean, reason?: string}} Transition decision.
 */
export function evaluateSubmission(assignment) {
  if ( assignment?.status === STATUS.SUBMITTED ) return { apply: false, reason: "duplicate" };
  return isActive(assignment) ? { apply: true } : { apply: false, reason: "inactive" };
}

/**
 * Decide whether a rejection event should apply to an assignment.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{apply: boolean, reason?: string}} Transition decision.
 */
export function evaluateRejection(assignment) {
  return isActive(assignment) ? { apply: true } : { apply: false, reason: "inactive" };
}

/**
 * Decide whether a live snapshot should update the GM preview.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {{apply: boolean, reason?: string}} Transition decision.
 */
export function evaluateSnapshot(assignment) {
  return isActive(assignment) ? { apply: true } : { apply: false, reason: "inactive" };
}

/**
 * Validate a drawing submission payload without touching Foundry globals.
 * @param {object} payload Submission payload.
 * @returns {boolean} Whether the payload is valid.
 */
export function isValidSubmissionPayload(payload) {
  if ( !isPlainObject(payload) ) return false;
  if ( payload.mode === "staged" ) return isValidStagedSubmissionPayload(payload);
  if ( payload.mode !== undefined ) return false;
  return isValidSocketSubmissionPayload(payload);
}

/**
 * Test whether an assignment is still player-active.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {boolean} Whether active.
 */
function isActive(assignment) {
  return ACTIVE_STATUSES.includes(assignment?.status);
}

/**
 * Validate the current socket-lane submission shape.
 * @param {object} payload Submission payload.
 * @returns {boolean} Whether valid.
 */
function isValidSocketSubmissionPayload(payload) {
  if ( !isImageDataPayload(payload.overlay) ) return false;
  if ( payload.merged !== undefined && !isImageDataPayload(payload.merged) ) return false;
  if ( !isValidDimensions(payload) ) return false;
  return payload.opLog === undefined || isPlainObject(payload.opLog);
}

/**
 * Validate a staged submission shape.
 * @param {object} payload Submission payload.
 * @returns {boolean} Whether valid.
 */
function isValidStagedSubmissionPayload(payload) {
  if ( !isPlainObject(payload.staged) ) return false;
  if ( !nonEmptyString(payload.staged.overlayPath) ) return false;
  if ( payload.staged.mergedPath !== null && payload.staged.mergedPath !== undefined && !nonEmptyString(payload.staged.mergedPath) ) return false;
  if ( !isPlainObject(payload.formats) || !nonEmptyString(payload.formats.overlay) ) return false;
  if ( payload.formats.merged !== null && payload.formats.merged !== undefined && !nonEmptyString(payload.formats.merged) ) return false;
  if ( !isValidDimensions(payload) ) return false;
  return payload.opLog === undefined || isPlainObject(payload.opLog);
}

/**
 * Test image data payload shape.
 * @param {object} image Image payload.
 * @returns {boolean} Whether valid.
 */
function isImageDataPayload(image) {
  return isPlainObject(image) && nonEmptyString(image.dataUrl) && nonEmptyString(image.format);
}

/**
 * Test width and height shape.
 * @param {object} payload Payload.
 * @returns {boolean} Whether valid.
 */
function isValidDimensions(payload) {
  return Number.isFinite(Number(payload.width)) && Number(payload.width) > 0
    && Number.isFinite(Number(payload.height)) && Number(payload.height) > 0;
}

/**
 * Test plain object shape.
 * @param {*} value Value.
 * @returns {boolean} Whether value is a plain object.
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Test non-empty string shape.
 * @param {*} value Value.
 * @returns {boolean} Whether value is a non-empty string.
 */
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
