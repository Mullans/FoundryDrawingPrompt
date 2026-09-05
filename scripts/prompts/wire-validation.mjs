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
 * Test whether a live snapshot payload is safe (legacy composite string or composite/overlay object).
 * @param {*} value Candidate payload.
 * @returns {boolean} Whether valid.
 */
export function isValidSnapshotPayload(value) {
  if ( typeof value === "string" ) return isValidSnapshotDataUrl(value);
  if ( !value || typeof value !== "object" ) return false;
  const parts = [value.composite, value.overlay].filter(part => part != null);
  if ( !parts.length ) return false;
  if ( !parts.every(part => isValidSnapshotDataUrl(part)) ) return false;
  // Composite and overlay ride one socket message, so they share a single budget.
  return estimateSnapshotPayloadWireBytes(value) <= INTERNAL.MAX_SNAPSHOT_WIRE_BYTES;
}

/**
 * Normalize a live snapshot payload into composite (Prompt canvas) and overlay (ink-only) URLs.
 * Legacy string payloads are treated as composite only.
 * @param {string|{composite?: string, overlay?: string}|null|undefined} payload Snapshot payload.
 * @returns {{composite: string|null, overlay: string|null}}
 */
export function normalizeSnapshotPayload(payload) {
  if ( typeof payload === "string" ) {
    return { composite: payload, overlay: null };
  }
  if ( payload && typeof payload === "object" ) {
    return {
      composite: typeof payload.composite === "string" ? payload.composite : null,
      overlay: typeof payload.overlay === "string" ? payload.overlay : null
    };
  }
  return { composite: null, overlay: null };
}

/**
 * Estimate the combined wire bytes of a live snapshot payload.
 * @param {string|{composite?: string, overlay?: string}|null|undefined} payload Snapshot payload.
 * @returns {number} Estimated bytes.
 */
export function estimateSnapshotPayloadWireBytes(payload) {
  const { composite, overlay } = normalizeSnapshotPayload(payload);
  return (composite?.length ?? 0) + (overlay?.length ?? 0);
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
 * @param {{forge?: boolean, expectedKind?: "overlay"|"merged"|null}} [options] Runtime and optional role context.
 * @returns {boolean} Whether allowed.
 */
export function isAllowedStagedPath(assignmentId, path, stagingRoot, { forge = false, expectedKind = null } = {}) {
  const normalized = allowedPathCandidate(path, { forge });
  const root = normalizePath(String(stagingRoot ?? ""));
  if ( !root || !normalized || !normalized.startsWith(`${root}/`) ) return false;
  const basename = normalized.slice(root.length + 1);
  const kind = expectedKind === "overlay" || expectedKind === "merged" ? expectedKind : "(overlay|merged)";
  return new RegExp(`^${escapeRegex(String(assignmentId))}-${kind}\\.(webp|png)$`).test(basename);
}

/**
 * Test whether GM-persisted pending paths are under the assignment pending root.
 * @param {string} assignmentId Assignment id.
 * @param {string} path Asset path.
 * @param {string} pendingRoot Normalized pending directory for the assignment.
 * @param {{forge?: boolean, expectedKind?: "overlay"|"merged"|null}} [options] Runtime and optional role context.
 * @returns {boolean} Whether allowed.
 */
export function isAllowedPendingPath(assignmentId, path, pendingRoot, { forge = false, expectedKind = null } = {}) {
  const normalized = allowedPathCandidate(path, { forge });
  const root = normalizePath(String(pendingRoot ?? ""));
  if ( !root || !normalized || !normalized.startsWith(`${root}/`) ) return false;
  const basename = normalized.slice(root.length + 1);
  const kind = expectedKind === "overlay" || expectedKind === "merged" ? expectedKind : "(overlay|merged)";
  return new RegExp(`^${kind}\\.(webp|png)$`).test(basename);
}

/**
 * Convert an allowed local or Forge upload response into a provider-relative path.
 * Forge asset URLs contain one opaque account path segment before the provider path.
 * @param {*} path Candidate path.
 * @param {{forge?: boolean}} options Runtime context.
 * @returns {string|null} Comparable provider path, or null when unsafe.
 */
function allowedPathCandidate(path, { forge = false } = {}) {
  const raw = String(path ?? "");
  if ( !forge ) return normalizePath(raw);
  if ( /\\|%(?:2e|2f|5c)/i.test(raw) ) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_err) {
    return null;
  }
  if ( url.protocol !== "https:" || url.origin !== "https://assets.forge-vtt.com" ) return null;
  if ( url.username || url.password || url.search || url.hash ) return null;
  const rawSegments = url.pathname.slice(1).split("/");
  if ( rawSegments.some(segment => !segment) ) return null;
  let segments;
  try {
    segments = rawSegments.map(segment => decodeURIComponent(segment));
  } catch (_err) {
    return null;
  }
  if ( segments.length < 2 || segments.some(segment => !segment || segment === "." || segment === ".." || /[\\/]/.test(segment)) ) return null;
  segments.shift();
  return segments.join("/");
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} value Raw string.
 * @returns {string} Escaped string.
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
