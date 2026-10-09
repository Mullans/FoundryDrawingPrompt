import assert from "node:assert/strict";
import { test } from "node:test";

import { createMapRecoveryAdapter, createRecoveryStore } from "../scripts/drawing/recovery-store.mjs";

const identity = Object.freeze({
  worldId: "world", gmUserId: "gm", userId: "player", promptId: "prompt", assignmentId: "assignment", width: 1, height: 1
});

test("garbage collection preserves a concurrently published staging pin", async () => {
  const base = createMapRecoveryAdapter();
  let reads = 0;
  let injected = false;
  const injectWriter = async () => {
    if ( injected ) return;
    injected = true;
    await base.putGeneration({ generationId: "other-writer", stagingIds: ["other:1"] });
    await base.putTiles([{ id: "other:1", kind: "uniform", rgba: [1, 2, 3, 255] }]);
  };
  const adapter = { ...base,
    async getGenerations() {
      const snapshot = await base.getGenerations();
      if ( ++reads === 2 ) await injectWriter();
      return snapshot;
    },
    ...(base.collectGarbage ? { async collectGarbage() {
      await injectWriter();
      await base.collectGarbage();
    } } : {})
  };
  const store = createRecoveryStore({ adapter });
  assert.equal(await store.load(identity), null);
  assert.equal((await base.getTiles(["other:1"])).length, 1);
});

test("Recovery publishes artwork before attaching coherent history", async () => {
  const adapter = createMapRecoveryAdapter();
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10 });
  const snapshot = generationSnapshot();

  await store.save(identity, snapshot);
  const loaded = await store.load(identity);
  assert.equal(loaded.kind, "history");
  assert.equal(loaded.snapshot.cursor, 1);
  assert.equal(loaded.snapshot.entries.length, 1);
});

test("Interrupted optional history publication leaves recoverable artwork without failing the save", async () => {
  const base = createMapRecoveryAdapter();
  let interrupted = false;
  const adapter = { ...base, replaceGeneration: async value => {
    if ( value.complete && value.stagingIds.length && !interrupted ) {
      interrupted = true;
      throw new Error("history interrupted");
    }
    return base.replaceGeneration(value);
  } };
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10 });

  const result = await store.save(identity, generationSnapshot());
  assert.equal(result.historySaved, false);
  const loaded = await store.load(identity);
  assert.equal(loaded.kind, "artwork");
  assert.equal(loaded.snapshot.entries.length, 0);
  assert.equal(loaded.snapshot.current.length, 1);
});

test("failed artwork staging removes its incomplete generation and orphan tiles", async () => {
  const base = createMapRecoveryAdapter();
  const adapter = { ...base, async putTiles() { throw new Error("primary batch interrupted"); } };
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10 });

  await assert.rejects(store.save(identity, generationSnapshot()), /primary batch interrupted/);
  assert.equal((await adapter.getGenerations()).length, 0);
  assert.equal((await adapter.getAllTiles()).length, 0);
});

test("a newer edit preempts optional history while preserving published artwork", async () => {
  const adapter = createMapRecoveryAdapter();
  let release;
  let yielded;
  const blocked = new Promise(resolve => { release = resolve; });
  const atHistoryYield = new Promise(resolve => { yielded = resolve; });
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10,
    yieldTask: async () => { yielded(); await blocked; } });
  const wideIdentity = { ...identity, width: 4352 };
  const snapshot = largeHistorySnapshot();

  const saving = store.save(wideIdentity, snapshot);
  await atHistoryYield;
  store.supersede(wideIdentity);
  release();

  assert.equal((await saving).stale, true);
  const loaded = await store.load(wideIdentity);
  assert.equal(loaded.kind, "artwork");
  assert.equal(loaded.snapshot.entries.length, 0);
});

test("Recovery records are isolated by complete identity and dimensions", async () => {
  const adapter = createMapRecoveryAdapter();
  const store = createRecoveryStore({ adapter, writerId: "tab-a" });
  await store.save(identity, generationSnapshot());

  assert.equal(await store.load({ ...identity, userId: "other" }), null);
  assert.equal(await store.load({ ...identity, width: 2 }), null);
});

