const HEX_RE_6 = /^#[0-9a-fA-F]{6}$/;
const HEX_RE_3 = /^#[0-9a-fA-F]{3}$/;

/**
 * Normalize CSS hex to lowercase #rrggbb.
 * @param {unknown} value Value.
 * @returns {string|null}
 */
export function normalizeRecentHex(value) {
  const text = String(value ?? "").trim();
  if ( HEX_RE_6.test(text) ) return text.toLowerCase();
  if ( HEX_RE_3.test(text) ) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
  }
  return null;
}

/**
 * Parse a stored recent-color list (JSON array or comma-separated).
 * @param {unknown} raw Stored value.
 * @param {number} [max=3] Max colors retained.
 * @returns {string[]}
 */
export function parseRecentColors(raw, max = 3) {
  const limit = Math.max(1, Math.floor(Number(max) || 3));
  let values = [];
  if ( Array.isArray(raw) ) values = raw;
  else if ( typeof raw === "string" && raw.trim() ) {
    try {
      const parsed = JSON.parse(raw);
      if ( Array.isArray(parsed) ) values = parsed;
      else values = raw.split(",");
    } catch {
      values = raw.split(",");
    }
  }
  const out = [];
  for ( const value of values ) {
    const hex = normalizeRecentHex(value);
    if ( !hex || out.includes(hex) ) continue;
    out.push(hex);
    if ( out.length >= limit ) break;
  }
  return out;
}

/**
 * Push a color to the front of the recent ring (deduped).
 * @param {string[]} history Existing history.
 * @param {unknown} hex New color.
 * @param {number} [max=3] Max colors retained.
 * @returns {string[]}
 */
export function pushRecentColor(history, hex, max = 3) {
  const limit = Math.max(1, Math.floor(Number(max) || 3));
  const color = normalizeRecentHex(hex);
  const base = Array.isArray(history) ? history : [];
  if ( !color ) return parseRecentColors(base, limit);
  return [color, ...base.filter(entry => normalizeRecentHex(entry) !== color)].slice(0, limit);
}

/**
 * Fixed-length recent-color slots for UI (null = empty placeholder).
 * @param {string[]} history History.
 * @param {number} [max=3] Slot count.
 * @returns {(string|null)[]}
 */
export function recentColorSlots(history, max = 3) {
  const limit = Math.max(1, Math.floor(Number(max) || 3));
  const colors = parseRecentColors(history, limit);
  return Array.from({ length: limit }, (_, index) => colors[index] ?? null);
}

/**
 * Serialize recent colors for a client setting.
 * @param {string[]} history History.
 * @returns {string}
 */
export function serializeRecentColors(history) {
  return JSON.stringify(parseRecentColors(history, 3));
}
