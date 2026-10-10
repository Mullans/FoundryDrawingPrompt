import { FILES_UPLOAD_PERMISSION, MODULE_ID, SETTINGS } from "../constants.mjs";
import {
  buildPendingPath,
  buildStagingPath,
  createPathProvider,
  isForge,
  normalizePath
} from "../foundry/path-provider.mjs";
import { assertGM } from "./socket-auth.mjs";

export { normalizePath } from "../foundry/path-provider.mjs";

/**
 * Get the configured FilePicker implementation. Hosting services such as The
 * Forge substitute their own class here (Assets Library integration), so the
 * raw core class must never be used directly.
 * @returns {typeof foundry.applications.apps.FilePicker}
 */
function getFilePicker() {
  const base = foundry.applications.apps.FilePicker;
  return base.implementation ?? base;
}

/**
 * Build the staging directory below a normalized base asset folder.
 * @param {string} baseFolder Base asset folder.
 * @returns {string} Staging directory.
 */
export function buildStagingDir(baseFolder) {
  return buildStagingPath(baseFolder);
}

/**
 * Get the default flat asset folder.
 * @returns {string}
 */
export function defaultAssetFolder() {
  return runtimePathProvider().base;
}

/**
 * Test whether the current user can use the staged upload lane.
 * @returns {boolean} Whether the current user can upload files.
 */
export function canStageUploads() {
  return Boolean(game.user?.can?.(FILES_UPLOAD_PERMISSION));
}

/**
 * Get the player-side submission staging directory. Upload attempts have unique
 * names so orphan cleanup cannot remove a replacement image at the same path.
 * @returns {string} Staging directory.
 */
export function stagingDir() {
  return runtimePathProvider().staging();
}

/**
 * Build the GM-side pending directory for one assignment's socket-lane submissions.
 * @param {string} baseFolder Base asset folder.
 * @param {string} assignmentId Assignment id.
 * @returns {string} Pending directory.
 */
export function buildPendingDir(baseFolder, assignmentId) {
  return buildPendingPath(baseFolder, assignmentId);
}

/**
 * Get the GM-side pending directory for one assignment.
 * @param {string} assignmentId Assignment id.
 * @returns {string} Pending directory.
 */
export function pendingDir(assignmentId) {
  return runtimePathProvider().pending(assignmentId);
}

/**
 * Create a provider from the current Foundry runtime state.
 * @returns {ReturnType<typeof createPathProvider>}
 */
function runtimePathProvider() {
  return createPathProvider({
    forge: isForge(),
    worldId: game.world.id,
    settingValue: game.settings.get(MODULE_ID, SETTINGS.ASSET_FOLDER)
  });
}

/**
 * Browse existing file paths in a data-source folder.
 * @param {string} dir Target folder.
 * @param {{strict?: boolean}} [options] Require successful discovery, allowing only confirmed missing folders.
 * @returns {Promise<string[]>}
 */
export async function browseFiles(dir, { strict = false } = {}) {
  assertGM();
  try {
    const result = strict ? await browseExistingDirectory(normalizePath(dir))
      : await getFilePicker().browse("data", normalizePath(dir));
    if ( !result ) return [];
    if ( strict && !Array.isArray(result.files) ) throw new Error("Invalid file discovery result");
    return Array.isArray(result?.files) ? result.files : [];
  } catch (err) {
    if ( strict ) throw err;
    return [];
  }
}

/** Prove a failed directory is missing through its parent listing; never swallow a failure for an existing folder. */
async function browseExistingDirectory(dir) {
  try {
    return await getFilePicker().browse("data", dir);
  } catch (err) {
    const separator = dir.lastIndexOf("/");
    if ( !dir ) throw err;
    const parent = await browseExistingDirectory(separator < 0 ? "" : dir.slice(0, separator));
    if ( !parent ) return null;
    if ( !Array.isArray(parent.dirs) || parent.dirs.some(path => normalizePath(path) === dir) ) throw err;
    return null;
  }
}

/**
 * Ensure a data-source directory path exists, creating segments as needed.
 * @param {string} path Directory path in the data source.
 * @returns {Promise<void>}
 */
export async function ensureDir(path) {
  assertGM();
  const picker = getFilePicker();
  const parts = normalizePath(path).split("/").filter(Boolean);
  let current = "";
  for ( const part of parts ) {
    current = current ? `${current}/${part}` : part;
    try {
      await picker.createDirectory("data", current, { notify: false });
    } catch ( err ) {
      console.debug(`${MODULE_ID} | Directory exists or could not be created`, current, err);
    }
  }
}

/**
 * Upload a data URL as a file to the Foundry data source.
 * @param {string} dir Target directory.
 * @param {string} filename Target filename.
 * @param {string} dataUrl Source data URL.
 * @returns {Promise<{path: string}>} Uploaded file path response.
 */
