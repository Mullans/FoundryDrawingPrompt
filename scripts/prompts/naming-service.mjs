const DEFAULT_PROMPT_NAME_LIMIT = 61;
const PROMPT_FOLDER_SLUG_LIMIT = 40;
// Keeps every generated filename component at 200 characters or fewer. The
// 180-character slug budget leaves 20 characters for a collision counter,
// "-overlay"/"-oplog", a dot, and a normalized extension.
const MAX_ASSET_SLUG_LENGTH = 180;
const MAX_EXTENSION_LENGTH = 10;

/**
 * Build the default saved drawing name.
 * @param {object} options Options.
 * @param {string} [options.drawingName] Prompt drawing name.
 * @param {string} [options.promptText] Prompt text.
 * @returns {string} Default saved drawing name.
 */
export function defaultAssignmentAssetName({ drawingName = "", promptText = "" } = {}) {
  const base = String(drawingName || truncatePromptText(promptText)).trim();
  return base || "Drawing";
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
 * Build the stable asset folder name for a prompt.
 * @param {object} options Prompt identity and timestamps.
 * @param {string} [options.promptId] Prompt id.
 * @param {string} [options.promptText] Prompt text.
 * @param {number} [options.sentAt] Time the prompt was sent.
 * @param {number} [options.createdAt] Time the prompt was created.
 * @param {number|Date|string|Function} [options.now=Date.now] Injected current time. If every timestamp is invalid, the fixed Unix epoch is used.
 * @returns {string}
 */
export function promptAssetFolderName({
  promptId = "",
  promptText = "",
  sentAt = null,
  createdAt = null,
  now = Date.now
} = {}) {
  const timestamp = firstTimestamp(sentAt, createdAt)
    ?? validTimestamp(typeof now === "function" ? now() : now)
    ?? 0;
  const date = new Date(timestamp).toISOString().slice(0, 10);
  const promptSlug = slugifyDrawingName(promptText, { fallback: "prompt" })
    .slice(0, PROMPT_FOLDER_SLUG_LIMIT)
    .replace(/-+$/g, "") || "prompt";
  return `${date}-${promptSlug}-${stableIdFragment(promptId)}`;
}

/**
 * Pick collision-free asset filenames for a saved drawing.
 * @param {object} options Options.
 * @param {string} options.name Drawing name.
 * @param {string} [options.playerName] Player display name. Omission preserves legacy base-only names; an explicitly blank value falls back to "player".
 * @param {string} [options.extension="webp"] Image extension.
 * @param {boolean} [options.hasMerged=false] Whether a merged primary file exists.
 * @param {boolean} [options.hasSourceFull=false] Whether Full Framing `_full` / `_source` files exist.
 * @param {string[]} [options.existingFiles=[]] Existing file paths or names.
 * @param {string} [options.fallback="drawing"] Fallback slug text.
 * @returns {{slug: string, primary: string, overlay: string|null, sourceFull: string|null, sourceOverlay: string|null, opLog: string}}
 */
export function uniqueDrawingAssetFilenames(options = {}) {
  const {
    name,
    playerName = "",
    extension = "webp",
    hasMerged = false,
    hasSourceFull = false,
    existingFiles = [],
    fallback = "drawing"
  } = options;
  const drawingSlug = slugifyDrawingName(name, { fallback });
  const hasPlayerName = Object.prototype.hasOwnProperty.call(options, "playerName");
  const base = hasPlayerName
    ? `${drawingSlug}-${slugifyDrawingName(playerName, { fallback: "player" })}`
    : drawingSlug;
  const ext = String(extension || "webp")
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_EXTENSION_LENGTH) || "webp";
  const existing = new Set(existingFiles.map(file => String(file).split(/[\\/]/).pop().toLowerCase()));
  for ( let index = 1; index < 10000; index++ ) {
    const counter = index === 1 ? "" : `-${index}`;
    const stem = base.slice(0, MAX_ASSET_SLUG_LENGTH - counter.length).replace(/-+$/g, "") || "drawing";
    const slug = `${stem}${counter}`;
    const candidate = {
      slug,
      primary: `${slug}.${ext}`,
      overlay: hasMerged ? `${slug}-overlay.${ext}` : null,
      sourceFull: hasSourceFull ? `${slug}_full.${ext}` : null,
      sourceOverlay: hasSourceFull ? `${slug}_source.${ext}` : null,
      opLog: `${slug}-oplog.json`
    };
    const names = [candidate.primary, candidate.overlay, candidate.sourceFull, candidate.sourceOverlay, candidate.opLog]
      .filter(Boolean)
      .map(name => name.toLowerCase());
    if ( names.every(name => !existing.has(name)) ) return candidate;
  }
  throw new Error("Unable to find an available drawing filename.");
}

/**
 * Return the first supplied finite epoch timestamp.
 * @param {...unknown} values Candidate timestamps.
 * @returns {number|null}
 */
function firstTimestamp(...values) {
  for ( const value of values ) {
    const timestamp = validTimestamp(value);
    if ( timestamp !== null ) return timestamp;
  }
  return null;
}

/**
 * Parse a value only when JavaScript Date can represent it.
 * @param {unknown} value Candidate epoch, Date, or ISO date string.
 * @returns {number|null}
 */
function validTimestamp(value) {
  if ( value === null || value === undefined || value === "" ) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Derive a stable four-character filesystem-safe FNV-1a hash of the full
 * prompt id.
 * @param {unknown} promptId Prompt id.
 * @returns {string}
 */
function stableIdFragment(promptId) {
  const raw = String(promptId ?? "");
  let hash = 0x811c9dc5;
  for ( const character of raw || "prompt" ) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const hashText = hash.toString(36).padStart(4, "0");
  return hashText.slice(-4);
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
