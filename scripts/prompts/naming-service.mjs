const DEFAULT_PROMPT_NAME_LIMIT = 61;

/**
 * Build the default saved drawing name.
 * @param {object} options Options.
 * @param {string} [options.drawingName] Prompt drawing name.
 * @param {string} [options.promptText] Prompt text.
 * @param {string} [options.userName] Assignment display name.
 * @returns {string} Default saved drawing name.
 */
export function defaultAssignmentAssetName({ drawingName = "", promptText = "", userName = "" } = {}) {
  const base = String(drawingName || truncatePromptText(promptText)).trim();
  return `${base || "Drawing"} – ${String(userName || "").trim() || "Player"}`;
}

/**
 * Convert a drawing name to a filesystem-safe slug.
 * @param {string} value Name to slugify.
 * @param {{fallback?: string}} [options] Options.
 * @returns {string}
 */
export function slugifyDrawingName(value, { fallback = "drawing" } = {}) {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || slugifyDrawingName(fallback, { fallback: "drawing" });
}

/**
 * Pick collision-free asset filenames for a saved drawing.
 * @param {object} options Options.
 * @param {string} options.name Drawing name.
 * @param {string} [options.extension="webp"] Image extension.
 * @param {boolean} [options.hasMerged=false] Whether a merged primary file exists.
 * @param {string[]} [options.existingFiles=[]] Existing file paths or names.
 * @param {string} [options.fallback="drawing"] Fallback slug text.
 * @returns {{slug: string, primary: string, overlay: string|null, opLog: string}}
 */
export function uniqueDrawingAssetFilenames({ name, extension = "webp", hasMerged = false, existingFiles = [], fallback = "drawing" } = {}) {
  const base = slugifyDrawingName(name, { fallback });
  const ext = String(extension || "webp").replace(/^\./, "").toLowerCase() || "webp";
  const existing = new Set(existingFiles.map(file => String(file).split(/[\\/]/).pop().toLowerCase()));
  for ( let index = 1; index < 10000; index++ ) {
    const slug = index === 1 ? base : `${base}-${index}`;
    const candidate = {
      slug,
      primary: `${slug}.${ext}`,
      overlay: hasMerged ? `${slug}-overlay.${ext}` : null,
      opLog: `${slug}-oplog.json`
    };
    const names = [candidate.primary, candidate.overlay, candidate.opLog].filter(Boolean).map(name => name.toLowerCase());
    if ( names.every(name => !existing.has(name)) ) return candidate;
  }
  throw new Error("Unable to find an available drawing filename.");
}

/**
 * Truncate prompt text for use in a default name.
 * @param {string} text Prompt text.
 * @returns {string} Truncated prompt text.
 */
function truncatePromptText(text) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if ( normalized.length <= DEFAULT_PROMPT_NAME_LIMIT ) return normalized;
  return `${normalized.slice(0, DEFAULT_PROMPT_NAME_LIMIT - 3).trimEnd()}...`;
}
