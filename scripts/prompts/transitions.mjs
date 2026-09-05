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
 * Decide whether the GM manager's placement actions are unlocked for an assignment: the GM
 * must have saved the assignment's *current* submission. A later resubmission re-arms the
 * gate automatically because the new submission's timestamp exceeds the previously recorded
 * saved-submission timestamp, without any explicit re-locking step.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {boolean} Whether the save gate is open (placement unlocked).
 */
export function isSaveGateOpen(assignment) {
  if ( assignment?.status !== STATUS.SUBMITTED ) return false;
  if ( !Number.isFinite(assignment.savedSubmissionTs) ) return false;
  return assignment.savedSubmissionTs >= assignment.submittedAt;
}

/**
 * Validate a drawing submission payload without touching Foundry globals.
 * @param {object} payload Submission payload.
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string}} [options] Context for path allowlists.
 * @returns {boolean} Whether the payload is valid.
 */
export function isValidSubmissionPayload(payload, options = {}) {
  return validateSubmissionPayload(payload, options).ok;
}

/**
 * Validate a drawing submission payload and explain the failed validation layer.
 * @param {object} payload Submission payload.
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string, forge?: boolean}} [options] Context for path allowlists.
 * @returns {{ok: true}|{ok: false, reason: "shape"|"path-allowlist"|"path-context", detail: string}}
 */
export function validateSubmissionPayload(payload, options = {}) {
  if ( !isPlainObject(payload) ) return invalidShape("submission must be an object");
  if ( payload.mode === "staged" ) {
    if ( !isValidStagedSubmissionShape(payload) ) return invalidShape("staged submission fields, formats, dimensions, or operation log are malformed");
    const pathFailure = stagedPathFailure(payload, options);
    return pathFailure ?? { ok: true };
  }
  if ( payload.mode !== undefined ) return invalidShape(`unknown submission mode ${String(payload.mode)}`);
  return isValidSocketSubmissionPayload(payload)
    ? { ok: true }
    : invalidShape("socket submission image data, dimensions, or operation log are malformed");
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
 * @returns {boolean} Whether valid.
 */
function isValidStagedSubmissionShape(payload) {
  if ( !isPlainObject(payload.staged) ) return false;
  if ( !nonEmptyString(payload.staged.overlayPath) ) return false;
  if ( payload.staged.mergedPath !== null && payload.staged.mergedPath !== undefined && !nonEmptyString(payload.staged.mergedPath) ) return false;
  if ( !isPlainObject(payload.formats) || !nonEmptyString(payload.formats.overlay) ) return false;
  if ( payload.formats.merged !== null && payload.formats.merged !== undefined && !nonEmptyString(payload.formats.merged) ) return false;
  if ( !isValidDimensions(payload) ) return false;
  if ( payload.opLog !== undefined && !isValidOpLog(payload.opLog) ) return false;
  return true;
}

/**
 * Validate staged asset paths against assignment-scoped allowlists.
 *
 * Fails closed when the allowlist context is missing: staged paths are player-supplied, this is
 * the only gate that checks them (Save-time persistence trusts `submission.staged.*`), so an
 * unresolvable allowlist must reject rather than wave the paths through (SCR-52).
 * @param {object} payload Submission payload.
 * @param {{assignmentId?: string, stagingRoot?: string, pendingRoot?: string}} options Path allowlist context.
 * @returns {{ok: false, reason: "path-allowlist"|"path-context", detail: string}|null} Path failure, or null when paths are allowed.
 */
function stagedPathFailure(payload, options) {
  const { assignmentId, stagingRoot, pendingRoot } = options;
  if ( !assignmentId || (!stagingRoot && !pendingRoot) ) {
    const missing = [!assignmentId && "assignmentId", (!stagingRoot && !pendingRoot) && "stagingRoot or pendingRoot"]
      .filter(Boolean).join(" and ");
    return { ok: false, reason: "path-context", detail: `staged path allowlist context is unavailable; missing ${missing}` };
  }
  const fields = [
    ["overlayPath", "overlay", payload.staged.overlayPath],
    ["mergedPath", "merged", payload.staged.mergedPath]
  ];
  for ( const [field, kind, path] of fields ) {
    if ( !path ) continue;
    if ( isAllowedSubmissionPath(assignmentId, path, stagingRoot, pendingRoot, { ...options, expectedKind: kind }) ) continue;
    const expected = [stagingRoot && `${stagingRoot}/${assignmentId}-${kind}.(webp|png)`, pendingRoot && `${pendingRoot}/${kind}.(webp|png)`]
      .filter(Boolean).join(" or ");
    return { ok: false, reason: "path-allowlist", detail: `${field} path ${path} does not match expected ${expected}` };
  }
  return null;
}

/**
 * Test whether a staged asset path is under staging or pending roots.
 * @param {string} assignmentId Assignment id.
 * @param {string} path Asset path.
 * @param {string|undefined} stagingRoot Staging root.
 * @param {string|undefined} pendingRoot Pending root.
 * @returns {boolean} Whether allowed.
 */
function isAllowedSubmissionPath(assignmentId, path, stagingRoot, pendingRoot, options) {
  if ( stagingRoot && isAllowedStagedPath(assignmentId, path, stagingRoot, options) ) return true;
  if ( pendingRoot && isAllowedPendingPath(assignmentId, path, pendingRoot, options) ) return true;
  return false;
}

function invalidShape(detail) {
  return { ok: false, reason: "shape", detail };
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
