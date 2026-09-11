/**
 * Pending Submission store — in-memory map, sessionStorage cache, and
 * restoration payloads built from saved Framing View assets.
 */

import { MODULE_ID } from "../constants.mjs";
import { isForge } from "../foundry/path-provider.mjs";
import { ensureDir, pendingDir, stagingDir, uploadDataUrl } from "./asset-service.mjs";
import { isStagedSubmission } from "./assignment-save.mjs";
import { getAssignment } from "./prompt-context.mjs";

const pendingSubmissions = new Map();
const SUBMISSION_KEY_PREFIX = "drawing-prompts.sub.";
const SUBMISSION_INDEX_KEY = "drawing-prompts.sub.index";
const SUBMISSION_CACHE_LIMIT = 8 * 1024 * 1024;

/**
 * Get a pending in-memory submission payload.
 * @param {string} assignmentId Assignment id.
 * @returns {object|null}
 */
export function getPendingSubmission(assignmentId) {
  const submission = peekMemoryOrCachedSubmission(assignmentId);
  if ( submission ) return submission;
  const assignment = getAssignment(assignmentId);
  if ( assignment?.pendingSubmission ) {
    pendingSubmissions.set(assignmentId, assignment.pendingSubmission);
    return assignment.pendingSubmission;
  }
  return null;
}

/**
 * Resolve pending payload from the in-memory map or session cache only
 * (used by Save — does not fall back to JournalEntry pendingSubmission).
 * @param {string} assignmentId Assignment id.
 * @returns {object|null}
 */
export function peekMemoryOrCachedSubmission(assignmentId) {
  const submission = pendingSubmissions.get(assignmentId) ?? readCachedSubmission(assignmentId);
  if ( submission && !pendingSubmissions.has(assignmentId) ) pendingSubmissions.set(assignmentId, submission);
  return submission ?? null;
}

/**
 * Store a pending submission in memory and session cache.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Submission payload.
 * @returns {void}
 */
export function setPendingSubmission(assignmentId, submission) {
  pendingSubmissions.set(assignmentId, submission);
  cacheSubmission(assignmentId, submission);
}

/**
 * Drop one pending submission from memory and session cache.
 * @param {string} assignmentId Assignment id.
 * @returns {void}
 */
export function clearPendingSubmission(assignmentId) {
  pendingSubmissions.delete(assignmentId);
  clearCachedSubmission(assignmentId);
}

/**
 * Resolve a submission payload that can restore the player's last drawing on reopen.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<object|null>}
 */
export async function resolveRestorationSubmission(assignment, prompt) {
  const pending = getPendingSubmission(assignment.id);
  const saved = await buildRestorationSubmissionFromSavedAssets(assignment, prompt);
  const pendingCandidate = pending ? {
    ...withoutOperationLog(pending),
    recoveryKind: "full-submission",
    assignmentId: assignment.id,
    receiptTs: pending.receiptTs ?? assignment.submittedAt ?? Date.now()
  } : null;
  return [pendingCandidate, saved]
    .filter(candidate => candidate
      && Number(candidate.width) === Number(prompt.canvasWidth)
      && Number(candidate.height) === Number(prompt.canvasHeight)
      && !candidate.wireScaled
      && (candidate.overlay?.dataUrl || candidate.staged?.overlayPath))
    .sort((a, b) => Number(b.receiptTs ?? 0) - Number(a.receiptTs ?? 0))[0] ?? null;
}

/**
 * Build a staged restoration payload from saved assignment assets (post-Save reopen).
 * Uses path-only overlay references — no base64 in the JournalEntry flag.
 * @param {import("./prompt-models.mjs").DrawingAssignment} assignment Assignment.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {Promise<object|null>}
 */
