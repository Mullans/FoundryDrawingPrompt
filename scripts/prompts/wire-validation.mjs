import { INTERNAL } from "../constants.mjs";
import { normalizePath } from "./asset-service.mjs";

const IMAGE_DATA_URL_RE = /^data:image\/(webp|png);base64,/i;

/**
 * Test whether a value is a valid image data URL for wire transport.
 * @param {*} value Candidate data URL.
 * @param {{maxBytes?: number}} [options] Validation options.
 * @returns {boolean} Whether valid.
 */
export function isValidImageDataUrl(value, { maxBytes = INTERNAL.MAX_SUBMISSION_BYTES } = {}) {
  if ( typeof value !== "string" || !IMAGE_DATA_URL_RE.test(value) ) return false;
  return estimateDataUrlWireBytes(value) <= maxBytes;
}

/**
 * Test whether a snapshot data URL is safe to accept on the GM client.
 * @param {*} value Candidate snapshot data URL.
 * @returns {boolean} Whether valid.
 */
export function isValidSnapshotDataUrl(value) {
  if ( typeof value !== "string" || !IMAGE_DATA_URL_RE.test(value) ) return false;
  return value.length <= INTERNAL.MAX_SNAPSHOT_WIRE_BYTES;
}

/**
 * Estimate wire bytes for a data URL using string length as a base64 proxy.
 * @param {string} dataUrl Data URL.
 * @returns {number} Estimated bytes.
 */
export function estimateDataUrlWireBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(",");
  if ( comma < 0 ) return String(dataUrl).length;
  const base64 = String(dataUrl).slice(comma + 1);
  return Math.ceil(base64.length * 0.75);
}

/**
 * Estimate serialized op-log wire bytes.
 * @param {*} opLog Operation log payload.
 * @returns {number} Estimated bytes.
 */
export function estimateOpLogWireBytes(opLog) {
  if ( opLog === undefined || opLog === null ) return 0;
  try {
    return JSON.stringify(opLog).length;
  } catch (_err) {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Test whether staged overlay/merged paths are under the staging root and match the assignment.
 * @param {string} assignmentId Assignment id.
 * @param {string} path Asset path.
 * @param {string} stagingRoot Normalized staging directory.
 * @returns {boolean} Whether allowed.
 */
export function isAllowedStagedPath(assignmentId, path, stagingRoot) {
  const normalized = normalizePath(String(path ?? ""));
  const root = normalizePath(String(stagingRoot ?? ""));
  if ( !root || !normalized.startsWith(`${root}/`) ) return false;
  const basename = normalized.slice(root.length + 1);
  return new RegExp(`^${escapeRegex(String(assignmentId))}-(overlay|merged)\\.(webp|png)$`).test(basename);
}

/**
 * Test whether GM-persisted pending paths are under the assignment pending root.
 * @param {string} assignmentId Assignment id.
 * @param {string} path Asset path.
 * @param {string} pendingRoot Normalized pending directory for the assignment.
 * @returns {boolean} Whether allowed.
 */
export function isAllowedPendingPath(assignmentId, path, pendingRoot) {
  const normalized = normalizePath(String(path ?? ""));
  const root = normalizePath(String(pendingRoot ?? ""));
  if ( !root || !normalized.startsWith(`${root}/`) ) return false;
  const basename = normalized.slice(root.length + 1);
  return /^(overlay|merged)\.(webp|png)$/.test(basename);
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} value Raw string.
 * @returns {string} Escaped string.
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
