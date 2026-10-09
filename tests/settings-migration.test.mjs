import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

globalThis.foundry = { applications: { api: {
  ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base
} } };
const { FIT_MODE, INTERNAL, MODULE_ID, SETTINGS } = await import("../scripts/constants.mjs");
const { migrateLegacySettings } = await import("../scripts/settings.mjs");
const fullKey = `${MODULE_ID}.${SETTINGS.DEFAULT_FIT_MODE}`;
let values, stored, writes;

beforeEach(() => {
  values = new Map([[SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_WIDTH]]);
  stored = new Map();
  writes = [];
  globalThis.game = { user: { isGM: true }, settings: {
    get: (_module, key) => values.get(key),
    storage: new Map([["world", { getItem: key => stored.get(key) ?? null }]]),
    set: async (_module, key, value) => {
      writes.push([key, value]);
      values.set(key, value);
      stored.set(`${MODULE_ID}.${key}`, JSON.stringify(value));
    }
  } };
});

test("explicit world Fit Width survives migration and repeated startup", async () => {
  stored.set(fullKey, JSON.stringify(FIT_MODE.FIT_WIDTH));
  await migrateLegacySettings();
  await migrateLegacySettings();
  assert.equal(values.get(SETTINGS.DEFAULT_FIT_MODE), FIT_MODE.FIT_WIDTH);
  assert.deepEqual(writes, [[INTERNAL.LEGACY_FIT_MODE_MIGRATED, true]]);
});

test("an inherited obsolete default migrates once to Fit Canvas", async () => {
  await migrateLegacySettings();
  await migrateLegacySettings();
  assert.deepEqual(writes, [[SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_CANVAS], [INTERNAL.LEGACY_FIT_MODE_MIGRATED, true]]);
});

test("a world already inheriting the new default only records completion", async () => {
  values.set(SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_CANVAS);
  await migrateLegacySettings();
  assert.deepEqual(writes, [[INTERNAL.LEGACY_FIT_MODE_MIGRATED, true]]);
});

test("player startup never writes world settings", async () => {
  game.user.isGM = false;
  await migrateLegacySettings();
  assert.deepEqual(writes, []);
});

test("unavailable explicit-setting storage defers migration without overwriting preferences", async () => {
  game.settings.storage.clear();
  await migrateLegacySettings();
  assert.deepEqual(writes, []);
  assert.equal(values.get(SETTINGS.DEFAULT_FIT_MODE), FIT_MODE.FIT_WIDTH);
});
