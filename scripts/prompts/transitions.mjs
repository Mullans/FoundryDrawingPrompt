import { INTERNAL, STATUS } from "../constants.mjs";
import {
  estimateDataUrlWireBytes,
  estimateOpLogWireBytes,
  isAllowedPendingPath,
  isAllowedStagedPath,
  isValidImageDataUrl
} from "./wire-validation.mjs";

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
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string}} [options] Context for path allowlists.
 * @returns {boolean} Whether the payload is valid.
 */
export function isValidSubmissionPayload(payload, options = {}) {
  if ( !isPlainObject(payload) ) return false;
  if ( payload.mode === "staged" ) return isValidStagedSubmissionPayload(payload, options);
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
  if ( !isValidImageDataUrl(payload.overlay.dataUrl) ) return false;
  if ( payload.merged !== undefined ) {
    if ( !isImageDataPayload(payload.merged) ) return false;
    if ( !isValidImageDataUrl(payload.merged.dataUrl) ) return false;
  }
  if ( !isValidDimensions(payload) ) return false;
  if ( payload.opLog !== undefined && !isValidOpLog(payload.opLog) ) return false;
  return true;
}

/**
 * Validate a staged submission shape.
 * @param {object} payload Submission payload.
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string}} options Path allowlist context.
 * @returns {boolean} Whether valid.
 */
function isValidStagedSubmissionPayload(payload, options) {
  if ( !isPlainObject(payload.staged) ) return false;
  if ( !nonEmptyString(payload.staged.overlayPath) ) return false;
  if ( payload.staged.mergedPath !== null && payload.staged.mergedPath !== undefined && !nonEmptyString(payload.staged.mergedPath) ) return false;
  if ( !isPlainObject(payload.formats) || !nonEmptyString(payload.formats.overlay) ) return false;
  if ( payload.formats.merged !== null && payload.formats.merged !== undefined && !nonEmptyString(payload.formats.merged) ) return false;
  if ( !isValidDimensions(payload) ) return false;
  if ( payload.opLog !== undefined && !isValidOpLog(payload.opLog) ) return false;
  return isAllowedStagedSubmissionPaths(payload, options);
}

/**
 * Validate staged asset paths against assignment-scoped allowlists.
 * @param {object} payload Submission payload.
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string}} options Path allowlist context.
 * @returns {boolean} Whether paths are allowed.
 */
function isAllowedStagedSubmissionPaths(payload, options) {
  const { assignmentId, stagingRoot, pendingRoot } = options;
  if ( !assignmentId || (!stagingRoot && !pendingRoot) ) return true;
  const overlayAllowed = isAllowedSubmissionPath(assignmentId, payload.staged.overlayPath, stagingRoot, pendingRoot);
  if ( !overlayAllowed ) return false;
  if ( payload.staged.mergedPath ) {
    return isAllowedSubmissionPath(assignmentId, payload.staged.mergedPath, stagingRoot, pendingRoot);
  }
  return true;
}

/**
 * Test whether a staged asset path is under staging or pending roots.
 * @param {string} assignmentId Assignment id.
 * @param {string} path Asset path.
 * @param {string|undefined} stagingRoot Staging root.
 * @param {string|undefined} pendingRoot Pending root.
 * @returns {boolean} Whether allowed.
 */
function isAllowedSubmissionPath(assignmentId, path, stagingRoot, pendingRoot) {
  if ( stagingRoot && isAllowedStagedPath(assignmentId, path, stagingRoot) ) return true;
  if ( pendingRoot && isAllowedPendingPath(assignmentId, path, pendingRoot) ) return true;
  return false;
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
  const width = Number(payload.width);
  const height = Number(payload.height);
  return Number.isFinite(width) && width > 0 && width <= INTERNAL.MAX_CANVAS_DIM
    && Number.isFinite(height) && height > 0 && height <= INTERNAL.MAX_CANVAS_DIM;
}

/**
 * Test operation log size and shape.
 * @param {*} opLog Operation log payload.
 * @returns {boolean} Whether valid.
 */
function isValidOpLog(opLog) {
  if ( !isPlainObject(opLog) ) return false;
  return estimateOpLogWireBytes(opLog) <= INTERNAL.MAX_OPLOG_BYTES;
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
