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
 * Test whether an assignment is still player-active.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @returns {boolean} Whether active.
 */
function isActive(assignment) {
  return ACTIVE_STATUSES.includes(assignment?.status);
}
