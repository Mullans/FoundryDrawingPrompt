import { MODULE_ID, SETTINGS } from "../constants.mjs";

/**
 * Ensure the current user is a GM before writing files.
 * @returns {void}
 */
function assertGM() {
  if ( !game.user.isGM ) throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.gmOnly"));
}

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
 * Normalize data-source paths to forward-slash, no-edge-slash form.
 * @param {string} path Data-source path.
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Get the default flat asset folder.
 * @returns {string}
 */
export function defaultAssetFolder() {
  const configured = normalizePath(game.settings.get(MODULE_ID, SETTINGS.ASSET_FOLDER) || "");
  return configured || `worlds/${game.world.id}/drawing-prompts`;
}

/**
 * Get the asset directory for a prompt.
 * @param {string} promptId Prompt id.
 * @returns {string}
 */
export function promptAssetDir(promptId) {
  return `${defaultAssetFolder()}/${promptId}`;
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
