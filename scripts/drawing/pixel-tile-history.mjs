const DEFAULT_TILE_SIZE = 128;
const DEFAULT_ACTION_LIMIT = 25;
const MIN_COMMITTED_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const TRANSPARENT = Object.freeze({ id: "transparent", kind: "transparent" });

/** Bounded foreground history using one reversible reference per changed tile. */
export class PixelTileHistory {
  #width; #height; #tileSize; #actionLimit; #byteBudget; #metadataBudget; #writerId;
  #entries = []; #cursor = 0; #current = new Map(); #activeEdit = null; #nextVersion = 1;

  constructor({ width, height, tileSize = DEFAULT_TILE_SIZE, actionLimit = DEFAULT_ACTION_LIMIT,
    byteBudget = null, metadataBudget = MAX_METADATA_BYTES, writerId = null } = {}) {
    this.#width = positiveInteger(width, "width"); this.#height = positiveInteger(height, "height");
    this.#tileSize = positiveInteger(tileSize, "tileSize"); this.#actionLimit = positiveInteger(actionLimit, "actionLimit");
    const canvasBytes = this.#width * this.#height * 4;
    this.#byteBudget = Math.max(canvasBytes * 2, Number(byteBudget) || MIN_COMMITTED_BYTES);
    this.#metadataBudget = positiveInteger(metadataBudget, "metadataBudget");
    this.#writerId = writerId || globalThis.crypto?.randomUUID?.() || `history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  get canUndo() { return this.#cursor > 0; }
  get canRedo() { return this.#cursor < this.#entries.length; }
  get cursor() { return this.#cursor; }
  get actionCount() { return this.#entries.length; }
  get allocatedBytes() { return this.#measureBytes(); }
  get metadataBytes() { return this.#measureMetadataBytes(); }

  tileRects(tiles) {
    return [...this.#normalizeTiles(tiles)].map(tile => ({ tile, ...this.#tileRect(tile) }));
  }

  commit({ id, kind, tiles, before, after, color = null } = {}) {
    validateAction(id, kind); const changes = [];
    for ( const tile of this.#normalizeTiles(tiles) ) {
      const rect = this.#tileRect(tile);
      const previous = this.#current.get(tile) ?? this.#readVersion(before, rect);
      const resulting = this.#readVersion(after, rect);
      if ( equalVersions(previous, resulting) ) continue;
      changes.push({ tile, opposite: previous }); this.#setCurrent(tile, resulting);
    }
    return this.#seal({ id, kind, color, changes });
  }

  commitClear({ id } = {}) {
    validateAction(id, "clear");
    const changes = [...this.#current].map(([tile, opposite]) => ({ tile, opposite }));
    if ( !changes.length ) return false;
    this.#current.clear();
    return this.#seal({ id, kind: "clear", color: null, changes });
  }

  beginEdit() { this.#activeEdit = new Map(); }
  prepareEdit({ tiles, source } = {}) {
    this.#activeEdit ??= new Map();
    for ( const tile of this.#normalizeTiles(tiles) ) {
      if ( this.#activeEdit.has(tile) ) continue;
      const previous = this.#current.get(tile) ?? this.#readVersion(source, this.#tileRect(tile));
      this.#activeEdit.set(tile, { tile, previous, resulting: previous });
    }
  }
  restoreEditTiles(target, tiles) {
    for ( const tile of this.#normalizeTiles(tiles) ) {
      const edit = this.#activeEdit?.get(tile);
      if ( edit ) this.#install(target, tile, edit.previous);
    }
  }
  updateEdit({ tiles, before, after } = {}) {
    this.prepareEdit({ tiles, source: before });
    for ( const tile of this.#normalizeTiles(tiles) ) this.#activeEdit.get(tile).resulting = this.#readVersion(after, this.#tileRect(tile));
  }
  commitEdit({ id, kind, color = null } = {}) {
    validateAction(id, kind); const changes = [];
    for ( const edit of this.#activeEdit?.values() ?? [] ) {
      if ( equalVersions(edit.previous, edit.resulting) ) continue;
      changes.push({ tile: edit.tile, opposite: edit.previous }); this.#setCurrent(edit.tile, edit.resulting);
    }
    this.#activeEdit = null;
    return this.#seal({ id, kind, color, changes });
  }
  cancelEdit(target = null) {
    if ( target ) for ( const edit of this.#activeEdit?.values() ?? [] ) this.#install(target, edit.tile, edit.previous);
    this.#activeEdit = null;
  }

  undo(target) { return this.#swap(target, this.#cursor - 1, -1); }
  redo(target) { return this.#swap(target, this.#cursor, 1); }

  resetFrom(target) {
    this.#entries = []; this.#cursor = 0; this.#current = new Map(); this.#activeEdit = null;
    for ( let tile = 0; tile < this.#tileCount(); tile++ ) this.#setCurrent(tile, this.#readVersion(target, this.#tileRect(tile)));
  }

  get committedTip() {
    if ( this.#cursor !== this.#entries.length || !this.#cursor ) return null;
    const { id, kind, color } = this.#entries[this.#cursor - 1]; return { id, kind, ...(color ? { color } : {}) };
  }

  snapshot({ copyPixels = true } = {}) {
    return { schema: 2, width: this.#width, height: this.#height, tileSize: this.#tileSize,
      actionLimit: this.#actionLimit, writerId: this.#writerId, cursor: this.#cursor,
      current: [...this.#current].map(([tile, version]) => [tile, version.id]),
      entries: this.#entries.map(entry => ({ id: entry.id, kind: entry.kind, color: entry.color,
        changes: entry.changes.map(change => [change.tile, change.opposite.id]) })),
      versions: [...this.#reachableVersions()].map(version => serializeVersion(version, copyPixels)) };
  }

  static restore(snapshot, target, options = {}) {
    validateHeader(snapshot);
    const history = new PixelTileHistory({ width: snapshot.width, height: snapshot.height, tileSize: snapshot.tileSize,
      actionLimit: snapshot.actionLimit, writerId: requiredString(snapshot.writerId), ...options });
    const versions = new Map([[TRANSPARENT.id, TRANSPARENT]]);
    for ( const value of snapshot.versions ) {
      const version = deserializeVersion(value);
      if ( !version.id.startsWith(`${history.#writerId}:`) || versions.has(version.id) ) throw new Error("Recovery history contains an invalid tile version ID");
      versions.set(version.id, version);
    }
    history.#current = new Map(snapshot.current.map(value => {
      const [tile, id] = validateReference(value, history.#tileCount()); const version = requireVersion(versions, id);
      history.#validateVersionForTile(version, tile); if ( version.kind === "transparent" ) throw new Error("Recovery current map must be sparse"); return [tile, version];
    }));
    if ( history.#current.size !== snapshot.current.length ) throw new Error("Recovery current map contains duplicate tiles");
    history.#entries = snapshot.entries.map(entry => {
      const changed = new Set();
      const changes = entry?.changes?.map(value => { const [tile, id] = validateReference(value, history.#tileCount());
        if ( changed.has(tile) ) throw new Error("Recovery action contains a duplicate tile"); changed.add(tile);
        const opposite = requireVersion(versions, id); history.#validateVersionForTile(opposite, tile); return { tile, opposite }; });
      if ( typeof entry?.id !== "string" || !entry.id || typeof entry?.kind !== "string" || !entry.kind || !changes?.length ) throw new Error("Invalid Recovery history entry");
      return { id: entry.id, kind: entry.kind, color: typeof entry.color === "string" ? entry.color : null, changes };
    });
    history.#cursor = boundedInteger(snapshot.cursor, 0, history.#entries.length);
    if ( history.#entries.length > history.#actionLimit || history.#measureBytes() > history.#byteBudget || history.#measureMetadataBytes() > history.#metadataBudget ) throw new Error("Recovery history exceeds limits");
    target.clearRect(0, 0, history.#width, history.#height);
    for ( const [tile, version] of history.#current ) history.#install(target, tile, version);
    history.#nextVersion = 1 + [...versions.keys()].reduce((max, id) => Math.max(max, Number(String(id).match(/:(\d+)$/)?.[1]) || 0), 0);
    return history;
  }

  #seal({ id, kind, color, changes }) {
    if ( !changes.length ) return false;
    if ( this.#cursor < this.#entries.length ) this.#entries.splice(this.#cursor);
    this.#entries.push({ id, kind, color, changes }); this.#cursor = this.#entries.length; this.#enforceLimits(); return true;
  }
  #swap(target, index, cursorDelta) {
    if ( index < 0 || index >= this.#entries.length ) return false;
    const entry = this.#entries[index];
    const swaps = entry.changes.map(change => ({ change, current: this.#current.get(change.tile) ?? TRANSPARENT }));
    for ( const { change } of swaps ) this.#install(target, change.tile, change.opposite);
    for ( const { change, current } of swaps ) { this.#setCurrent(change.tile, change.opposite); change.opposite = current; }
    this.#cursor += cursorDelta; return true;
  }
  #setCurrent(tile, version) { if ( version.kind === "transparent" ) this.#current.delete(tile); else this.#current.set(tile, version); }
  #install(target, tile, version) {
    const rect = this.#tileRect(tile);
    if ( version.kind === "transparent" ) return target.clearRect(rect.x, rect.y, rect.width, rect.height);
    const data = version.kind === "rgba" ? version.data : uniformPixels(version.rgba, rect.width * rect.height);
    const image = typeof ImageData === "function" ? new ImageData(data, rect.width, rect.height) : { data, width: rect.width, height: rect.height };
    target.putImageData(image, rect.x, rect.y);
  }
  #readVersion(source, rect) {
    const compact = compactPixels(source.getImageData(rect.x, rect.y, rect.width, rect.height).data);
    return compact.kind === "transparent" ? TRANSPARENT : Object.freeze({ id: `${this.#writerId}:${this.#nextVersion++}`, ...compact });
  }
  #enforceLimits() {
    while ( this.#entries.length > this.#actionLimit || (this.#entries.length > 1 && (this.#measureBytes() > this.#byteBudget || this.#measureMetadataBytes() > this.#metadataBudget)) ) {
      this.#entries.shift(); this.#cursor = Math.max(0, this.#cursor - 1);
    }
  }
  #reachableVersions() { const versions = new Set(this.#current.values()); for ( const entry of this.#entries ) for ( const change of entry.changes ) versions.add(change.opposite); versions.delete(TRANSPARENT); return versions; }
  #measureBytes() { let bytes = 0; for ( const version of this.#reachableVersions() ) bytes += version.kind === "rgba" ? version.data.byteLength : 4; return bytes; }
  #measureMetadataBytes() {
    const versions = this.#reachableVersions();
    const changes = this.#entries.reduce((sum, entry) => sum + entry.changes.length, 0);
    const textBytes = this.#entries.reduce((sum, entry) => sum + (entry.id.length + entry.kind.length + (entry.color?.length ?? 0)) * 2, 0)
      + [...versions].reduce((sum, version) => sum + version.id.length * 2, 0);
    return this.#current.size * 24 + this.#entries.length * 64 + changes * 32 + versions.size * 32 + textBytes;
  }
  #validateVersionForTile(version, tile) { if ( version.kind === "rgba" ) { const rect = this.#tileRect(tile); if ( version.data.byteLength !== rect.width * rect.height * 4 ) throw new Error("Recovery tile pixels do not match its coordinate"); } }
  #normalizeTiles(tiles) { const unique = new Set(); for ( const value of Array.isArray(tiles) ? tiles : [] ) { const tile = Array.isArray(value) ? this.#tileIndex(value[0], value[1]) : Number(value); if ( Number.isSafeInteger(tile) && tile >= 0 && tile < this.#tileCount() ) unique.add(tile); } return unique; }
  #tileIndex(tx, ty) { const x = Number(tx); const y = Number(ty); return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.#columns() && y < this.#rows() ? y * this.#columns() + x : -1; }
  #tileRect(tile) { const tx = tile % this.#columns(); const ty = Math.floor(tile / this.#columns()); const x = tx * this.#tileSize; const y = ty * this.#tileSize; return { x, y, width: Math.min(this.#tileSize, this.#width - x), height: Math.min(this.#tileSize, this.#height - y) }; }
  #columns() { return Math.ceil(this.#width / this.#tileSize); } #rows() { return Math.ceil(this.#height / this.#tileSize); } #tileCount() { return this.#columns() * this.#rows(); }
}

export function tilesForStroke(points, size, width, height, tileSize = DEFAULT_TILE_SIZE) {
  const columns = Math.ceil(width / tileSize); const result = new Set(); const radius = Math.max(1, Number(size) || 1) / 2 + 2; const list = Array.isArray(points) ? points : [];
  for ( let index = 0; index < list.length; index++ ) { const from = list[Math.max(0, index - 1)]; const to = list[index];
    const minX = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius)); const maxX = Math.min(width - 1, Math.ceil(Math.max(from.x, to.x) + radius));
    const minY = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius)); const maxY = Math.min(height - 1, Math.ceil(Math.max(from.y, to.y) + radius));
    for ( let ty = Math.floor(minY / tileSize); ty <= Math.floor(maxY / tileSize); ty++ ) for ( let tx = Math.floor(minX / tileSize); tx <= Math.floor(maxX / tileSize); tx++ ) result.add(ty * columns + tx);
  } return [...result];
}
export function allTiles(width, height, tileSize = DEFAULT_TILE_SIZE) { return Array.from({ length: Math.ceil(width / tileSize) * Math.ceil(height / tileSize) }, (_, tile) => tile); }

function compactPixels(value) { const data = value instanceof Uint8ClampedArray ? value : new Uint8ClampedArray(value); let transparent = true; let uniform = true; const first = data.subarray(0, 4);
  for ( let offset = 0; offset < data.length; offset += 4 ) { if ( data[offset + 3] !== 0 ) transparent = false; if ( data[offset] !== first[0] || data[offset + 1] !== first[1] || data[offset + 2] !== first[2] || data[offset + 3] !== first[3] ) uniform = false; if ( !transparent && !uniform ) break; }
  if ( transparent ) return { kind: "transparent" }; if ( uniform ) return { kind: "uniform", rgba: Object.freeze([...first]) }; return { kind: "rgba", data };
}
function equalVersions(a, b) { if ( a === b ) return true; if ( a.kind !== b.kind ) return false; if ( a.kind === "transparent" ) return true; const left = a.kind === "uniform" ? a.rgba : a.data; const right = b.kind === "uniform" ? b.rgba : b.data; if ( left.length !== right.length ) return false; for ( let i = 0; i < left.length; i++ ) if ( left[i] !== right[i] ) return false; return true; }
function uniformPixels(rgba, count) { const data = new Uint8ClampedArray(count * 4); for ( let offset = 0; offset < data.length; offset += 4 ) data.set(rgba, offset); return data; }
function serializeVersion(version, copyPixels) { return { id: version.id, kind: version.kind, ...(version.kind === "rgba" ? { data: copyPixels ? new Uint8ClampedArray(version.data) : version.data } : {}), ...(version.kind === "uniform" ? { rgba: [...version.rgba] } : {}) }; }
function deserializeVersion(value) { const id = requiredString(value?.id); if ( value?.kind === "uniform" && Array.isArray(value.rgba) && value.rgba.length === 4 && value.rgba.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ) return Object.freeze({ id, kind: "uniform", rgba: Object.freeze([...value.rgba]) }); if ( value?.kind !== "rgba" || !(value.data instanceof Uint8ClampedArray) || !value.data.byteLength ) throw new Error("Invalid Recovery tile version"); return Object.freeze({ id, kind: "rgba", data: value.data }); }
function validateHeader(snapshot) { if ( snapshot?.schema !== 2 || !Array.isArray(snapshot.current) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.versions) ) throw new Error("Invalid Recovery history snapshot"); positiveInteger(snapshot.width, "Recovery width"); positiveInteger(snapshot.height, "Recovery height"); positiveInteger(snapshot.tileSize, "Recovery tile size"); positiveInteger(snapshot.actionLimit, "Recovery action limit"); }
function validateReference(value, tileCount) { if ( !Array.isArray(value) || value.length !== 2 ) throw new Error("Invalid Recovery tile reference"); return [boundedInteger(value[0], 0, tileCount - 1), requiredString(value[1])]; }
function requireVersion(versions, id) { const value = versions.get(id); if ( !value ) throw new Error("Recovery references a missing tile version"); return value; }
function validateAction(id, kind) { requiredString(id); requiredString(kind); }
function positiveInteger(value, name) { const n = Number(value); if ( !Number.isSafeInteger(n) || n <= 0 ) throw new Error(`Invalid ${name}`); return n; }
function boundedInteger(value, min, max) { const n = Number(value); if ( !Number.isSafeInteger(n) || n < min || n > max ) throw new Error("Invalid Recovery integer"); return n; }
function requiredString(value) { if ( typeof value !== "string" || !value ) throw new Error("Invalid Recovery text"); return value; }