test("clearPrompt removes every matching assignment generation only", async () => {
  const adapter = createMapRecoveryAdapter();
  const store = createRecoveryStore({ adapter, writerId: "tab-a" });
  await store.save(identity, generationSnapshot());
  await store.save({ ...identity, promptId: "sibling", assignmentId: "a2" }, generationSnapshot());

  await store.clearPrompt(identity);
  assert.equal(await store.load(identity), null);
  assert.notEqual(await store.load({ ...identity, promptId: "sibling", assignmentId: "a2" }), null);
});

test("quota pressure drops optional history before the current artwork", async () => {
  const adapter = createMapRecoveryAdapter();
  const store = createRecoveryStore({ adapter, writerId: "tab-a", quotaBytes: 3 });
  const result = await store.save(identity, generationSnapshot());

  assert.equal(result.historySaved, false);
  assert.equal((await store.load(identity)).kind, "artwork");
});

for ( const phase of ["artwork", "history"] ) {
  test(`quota eviction preserves a concurrent ${phase} staging writer`, async () => {
    const base = createMapRecoveryAdapter();
    const gate = deferred();
    const started = deferred();
    const snapshot = generationSnapshot();
    snapshot.versions.push({ id: "history-a:2", kind: "uniform", rgba: [6, 6, 6, 255] });
    snapshot.entries[0].changes = [[0, "history-a:2"]];
    const adapter = { ...base, async putTiles(versions) {
      await base.putTiles(versions);
      const matching = versions.some(value => value.id === `history-a:${phase === "artwork" ? 1 : 2}`);
      if ( matching ) { started.resolve(); await gate.promise; }
    } };
    const first = createRecoveryStore({ adapter, writerId: "tab-a" });
    const second = createRecoveryStore({ adapter: base, writerId: "tab-b", quotaBytes: 1 });
    const saving = first.save(identity, snapshot, { artworkOnly: phase === "artwork" });
    await started.promise;
    await second.save({ ...identity, promptId: "other", assignmentId: "other" }, generationSnapshot(9, "history-b"));
    gate.resolve();
    await saving;
    const restored = await first.load(identity);
    assert.equal(restored?.kind, phase === "artwork" ? "artwork" : "history");
    assert.equal(restored.snapshot.versions.find(value => value.id === "history-a:1").rgba[0], 7);
    if ( phase === "history" ) assert.equal(restored.snapshot.versions.find(value => value.id === "history-a:2").rgba[0], 6);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for ( const phase of ["artwork", "history"] ) {
  test(`an expired ${phase} writer is reclaimed and cannot resurrect its generation`, async () => {
    let time = 0;
    const base = createMapRecoveryAdapter();
    const gate = deferred();
    const started = deferred();
    const snapshot = generationSnapshot();
    snapshot.versions.push({ id: "history-a:2", kind: "uniform", rgba: [6, 6, 6, 255] });
    snapshot.entries[0].changes = [[0, "history-a:2"]];
    const adapter = { ...base, async putTiles(versions) {
      await base.putTiles(versions);
      if ( versions.some(value => value.id === `history-a:${phase === "artwork" ? 1 : 2}`) ) {
        started.resolve(); await gate.promise;
      }
    } };
    const first = createRecoveryStore({ adapter, writerId: "tab-a", now: () => time });
    const saving = first.save(identity, snapshot, { artworkOnly: phase === "artwork" });
    await started.promise;
    time = 60_001;
    const second = createRecoveryStore({ adapter: base, writerId: "tab-b", now: () => time, quotaBytes: 1 });
    await second.save({ ...identity, promptId: "other", assignmentId: "other" }, generationSnapshot(9, "history-b"));
    const rejected = assert.rejects(saving, /evicted before its save completed/);
    gate.resolve();
    await rejected;
    assert.equal(await first.load(identity), null);
    assert.equal((await base.getAllTiles()).some(value => value.id.startsWith("history-a:")), false);
  });
}

test("quota eviction rechecks a lease renewed after its candidate snapshot", async () => {
  const base = createMapRecoveryAdapter();
  const first = createRecoveryStore({ adapter: base, writerId: "tab-a", now: () => 0 });
  await first.save(identity, generationSnapshot(), { artworkOnly: true });
  let reads = 0;
  let renewed = false;
  const adapter = { ...base, async getGenerations() {
    const records = await base.getGenerations();
    if ( ++reads === 2 ) {
      const record = records.find(value => value.writerId === "tab-a");
      await base.replaceGeneration({ ...record, leaseUntil: 60_000, stagingIds: ["history-a:1"] });
      renewed = true;
    }
    return records;
  } };
  const second = createRecoveryStore({ adapter, writerId: "tab-b", now: () => 0, quotaBytes: 1 });
  await second.save({ ...identity, promptId: "other", assignmentId: "other" }, generationSnapshot(9, "history-b"));
  assert.equal(renewed, true);
  assert.equal((await first.load(identity))?.kind, "artwork");
});

test("an empty artwork generation is protected through publication and finalization", async () => {
  const base = createMapRecoveryAdapter();
  const gate = deferred();
  const started = deferred();
  const adapter = { ...base, async replaceGeneration(record) {
    const replaced = await base.replaceGeneration(record);
    if ( record.complete ) { started.resolve(); await gate.promise; }
    return replaced;
  } };
  const first = createRecoveryStore({ adapter, writerId: "tab-a" });
  const snapshot = { ...generationSnapshot(), current: [], entries: [], versions: [], cursor: 0 };
  const saving = first.save(identity, snapshot, { artworkOnly: true });
  await started.promise;
  const second = createRecoveryStore({ adapter: base, writerId: "tab-b", quotaBytes: 1 });
  await second.save({ ...identity, promptId: "other", assignmentId: "other" }, generationSnapshot(9, "history-b"));
  gate.resolve();
  await saving;
  assert.equal((await first.load(identity))?.kind, "artwork");
});

test("corrupt tile records are removed and never block artwork fallback", async () => {
  const records = new Map();
  const adapter = createMapRecoveryAdapter(records);
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10 });
  await store.save(identity, generationSnapshot(), { artworkOnly: true });
  const [key, record] = records.entries().next().value;
  record.artwork.current = [[9, "history-a:1"]];
  records.set(key, record);

  assert.equal(await store.load(identity), null);
  assert.equal(records.size, 0);
});

test("corrupt-history repair preserves a concurrently renewed lease and cannot resurrect eviction", async () => {
  const records = new Map();
  const base = createMapRecoveryAdapter(records);
  const writer = createRecoveryStore({ adapter: base, writerId: "tab-a", now: () => 0 });
  await writer.save(identity, generationSnapshot());
  const [id, record] = records.entries().next().value;
  record.history.current = [[9, "history-a:1"]];
  records.set(id, record);
  const gate = deferred();
  const started = deferred();
  let reads = 0;
  const adapter = { ...base, async getTiles(ids) {
    const tiles = await base.getTiles(ids);
    if ( ++reads === 1 ) { started.resolve(); await gate.promise; }
    return tiles;
  } };
  const reader = createRecoveryStore({ adapter, writerId: "tab-b", now: () => 0 });
  const loading = reader.load(identity);
  await started.promise;
  await base.replaceGeneration({ ...record, leaseUntil: 60_000, stagingIds: ["history-a:1"] });
  gate.resolve();
  assert.equal((await loading).kind, "artwork");
  const repaired = records.get(id);
  assert.equal(repaired.leaseUntil, 60_000);
  assert.deepEqual(repaired.stagingIds, ["history-a:1"]);
  await base.deleteGeneration(id);
  assert.equal(await base.clearHistoryIfMatches(id, record.history), false);
  assert.equal(records.has(id), false);
});

test("each tab prefers its own complete generation while a new tab chooses the newest", async () => {
  const adapter = createMapRecoveryAdapter();
  let time = 1;
  const tabA = createRecoveryStore({ adapter, writerId: "tab-a", now: () => time++ });
  const tabB = createRecoveryStore({ adapter, writerId: "tab-b", now: () => time++ });
  await tabA.save(identity, generationSnapshot(7, "history-a"), { artworkOnly: true });
  await tabB.save(identity, generationSnapshot(9, "history-b"), { artworkOnly: true });

  assert.equal((await tabA.load(identity)).snapshot.versions.at(-1).rgba[0], 7);
  assert.equal((await tabB.load(identity)).snapshot.versions.at(-1).rgba[0], 9);
  const reload = createRecoveryStore({ adapter, writerId: "tab-c", now: () => time++ });
  assert.equal((await reload.load(identity)).snapshot.versions.at(-1).rgba[0], 9);
});

test("consecutive generations reuse stable tile records", async () => {
  const adapter = createMapRecoveryAdapter();
  const store = createRecoveryStore({ adapter, writerId: "tab-a" });
  const snapshot = generationSnapshot();
  const first = await store.save(identity, snapshot);
  const second = await store.save(identity, snapshot);
  assert.equal(first.tilesWritten, 1);
  assert.equal(second.tilesWritten, 0);
});

test("a superseded writer cannot prune the newer generation returned by its cleanup read", async () => {
  const base = createMapRecoveryAdapter();
  const gate = deferred();
  const started = deferred();
  let trigger = true;
  let newer;
  let store;
  const next = generationSnapshot(9, "new-history");
  const adapter = { ...base,
    async putTiles(versions) {
      await base.putTiles(versions);
      if ( versions.some(value => value.id === "new-history:1") ) {
        started.resolve(); await gate.promise;
      }
    },
    async getGenerations() {
      if ( trigger ) {
        trigger = false;
        newer = store.save(identity, next, { artworkOnly: true });
        await started.promise;
      }
      return base.getGenerations();
    }
  };
  store = createRecoveryStore({ adapter, writerId: "tab-a" });
  const older = await store.save(identity, generationSnapshot(), { artworkOnly: true });
  gate.resolve();
  await newer;
  assert.equal(older.stale, true);
  const loaded = await store.load(identity);
  assert.equal(loaded.snapshot.versions.find(value => value.id === "new-history:1").rgba[0], 9);
});

test("deletion during a staged save prevents resurrection and removes orphan tiles", async () => {
  const base = createMapRecoveryAdapter();
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const adapter = { ...base, async putTiles(versions) { started(); await blocked; return base.putTiles(versions); } };
  const store = createRecoveryStore({ adapter, writerId: "tab-a" });

  const saving = store.save(identity, generationSnapshot());
  await startedPromise;
  await store.clear(identity);
  release();
  assert.equal((await saving).stale, true);
  assert.equal(await store.load(identity), null);
  assert.equal((await adapter.getAllTiles()).length, 0);
});

function generationSnapshot(value = 7, writerId = "history-a") {
  const version = { id: `${writerId}:1`, kind: "uniform", rgba: [value, value, value, 255] };
  return {
    schema: 2, width: 1, height: 1, tileSize: 128, actionLimit: 25, writerId, cursor: 1,
    current: [[0, version.id]], versions: [version],
    entries: [{ id: "action", kind: "stroke", color: "#070707", changes: [[0, "transparent"]] }]
  };
}

function largeHistorySnapshot() {
  const versions = Array.from({ length: 34 }, (_, index) => ({
    id: `history-a:${index + 1}`, kind: "uniform", rgba: [index, index, index, 255]
  }));
  return {
    schema: 2, width: 4352, height: 1, tileSize: 128, actionLimit: 25, writerId: "history-a", cursor: 1,
    current: [[0, versions[0].id]], versions,
    entries: [{ id: "action", kind: "stroke", changes: versions.slice(1).map((version, index) => [index + 1, version.id]) }]
  };
}
