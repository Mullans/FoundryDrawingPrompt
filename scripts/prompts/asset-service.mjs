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
 * Get the player-side submission staging directory. Staged files use
 * deterministic names and overwrite on resubmission; there is no client-side
 * delete API, so abandoned staged files are bounded by assignment id.
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
 * @returns {Promise<string[]>}
 */
export async function browseFiles(dir) {
  assertGM();
  try {
    const result = await getFilePicker().browse("data", normalizePath(dir));
    return Array.isArray(result?.files) ? result.files : [];
  } catch (_err) {
    return [];
  }
}

/** Delete one exact module-owned data-source file without touching its parent folder. */
export async function deleteDataFile(path) {
  assertGM();
  const target = normalizePath(path);
  if ( !target ) return false;
  try {
    await getFilePicker().delete("data", target, { notify: false });
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not delete module-owned file`, target, err);
    return false;
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
 * Staged filenames are deterministic per assignment and overwrite on
 * resubmission; Foundry exposes no client-side delete API, so orphaned staging
 * files are bounded by assignment id.
 * @param {string} assignmentId Assignment id.
 * @param {object} submission Full-resolution submission payload.
 * @returns {Promise<{overlayPath: string, mergedPath: string|null}>} Staged file paths.
 */
export async function stageSubmissionImages(assignmentId, submission) {
  if ( !canStageUploads() ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.fileUploadRequired"));
  // FILES_UPLOAD permits uploads into EXISTING directories only — createDirectory
  // requires browse rights players usually lack. The GM pre-creates the staging
  // directory at send time (see sendPrompt); if it is missing the upload
  // rejects and the caller falls back to the socket lane.
  const dir = stagingDir();
  const basename = String(assignmentId || "assignment");
  const overlayBlob = await dataUrlToBlob(submission?.overlay?.dataUrl);
  const overlayFilename = `${basename}-overlay.${extensionFor(submission?.overlay?.format)}`;
  const uploads = [
    uploadBlobForCurrentUser(dir, overlayFilename, overlayBlob)
  ];

  const hasMerged = Boolean(submission?.merged?.dataUrl);
  if ( hasMerged ) {
    const mergedBlob = await dataUrlToBlob(submission.merged.dataUrl);
    const mergedFilename = `${basename}-merged.${extensionFor(submission.merged.format)}`;
    uploads.push(uploadBlobForCurrentUser(dir, mergedFilename, mergedBlob));
  }

  const [overlay, merged] = await Promise.all(uploads);
  return {
    overlayPath: overlay.path,
    mergedPath: merged?.path ?? null
  };
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
