const DB_NAME = "drawing-prompts-recovery";
const GENERATION_STORE = "generations";
const TILE_STORE = "tiles";
const RECORD_SCHEMA = 2;
const DB_VERSION = 3;
const TILE_BATCH_SIZE = 32;
const TRANSPARENT_ID = "transparent";
const STAGING_LEASE_MS = 60_000;

/** Player-local Recovery with artwork-first generations and shared immutable tiles. */
export function createRecoveryStore({ adapter = createIndexedDbRecoveryAdapter(),
  writerId = globalThis.crypto?.randomUUID?.() ?? `writer-${Date.now()}`, now = () => Date.now(),
  quotaBytes = 256 * 1024 * 1024, yieldTask = defaultYieldTask } = {}) {
  const latest = new Map();
  const identityRevisions = new Map();
  const promptRevisions = new Map();

  return {
    supersede(identity) {
      const normalized = normalizeIdentity(identity);
      const identityKey = keyForIdentity(normalized);
      identityRevisions.set(identityKey, (identityRevisions.get(identityKey) ?? 0) + 1);
      latest.delete(identityKey);
    },

    async save(identity, snapshot, { artworkOnly = false } = {}) {
      const normalized = normalizeIdentity(identity); validateSnapshot(snapshot, normalized);
      const generationId = `${writerId}:${now()}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const identityKey = keyForIdentity(normalized); latest.set(identityKey, generationId);
      const identityRevision = identityRevisions.get(identityKey) ?? 0;
      const promptKey = keyForPrompt(normalized);
      const promptRevision = promptRevisions.get(promptKey) ?? 0;
      const isCurrent = () => latest.get(identityKey) === generationId
        && (identityRevisions.get(identityKey) ?? 0) === identityRevision
        && (promptRevisions.get(promptKey) ?? 0) === promptRevision;
      const versions = new Map(snapshot.versions.map(version => [version.id, version]));
      const artwork = artworkSnapshot(snapshot); const artworkIds = referencedIds(artwork);
      let tilesWritten = 0;
      let record = { schema: RECORD_SCHEMA, generationId, writerId, savedAt: now(), identity: normalized,
        artwork: withoutVersions(artwork), history: null, stagingIds: [...artworkIds], complete: false,
        leaseUntil: now() + STAGING_LEASE_MS };
      const publish = async value => {
        const next = { ...value, leaseUntil: now() + STAGING_LEASE_MS };
        if ( !await adapter.replaceGeneration(next) ) throw evictedGenerationError();
        record = next;
      };
      const renewLease = () => publish(record);
      let completed = false;
      try {
        try {
          await adapter.putGeneration(record);
          tilesWritten += await writeMissingTiles(adapter, artworkIds, versions, yieldTask, isCurrent, renewLease);
          if ( !isCurrent() ) {
            await discardGeneration(adapter, generationId);
            return { generationId, historySaved: false, tilesWritten, stale: true };
          }
          await publish({ ...record, stagingIds: [], complete: true });
        } catch (error) {
          await discardGeneration(adapter, generationId);
          throw error;
        }

        let historySaved = false;
        if ( !artworkOnly && snapshot.entries.length ) {
          const historyIds = referencedIds(snapshot);
          try {
            await publish({ ...record, stagingIds: [...historyIds] });
            tilesWritten += await writeMissingTiles(adapter, historyIds, versions, yieldTask, isCurrent, renewLease);
            if ( isCurrent() ) {
              await publish({ ...record, history: withoutVersions(snapshot), stagingIds: [] }); historySaved = true;
            } else {
              await publish({ ...record, stagingIds: [] });
            }
          } catch (_error) {
            await publish({ ...record, stagingIds: [] });
          }
        }
        if ( !isCurrent() ) { await garbageCollectTiles(adapter); return { generationId, historySaved: false, tilesWritten, stale: true }; }

        const priorGenerations = await adapter.getGenerations();
        // A newer edit may start while the adapter reads the cleanup candidates.
        if ( !isCurrent() ) return { generationId, historySaved: false, tilesWritten, stale: true };
        for ( const prior of priorGenerations ) {
          if ( prior.generationId !== generationId && prior.writerId === writerId && sameIdentity(prior.identity, normalized) ) await adapter.deleteGeneration(prior.generationId);
        }
        record = await enforceQuota(adapter, generationId, quotaBytes, now);
        historySaved = Boolean(record?.history);
        await garbageCollectTiles(adapter);
        if ( !await adapter.releaseGenerationLease(generationId) ) throw evictedGenerationError();
        completed = true;
        return { generationId, historySaved, tilesWritten };
      } catch (error) {
        // Newer edits may have already removed this generation. That is normal
        // preemption, whereas eviction of the current writer is a storage failure.
        if ( !isCurrent() ) return { generationId, historySaved: false, tilesWritten, stale: true };
        throw error;
      } finally {
        if ( !completed ) {
          await adapter.releaseGenerationLease(generationId);
          await garbageCollectTiles(adapter);
        }
      }
    },

    async load(identity) {
      const normalized = normalizeIdentity(identity);
      const records = (await adapter.getGenerations()).filter(record => record?.schema === RECORD_SCHEMA && record.complete && sameIdentity(record.identity, normalized))
        .sort((a, b) => Number(b.writerId === writerId) - Number(a.writerId === writerId) || Number(b.savedAt) - Number(a.savedAt));
      for ( const record of records ) {
        if ( record.history ) {
          try { return { kind: "history", generationId: record.generationId, snapshot: await hydrate(adapter, record.history, normalized) }; }
          catch (_error) {
            await adapter.clearHistoryIfMatches(record.generationId, record.history);
            record.history = null;
            await garbageCollectTiles(adapter);
          }
        }
        try { return { kind: "artwork", generationId: record.generationId, snapshot: await hydrate(adapter, record.artwork, normalized) }; }
        catch (_error) { await adapter.deleteGeneration(record.generationId); await garbageCollectTiles(adapter); }
      }
      await garbageCollectTiles(adapter); return null;
    },

    async clear(identity) {
      const normalized = normalizeIdentity(identity);
      const identityKey = keyForIdentity(normalized);
      identityRevisions.set(identityKey, (identityRevisions.get(identityKey) ?? 0) + 1);
      latest.delete(identityKey);
      for ( const record of await adapter.getGenerations() ) if ( sameIdentity(record?.identity, normalized) ) await adapter.deleteGeneration(record.generationId);
      await garbageCollectTiles(adapter);
    },

    async clearPrompt(identity) {
      const normalized = normalizeIdentity(identity, { assignmentOptional: true, dimensionsOptional: true });
      const promptKey = keyForPrompt(normalized);
      promptRevisions.set(promptKey, (promptRevisions.get(promptKey) ?? 0) + 1);
      for ( const record of await adapter.getGenerations() ) { const value = record?.identity;
        if ( value?.worldId === normalized.worldId && value?.gmUserId === normalized.gmUserId && value?.userId === normalized.userId && value?.promptId === normalized.promptId ) await adapter.deleteGeneration(record.generationId);
      }
      await garbageCollectTiles(adapter);
    },
    close: () => adapter.close?.()
  };
}

/** In-memory adapter at the same seam as IndexedDB. */
export function createMapRecoveryAdapter(generations = new Map(), tiles = new Map()) {
  return {
    async putGeneration(record) { generations.set(record.generationId, clone(record)); },
    async replaceGeneration(record) {
      if ( !generations.has(record.generationId) ) return false;
      generations.set(record.generationId, clone(record)); return true;
    },
    async releaseGenerationLease(id) {
      const record = generations.get(id);
      if ( !record ) return false;
      generations.set(id, { ...record, leaseUntil: null, stagingIds: [] }); return true;
    },
    async evictGenerationIfExpired(id, at) {
      const record = generations.get(id);
      if ( !record || Number(record.leaseUntil) > at ) return false;
      generations.delete(id); return true;
    },
    async clearHistoryIfMatches(id, history) {
      const record = generations.get(id);
      if ( !record || !sameHistory(record.history, history) ) return false;
      generations.set(id, { ...record, history: null }); return true;
    },
    async getGenerations() { return [...generations.values()].map(clone); },
    async deleteGeneration(id) { generations.delete(id); },
    async missingTileIds(ids) { return ids.filter(id => id !== TRANSPARENT_ID && !tiles.has(id)); },
    async putTiles(versions) { for ( const version of versions ) tiles.set(version.id, clone(version)); },
    async getTiles(ids) { return ids.filter(id => tiles.has(id)).map(id => clone(tiles.get(id))); },
    async getAllTiles() { return [...tiles.values()].map(clone); },
    async deleteTiles(ids) { for ( const id of ids ) tiles.delete(id); },
    async collectGarbage() {
      const retained = retainedTileIds([...generations.values()]);
      for ( const id of tiles.keys() ) if ( !retained.has(id) ) tiles.delete(id);
    },
    close() {}
  };
}

/** IndexedDB adapter. Version 3 replaces the unreleased prototype stores. */
export function createIndexedDbRecoveryAdapter(indexedDB = globalThis.indexedDB, { dbName = DB_NAME } = {}) {
  let databasePromise;
  const database = () => databasePromise ??= new Promise((resolve, reject) => {
    if ( !indexedDB ) return reject(new Error("IndexedDB is unavailable"));
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if ( event.oldVersion > 0 ) {
        if ( db.objectStoreNames.contains(GENERATION_STORE) ) db.deleteObjectStore(GENERATION_STORE);
        if ( db.objectStoreNames.contains(TILE_STORE) ) db.deleteObjectStore(TILE_STORE);
      }
      db.createObjectStore(GENERATION_STORE, { keyPath: "generationId" });
      db.createObjectStore(TILE_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open Recovery database"));
  });
  const transact = async (stores, mode, operation) => {
    const db = await database(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode); const result = operation(transaction);
      transaction.oncomplete = () => resolve(result?.result); transaction.onerror = () => reject(transaction.error ?? new Error("Recovery transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Recovery transaction aborted"));
    });
  };
  const mutateGeneration = async (id, mutate) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(GENERATION_STORE, "readwrite");
      const store = transaction.objectStore(GENERATION_STORE);
      const request = store.get(id);
      let modified = false;
      request.onsuccess = () => {
        if ( !request.result ) return;
        const next = mutate(request.result);
        if ( next === undefined ) return;
        if ( next === null ) store.delete(id);
        else store.put(next);
        modified = true;
      };
      transaction.oncomplete = () => resolve(modified);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Recovery generation transaction failed"));
    });
  };
  return {
    putGeneration: record => transact(GENERATION_STORE, "readwrite", tx => tx.objectStore(GENERATION_STORE).put(record)),
    replaceGeneration: record => mutateGeneration(record.generationId, () => record),
    releaseGenerationLease: id => mutateGeneration(id, record => ({ ...record, leaseUntil: null, stagingIds: [] })),
    evictGenerationIfExpired: (id, at) => mutateGeneration(id, record => Number(record.leaseUntil) > at ? undefined : null),
    clearHistoryIfMatches: (id, history) => mutateGeneration(id, record => sameHistory(record.history, history) ? { ...record, history: null } : undefined),
    getGenerations: () => transact(GENERATION_STORE, "readonly", tx => tx.objectStore(GENERATION_STORE).getAll()).then(value => value ?? []),
    deleteGeneration: id => transact(GENERATION_STORE, "readwrite", tx => tx.objectStore(GENERATION_STORE).delete(id)),
    missingTileIds: async ids => { const db = await database(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(TILE_STORE, "readonly"); const store = transaction.objectStore(TILE_STORE); const missing = [];
      for ( const id of ids ) { if ( id === TRANSPARENT_ID ) continue; const request = store.getKey(id); request.onsuccess = () => { if ( request.result === undefined ) missing.push(id); }; }
      transaction.oncomplete = () => resolve(missing); transaction.onerror = () => reject(transaction.error);
    }); },
    putTiles: versions => transact(TILE_STORE, "readwrite", tx => { const store = tx.objectStore(TILE_STORE); for ( const version of versions ) store.put(version); }),
    getTiles: async ids => { const db = await database(); return new Promise((resolve, reject) => {
      const transaction = db.transaction(TILE_STORE, "readonly"); const store = transaction.objectStore(TILE_STORE); const values = [];
      for ( const id of ids ) { if ( id === TRANSPARENT_ID ) continue; const request = store.get(id); request.onsuccess = () => { if ( request.result ) values.push(request.result); }; }
      transaction.oncomplete = () => resolve(values); transaction.onerror = () => reject(transaction.error);
    }); },
    getAllTiles: () => transact(TILE_STORE, "readonly", tx => tx.objectStore(TILE_STORE).getAll()).then(value => value ?? []),
    deleteTiles: ids => transact(TILE_STORE, "readwrite", tx => { const store = tx.objectStore(TILE_STORE); for ( const id of ids ) store.delete(id); }),
    collectGarbage: () => transact([GENERATION_STORE, TILE_STORE], "readwrite", tx => {
      // Taking the reference snapshot and deleting orphans share a transaction.
      // Concurrent writers cannot publish staging pins between these operations.
      const records = tx.objectStore(GENERATION_STORE).getAll();
      records.onsuccess = () => {
        const retained = retainedTileIds(records.result);
        const cursor = tx.objectStore(TILE_STORE).openCursor();
        cursor.onsuccess = () => {
          const value = cursor.result;
          if ( !value ) return;
          if ( !retained.has(value.key) ) value.delete();
          value.continue();
        };
      };
    }),
    close: async () => (await database()).close()
  };
}

export const recoveryStore = createRecoveryStore();

async function writeMissingTiles(adapter, ids, versions, yieldTask, shouldContinue = () => true, renewLease = async () => {}) {
  const missing = await adapter.missingTileIds([...ids]); let written = 0;
  for ( let offset = 0; offset < missing.length; offset += TILE_BATCH_SIZE ) {
    if ( !shouldContinue() ) break;
    await renewLease();
    const batch = missing.slice(offset, offset + TILE_BATCH_SIZE).map(id => versions.get(id));
    if ( batch.some(value => !value) ) throw new Error("Recovery snapshot references a missing tile");
    await adapter.putTiles(batch); written += batch.length;
    if ( offset + TILE_BATCH_SIZE < missing.length ) await yieldTask();
  }
  return written;
}

async function discardGeneration(adapter, generationId) {
  try { await adapter.deleteGeneration(generationId); }
  finally { await garbageCollectTiles(adapter); }
}

async function hydrate(adapter, record, identity) {
  const ids = referencedIds(record); const versions = await adapter.getTiles([...ids]);
  const snapshot = clone({ ...record, versions }); validateSnapshot(snapshot, identity); return snapshot;
}

function artworkSnapshot(snapshot) { const ids = new Set(snapshot.current.map(([, id]) => id)); return { ...snapshot, cursor: 0, entries: [], versions: snapshot.versions.filter(version => ids.has(version.id)) }; }
function withoutVersions(snapshot) { const { versions: _versions, ...value } = snapshot; return value; }
function referencedIds(snapshot) { const ids = new Set(snapshot?.current?.map(([, id]) => id) ?? []); for ( const entry of snapshot?.entries ?? [] ) for ( const [, id] of entry.changes ?? [] ) ids.add(id); ids.delete(TRANSPARENT_ID); return ids; }

async function enforceQuota(adapter, currentId, quotaBytes, now) {
  await garbageCollectTiles(adapter); let records = await adapter.getGenerations(); let total = await storedBytes(adapter, records);
  for ( const record of records.filter(value => value.generationId !== currentId).sort((a, b) => Number(a.savedAt) - Number(b.savedAt)) ) {
    if ( total <= quotaBytes ) break;
    // Eligibility is rechecked against the live record in the deletion transaction.
    // Active writers renew a bounded lease; abandoned writers become reclaimable.
    if ( !await adapter.evictGenerationIfExpired(record.generationId, now()) ) continue;
    await garbageCollectTiles(adapter); records = await adapter.getGenerations(); total = await storedBytes(adapter, records);
  }
  let current = records.find(value => value.generationId === currentId);
  if ( total > quotaBytes && current?.history ) { current = { ...current, history: null, stagingIds: [] }; if ( !await adapter.replaceGeneration(current) ) throw evictedGenerationError(); await garbageCollectTiles(adapter); }
  return current;
}
async function garbageCollectTiles(adapter) { await adapter.collectGarbage(); }
function retainedTileIds(records) { const retained = new Set(); for ( const record of records ) { for ( const id of record.stagingIds ?? [] ) retained.add(id); for ( const id of referencedIds(record.artwork) ) retained.add(id); for ( const id of referencedIds(record.history) ) retained.add(id); } return retained; }
async function storedBytes(adapter, records) { const tileBytes = (await adapter.getAllTiles()).reduce((sum, tile) => sum + versionBytes(tile), 0); return tileBytes + records.reduce((sum, record) => sum + JSON.stringify(record).length, 0); }
function versionBytes(version) { return version.kind === "rgba" ? version.data?.byteLength ?? 0 : version.kind === "uniform" ? 4 : 0; }

function validateSnapshot(snapshot, identity) {
  if ( snapshot?.schema !== 2 || snapshot.tileSize !== 128 || snapshot.actionLimit !== 25 || snapshot.width !== identity.width || snapshot.height !== identity.height
    || typeof snapshot.writerId !== "string" || !snapshot.writerId || !Array.isArray(snapshot.current) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.versions)
    || snapshot.entries.length > 25 || !Number.isInteger(snapshot.cursor) || snapshot.cursor < 0 || snapshot.cursor > snapshot.entries.length ) throw new Error("Invalid Recovery generation");
  const tileCount = Math.ceil(identity.width / 128) * Math.ceil(identity.height / 128); const versions = new Map(); let bytes = 0;
  for ( const version of snapshot.versions ) { if ( typeof version?.id !== "string" || !version.id.startsWith(`${snapshot.writerId}:`) || version.id === TRANSPARENT_ID || versions.has(version.id) ) throw new Error("Invalid Recovery tile version");
    if ( version.kind === "rgba" ) { if ( !(version.data instanceof Uint8ClampedArray) || !version.data.byteLength ) throw new Error("Invalid Recovery tile pixels"); bytes += version.data.byteLength; }
    else if ( version.kind === "uniform" ) { if ( !Array.isArray(version.rgba) || version.rgba.length !== 4 || version.rgba.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ) throw new Error("Invalid Recovery uniform tile"); bytes += 4; }
    else throw new Error("Invalid Recovery tile kind"); versions.set(version.id, version); }
  if ( bytes > Math.max(64 * 1024 * 1024, identity.width * identity.height * 8) ) throw new Error("Recovery exceeds its decoded pixel budget");
  const used = new Map(); const inspect = reference => { if ( !Array.isArray(reference) || reference.length !== 2 ) throw new Error("Invalid Recovery tile reference"); const [tile, id] = reference;
    if ( !Number.isSafeInteger(tile) || tile < 0 || tile >= tileCount || (id !== TRANSPARENT_ID && !versions.has(id)) ) throw new Error("Invalid Recovery tile reference");
    const version = versions.get(id); if ( version?.kind === "rgba" ) { const columns = Math.ceil(identity.width / 128); const tx = tile % columns; const ty = Math.floor(tile / columns); const expected = Math.min(128, identity.width - tx * 128) * Math.min(128, identity.height - ty * 128) * 4; if ( version.data.byteLength !== expected ) throw new Error("Recovery tile length does not match its coordinate"); }
    const prior = used.get(id); if ( prior !== undefined && version?.kind === "rgba" && prior !== version.data.byteLength ) throw new Error("Recovery tile has inconsistent geometry"); used.set(id, version?.data?.byteLength ?? 0); return tile; };
  const current = new Set(); for ( const ref of snapshot.current ) { const tile = inspect(ref); if ( ref[1] === TRANSPARENT_ID || current.has(tile) ) throw new Error("Invalid Recovery current map"); current.add(tile); }
  for ( const entry of snapshot.entries ) { if ( typeof entry?.id !== "string" || !entry.id || typeof entry.kind !== "string" || !entry.kind || !Array.isArray(entry.changes) || !entry.changes.length ) throw new Error("Invalid Recovery history entry"); const changed = new Set(); for ( const ref of entry.changes ) { const tile = inspect(ref); if ( changed.has(tile) ) throw new Error("Duplicate Recovery action tile"); changed.add(tile); } }
}

function normalizeIdentity(identity, { assignmentOptional = false, dimensionsOptional = false } = {}) { return Object.freeze({ worldId: requiredText(identity?.worldId), gmUserId: requiredText(identity?.gmUserId), userId: requiredText(identity?.userId), promptId: requiredText(identity?.promptId), assignmentId: assignmentOptional ? optionalText(identity?.assignmentId) : requiredText(identity?.assignmentId), width: dimensionsOptional ? optionalPositiveInteger(identity?.width) : positiveInteger(identity?.width), height: dimensionsOptional ? optionalPositiveInteger(identity?.height) : positiveInteger(identity?.height) }); }
function sameIdentity(left, right) { return ["worldId", "gmUserId", "userId", "promptId", "assignmentId", "width", "height"].every(field => left?.[field] === right[field]); }
function keyForIdentity(value) { return [value.worldId, value.gmUserId, value.userId, value.promptId, value.assignmentId, value.width, value.height].join("\u001f"); }
function keyForPrompt(value) { return [value.worldId, value.gmUserId, value.userId, value.promptId].join("\u001f"); }
function requiredText(value) { const text = optionalText(value); if ( !text ) throw new Error("Invalid Recovery identity"); return text; }
function optionalText(value) { return typeof value === "string" && value.trim() && !/\s/.test(value) ? value : null; }
function positiveInteger(value) { const number = optionalPositiveInteger(value); if ( !number ) throw new Error("Invalid Recovery dimensions"); return number; }
function optionalPositiveInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function clone(value) { return structuredClone(value); }
function defaultYieldTask() { return new Promise(resolve => globalThis.setTimeout(resolve, 0)); }
function evictedGenerationError() { return new Error("Recovery generation was evicted before its save completed"); }
function sameHistory(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
