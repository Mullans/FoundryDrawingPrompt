/**
 * Normalize data-source paths to forward-slash, no-edge-slash form.
 * @param {string} path Data-source path.
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Detect whether this client is running on The Forge.
 * @returns {boolean} Whether The Forge integration is active.
 */
export function isForge() {
  return typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge;
}

/**
 * Build the staging directory below an asset base.
 * @param {string} baseFolder Asset base folder.
 * @returns {string} Staging directory.
 */
export function buildStagingPath(baseFolder) {
  const base = normalizePath(String(baseFolder ?? ""));
  return base ? `${base}/staging` : "staging";
}

/**
 * Build the pending directory for an assignment below an asset base.
 * @param {string} baseFolder Asset base folder.
 * @param {string} assignmentId Assignment id.
 * @returns {string} Pending directory.
 */
export function buildPendingPath(baseFolder, assignmentId) {
  const base = normalizePath(String(baseFolder ?? ""));
  const id = safePathSegment(assignmentId || "assignment", "assignmentId");
  return base ? `${base}/pending/${id}` : `pending/${id}`;
}

/**
 * Build the asset directory for one prompt below an asset base.
 * @param {string} baseFolder Asset base folder.
 * @param {string} promptFolderName Prompt folder name.
 * @returns {string} Prompt asset directory.
 */
export function buildPromptAssetPath(baseFolder, promptFolderName) {
  const base = normalizePath(String(baseFolder ?? ""));
  const folder = safePathSegment(promptFolderName, "promptFolderName");
  return base ? `${base}/${folder}` : folder;
}

/**
 * Resolve the remembered parent and final prompt asset directory for an actual save.
 * Explicit selection wins, followed by the stored assignment folder, then the computed prompt folder.
 * @param {object} options Save location inputs.
 * @param {string} [options.selectedParent] Explicitly selected parent directory.
 * @param {string} [options.rememberedParent] Previously selected parent directory.
 * @param {string} [options.defaultParent] Provider default parent directory.
 * @param {string} [options.assignmentFolder] Existing final directory for this assignment.
 * @param {string} options.promptFolderName Stable prompt folder name.
 * @returns {{parent: string, final: string}} Parent setting and final save directory.
 */
export function resolvePromptAssetLocation({
  selectedParent = "",
  rememberedParent = "",
  defaultParent = "",
  assignmentFolder = "",
  promptFolderName
} = {}) {
  const folder = safePathSegment(promptFolderName, "promptFolderName");
  let parent = normalizePath(String(selectedParent || ""));
  if ( parent ) {
    if ( parent.split("/").at(-1) === folder ) parent = parentPath(parent);
    return { parent, final: buildPromptAssetPath(parent, folder) };
  }
  const existing = normalizePath(String(assignmentFolder || ""));
  if ( existing ) return { parent: parentPath(existing), final: existing };

  parent = normalizePath(String(rememberedParent || defaultParent || ""));
  if ( parent.split("/").at(-1) === folder ) parent = parentPath(parent);
  return { parent, final: buildPromptAssetPath(parent, folder) };
}

function parentPath(path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * Require a value that cannot escape its parent path.
 * @param {*} value Candidate segment.
 * @param {string} name Parameter name.
 * @returns {string} Safe segment.
 */
function safePathSegment(value, name) {
  const segment = String(value ?? "");
  if ( !segment || segment === "." || segment === ".." || /[\\/]/.test(segment) ) {
    throw new TypeError(`${name} must be a safe single path segment`);
  }
  return segment;
}

/**
 * Create a pure path provider from explicit runtime values.
 * @param {object} options Provider inputs.
 * @param {boolean} options.forge Whether Forge paths are active.
 * @param {string} options.worldId Current world id.
 * @param {string} options.settingValue Configured asset-folder override.
 * @returns {{base: string, staging: function(): string, pending: function(string): string, promptAssets: function(string): string}}
 */
export function createPathProvider({ forge, worldId, settingValue }) {
  const configured = normalizePath(String(settingValue || ""));
  const id = normalizePath(String(worldId ?? ""));
  const base = configured || (forge ? `drawing-prompts/${id}` : `worlds/${id}/drawing-prompts`);

  return {
    base,
    staging: () => buildStagingPath(base),
    pending: assignmentId => buildPendingPath(base, assignmentId),
    promptAssets: promptFolderName => buildPromptAssetPath(base, promptFolderName)
  };
}