export async function buildRestorationSubmissionFromSavedAssets(assignment, prompt) {
  const overlayPath = assignment.assets?.overlayPath;
  const mergedPath = assignment.assets?.mergedPath ?? null;
  if ( !overlayPath ) return null;
  try {
    const overlayFormat = formatFromAssetPath(overlayPath);
    const mergedFormat = mergedPath ? formatFromAssetPath(mergedPath) : null;
    return {
      recoveryKind: "full-submission",
      assignmentId: assignment.id,
      mode: "staged",
      staged: {
        overlayPath,
        mergedPath
      },
      formats: {
        overlay: overlayFormat,
        merged: mergedFormat
      },
      width: Number(assignment.assets?.tileWidth ?? prompt.canvasWidth),
      height: Number(assignment.assets?.tileHeight ?? prompt.canvasHeight),
      receiptTs: assignment.submittedAt ?? Date.now()
    };
  } catch (err) {
    console.warn(`${MODULE_ID} | could not build restoration payload from saved assets`, assignment.id, err);
    return null;
  }
}

/** GM-held operation logs are deliberately excluded from player Recovery payloads. */
function withoutOperationLog(submission) {
  const { opLog: _opLog, ...imageOnly } = submission;
  return imageOnly;
}

/**
 * Infer an image format from a saved asset path extension.
 * @param {string} path Asset path.
 * @returns {"png"|"jpeg"|"webp"}
 */
export function formatFromAssetPath(path) {
  const ext = String(path ?? "").split(".").pop()?.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if ( ext === "png" ) return "png";
  if ( ext === "jpg" || ext === "jpeg" ) return "jpeg";
  return "webp";
}

/**
 * Fetch a world asset JSON file.
 * @param {string} path Asset path.
 * @returns {Promise<object>}
 */
/**
 * Cache a pending submission in sessionStorage for same-session GM reloads.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Submission payload.
 * @returns {void}
 */