export async function uploadDataUrl(dir, filename, dataUrl) {
  assertGM();
  await ensureDir(dir);
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = new File([blob], filename, { type: blob.type });
  const uploadResponse = await getFilePicker().upload("data", dir, file, {}, { notify: false });
  if ( !uploadResponse?.path ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.uploadFailed"));
  return { path: uploadResponse.path };
}

/**
 * Upload a Blob as a file to the Foundry data source.
 * @param {string} dir Target directory.
 * @param {string} filename Target filename.
 * @param {Blob} blob Source blob.
 * @returns {Promise<{path: string}>} Uploaded file path response.
 */
export async function uploadBlob(dir, filename, blob) {
  assertGM();
  await ensureDir(dir);
  return uploadBlobForCurrentUser(dir, filename, blob);
}

/**
 * Upload JSON data as a file to the Foundry data source.
 * @param {string} dir Target directory.
 * @param {string} filename Target filename.
 * @param {*} data JSON-serializable data.
 * @returns {Promise<{path: string}>} Uploaded file path response.
 */
export async function uploadJson(dir, filename, data) {
  assertGM();
  await ensureDir(dir);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const file = new File([blob], filename, { type: blob.type });
  const uploadResponse = await getFilePicker().upload("data", dir, file, {}, { notify: false });
  if ( !uploadResponse?.path ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.uploadFailed"));
  return { path: uploadResponse.path };
}

/**
 * Stage full-resolution submission images from an upload-capable player.
 * Each attempt has unique filenames, including correlated retained captures.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Full-resolution submission payload.
 * @param {{captureId?: string|null}} [options] Optional correlated retained-capture identity.
 * @returns {Promise<{overlayPath: string, mergedPath: string|null}>} Staged file paths.
 */
export async function stageSubmissionImages(assignmentId, submission, { captureId = null } = {}) {
  if ( captureId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(captureId) ) throw new Error("Invalid capture id");
  if ( !canStageUploads() ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.fileUploadRequired"));
  // FILES_UPLOAD permits uploads into EXISTING directories only; createDirectory
  // requires browse rights players usually lack. The GM pre-creates the staging
  // directory at send time (see sendPrompt); if it is missing the upload
  // rejects and the caller falls back to the socket lane.
  const dir = stagingDir();
  const basename = String(assignmentId || "assignment");
  const overlayBlob = await dataUrlToBlob(submission?.overlay?.dataUrl);
  const mergedBlob = submission?.merged?.dataUrl ? await dataUrlToBlob(submission.merged.dataUrl) : null;
  const attemptId = foundry.utils.randomID();
  const suffix = `${captureId === null ? "" : `-capture-${captureId}`}-upload-${attemptId}`;
  const overlayFilename = `${basename}-overlay${suffix}.${extensionFor(submission?.overlay?.format)}`;
  const uploads = [
    uploadInternalImage(assignmentId, dir, overlayFilename, overlayBlob,
      { attemptId, kind: "overlay", purpose: captureId ? "retained-capture" : "staging" })
  ];

  if ( mergedBlob ) {
    const mergedFilename = `${basename}-merged${suffix}.${extensionFor(submission.merged.format)}`;
    uploads.push(uploadInternalImage(assignmentId, dir, mergedFilename, mergedBlob,
      { attemptId, kind: "merged", purpose: captureId ? "retained-capture" : "staging" }));
  }

  const results = await Promise.allSettled(uploads);
  const failure = results.find(result => result.status === "rejected");
  if ( failure ) {
    const { settleInternalUploads, reconcileFileCleanup } = await import("./file-cleanup-service.mjs");
    try { await settleInternalUploads([attemptId]); }
    catch (_error) { /* Same-session recovery can repair the persisted intent. */ }
    void reconcileFileCleanup().catch(() => {});
    throw failure.reason;
  }
  const [overlay, merged] = results.map(result => result.value);
  return {
    overlayPath: overlay.path,
    mergedPath: merged?.path ?? null
  };
}

/** Upload one registered internal image; intentionally exported artwork uses other helpers. */
async function uploadInternalImage(assignmentId, dir, filename, blob, { attemptId, kind, purpose }) {
  const { beginInternalUpload, completeInternalUpload } = await import("./file-cleanup-service.mjs");
  const reservationId = await beginInternalUpload({
    assignmentId, attemptId, kind, purpose, expectedPath: `${normalizePath(dir)}/${filename}`
  });
  let uploaded;
  try {
    uploaded = await uploadBlobForCurrentUser(dir, filename, blob);
    await completeInternalUpload(reservationId, { path: uploaded.path });
    return uploaded;
  } catch (error) {
    await completeInternalUpload(reservationId, { path: uploaded?.path, error: "Upload did not complete" }).catch(() => {});
    throw error;
  }
}

/** GM-side internal pending/capture upload with durable registration before file creation. */
export async function uploadInternalDataUrl(assignmentId, dir, filename, dataUrl, identity) {
  assertGM();
  return uploadInternalImage(assignmentId, dir, filename, await dataUrlToBlob(dataUrl), identity);
}

/**
 * Upload a Blob without a GM assertion. Callers must guard capability first.
 * @param {string} dir Target directory.
 * @param {string} filename Target filename.
 * @param {Blob} blob Source blob.
 * @returns {Promise<{path: string}>} Uploaded file path response.
 */
async function uploadBlobForCurrentUser(dir, filename, blob) {
  const file = new File([blob], filename, { type: blob.type });
  const uploadResponse = await getFilePicker().upload("data", normalizePath(dir), file, {}, { notify: false });
  if ( !uploadResponse?.path ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.uploadFailed"));
  return { path: uploadResponse.path };
}

/**
 * Convert a data URL to a Blob.
 * @param {string} dataUrl Source data URL.
 * @returns {Promise<Blob>} Blob.
 */
async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

/**
 * Convert an exported format to a file extension.
 * @param {string} format Export format.
 * @returns {string}
 */
function extensionFor(format) {
  return format === "png" ? "png" : "webp";
}
