import assert from "node:assert/strict";
import { test } from "node:test";

import { createMapRecoveryAdapter, createRecoveryStore } from "../scripts/drawing/recovery-store.mjs";

const identity = Object.freeze({
  worldId: "world", gmUserId: "gm", userId: "player", promptId: "prompt", assignmentId: "assignment", width: 1, height: 1
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
  let puts = 0;
  const adapter = { ...base, putGeneration: async value => {
    puts++;
    if ( puts === 3 ) throw new Error("history interrupted");
    return base.putGeneration(value);
  } };
  const store = createRecoveryStore({ adapter, writerId: "tab-a", now: () => 10 });

  const result = await store.save(identity, generationSnapshot());
  assert.equal(result.historySaved, false);
  const loaded = await store.load(identity);
  assert.equal(loaded.kind, "artwork");
  assert.equal(loaded.snapshot.entries.length, 0);
  assert.equal(loaded.snapshot.current.length, 1);
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