export function cacheSubmission(assignmentId, submission) {
  if ( !game.user.isGM || !globalThis.sessionStorage ) return;
  try {
    const serialized = JSON.stringify(submission);
    sessionStorage.setItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`, serialized);
    const index = readSubmissionIndex();
    index[assignmentId] = { ts: Date.now(), size: serialized.length };
    writeSubmissionIndex(index);
    evictSubmissionCache(index);
  } catch (err) {
    if ( err?.name === "QuotaExceededError" ) {
      ui.notifications.warn(game.i18n.localize("DRAWING-PROMPTS.errors.submissionCacheQuota"));
    }
  }
}

/**
 * Read a cached submission payload.
 * @param {string} assignmentId Assignment id.
 * @returns {object|null} Cached submission or null.
 */
export function readCachedSubmission(assignmentId) {
  if ( !globalThis.sessionStorage ) return null;
  try {
    const serialized = sessionStorage.getItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    if ( !serialized ) return null;
    return JSON.parse(serialized);
  } catch (_err) {
    clearCachedSubmission(assignmentId);
    return null;
  }
}

/**
 * Clear one cached submission.
 * @param {string} assignmentId Assignment id.
 * @returns {void}
 */
export function clearCachedSubmission(assignmentId) {
  if ( !globalThis.sessionStorage ) return;
  try {
    sessionStorage.removeItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    const index = readSubmissionIndex();
    delete index[assignmentId];
    writeSubmissionIndex(index);
  } catch (_err) {
    // Ignore storage failures.
  }
}

/**
 * Read submission cache index.
 * @returns {Record<string, {ts: number, size: number}>} Cache index.
 */
function readSubmissionIndex() {
  try {
    return JSON.parse(sessionStorage.getItem(SUBMISSION_INDEX_KEY) || "{}");
  } catch (_err) {
    return {};
  }
}

/**
 * Write submission cache index.
 * @param {Record<string, {ts: number, size: number}>} index Cache index.
 * @returns {void}
 */
function writeSubmissionIndex(index) {
  try {
    sessionStorage.setItem(SUBMISSION_INDEX_KEY, JSON.stringify(index));
  } catch (_err) {
    // Ignore storage failures.
  }
}

/**
 * Evict old cached submissions when the coarse quota is exceeded.
 * @param {Record<string, {ts: number, size: number}>} index Cache index.
 * @returns {void}
 */
function evictSubmissionCache(index) {
  let total = Object.values(index).reduce((sum, item) => sum + Number(item.size || 0), 0);
  const protectedIds = new Set(
    [...pendingSubmissions.keys()].filter(assignmentId => {
      const submission = pendingSubmissions.get(assignmentId);
      return submission && !submissionPersistedOnDisk(submission);
    })
  );
  const entries = Object.entries(index).sort((a, b) => Number(a[1].ts || 0) - Number(b[1].ts || 0));
  for ( const [assignmentId, item] of entries ) {
    if ( total <= SUBMISSION_CACHE_LIMIT ) break;
    if ( protectedIds.has(assignmentId) ) continue;
    sessionStorage.removeItem(`${SUBMISSION_KEY_PREFIX}${assignmentId}`);
    total -= Number(item.size || 0);
    delete index[assignmentId];
  }
  writeSubmissionIndex(index);
}

/**
 * Build validation context for inbound submission payloads.
 * @param {string} assignmentId Assignment id.
 * @returns {{assignmentId: string, stagingRoot: string, pendingRoot: string, forge: boolean}}
 */
export function submissionValidationContext(assignmentId) {
  return {
    assignmentId,
    stagingRoot: stagingDir(),
    pendingRoot: pendingDir(assignmentId),
    forge: isForge()
  };
}

/**
 * Persist a socket-lane submission to the GM pending folder and rewrite as staged paths.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Socket submission payload.
 * @returns {Promise<object>} Staged-shaped persisted submission.
 */
export async function persistSocketSubmission(assignmentId, submission) {
  const dir = pendingDir(assignmentId);
  await ensureDir(dir);
  const hasMerged = Boolean(submission.merged?.dataUrl);
  const overlayExt = extensionFor(submission.overlay?.format);
  const overlay = await uploadDataUrl(dir, `overlay.${overlayExt}`, submission.overlay.dataUrl);
  let merged = null;
  if ( hasMerged ) {
    merged = await uploadDataUrl(dir, `merged.${extensionFor(submission.merged.format)}`, submission.merged.dataUrl);
  }
  return {
    mode: "staged",
    staged: {
      overlayPath: overlay.path,
      mergedPath: merged?.path ?? null
    },
    formats: {
      overlay: submission.overlay?.format ?? "webp",
      merged: hasMerged ? submission.merged?.format ?? "webp" : null
    },
    opLog: submission.opLog,
    width: submission.width,
    height: submission.height,
    originalWidth: submission.originalWidth,
    originalHeight: submission.originalHeight,
    wireScaled: submission.wireScaled,
    opLogTruncated: submission.opLogTruncated,
    receiptTs: submission.receiptTs
  };
}

/**
 * Test whether a submission is already persisted on the server data source.
 * @param {object} submission Submission payload.
 * @returns {boolean} Whether persisted on disk.
 */
function submissionPersistedOnDisk(submission) {
  return isStagedSubmission(submission);
}

/**
 * Resolve a preview image source for a pending submission.
 * @param {object} submission Submission payload.
 * @returns {string|null} Preview source.
 */
export function submissionPreviewSrc(submission) {
  if ( isStagedSubmission(submission) ) {
    const path = submission.staged?.mergedPath ?? submission.staged?.overlayPath;
    return path ? cacheBustedAssetSrc(path, submission.receiptTs) : null;
  }
  return submission?.merged?.dataUrl ?? submission?.overlay?.dataUrl ?? null;
}

/**
 * Add a cache-buster query to an image asset source.
 * @param {string} path Asset path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {string} Image source.
 */
function cacheBustedAssetSrc(path, receiptTs) {
  return `${encodeURI(path)}?ts=${encodeURIComponent(String(receiptTs ?? Date.now()))}`;
}

/**
 * Convert an exported format to a file extension.
 * @param {string} format Export format.
 * @returns {string}
 */
function extensionFor(format) {
  return format === "png" ? "png" : "webp";
}
