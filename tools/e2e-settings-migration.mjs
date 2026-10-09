/** Verify SCR-61 against real WorldSettings, restoring original values and absence. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.setDefaultTimeout(15000);
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if ( message.type() === "error" ) errors.push(message.text()); });
try {
  await page.goto(`${process.env.FOUNDRY_URL || "http://localhost:30000"}/join`);
  await page.locator("select[name='userid']").selectOption({ label: process.env.GM_USER || "Gamemaster" });
  await page.locator("input[name='password']").fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit']").first().click();
  await page.waitForFunction(() => globalThis.game?.ready);
  const result = await page.evaluate(async () => {
    const { MODULE_ID, SETTINGS, INTERNAL, FIT_MODE } = await import("/modules/drawing-prompts/scripts/constants.mjs");
    const { migrateLegacySettings } = await import("/modules/drawing-prompts/scripts/settings.mjs");
    const storage = game.settings.storage.get("world");
    const keys = [SETTINGS.DEFAULT_FIT_MODE, INTERNAL.LEGACY_FIT_MODE_MIGRATED];
    const originals = keys.map(key => ({ key, document: storage.getSetting(`${MODULE_ID}.${key}`)?.toObject() ?? null }));
    try {
      await game.settings.set(MODULE_ID, SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_WIDTH);
      await game.settings.set(MODULE_ID, INTERNAL.LEGACY_FIT_MODE_MIGRATED, false);
      await migrateLegacySettings();
      await migrateLegacySettings();
      const explicit = game.settings.get(MODULE_ID, SETTINGS.DEFAULT_FIT_MODE);
      const explicitStored = storage.getItem(`${MODULE_ID}.${SETTINGS.DEFAULT_FIT_MODE}`);
      await storage.getSetting(`${MODULE_ID}.${SETTINGS.DEFAULT_FIT_MODE}`).delete();
      await game.settings.set(MODULE_ID, INTERNAL.LEGACY_FIT_MODE_MIGRATED, false);
      await migrateLegacySettings();
      return { explicit, explicitStored, inherited: game.settings.get(MODULE_ID, SETTINGS.DEFAULT_FIT_MODE),
        inheritedStored: storage.getItem(`${MODULE_ID}.${SETTINGS.DEFAULT_FIT_MODE}`),
        migrated: game.settings.get(MODULE_ID, INTERNAL.LEGACY_FIT_MODE_MIGRATED) };
    } finally {
      for ( const { key, document } of originals ) {
        const current = storage.getSetting(`${MODULE_ID}.${key}`);
        if ( document ) {
          if ( current ) await current.update({ value: document.value });
          else await Setting.create(document, { keepId: true });
        } else if ( current ) await current.delete();
      }
    }
  });
  assert.deepEqual(result, { explicit: "fit-width", explicitStored: "fit-width", inherited: "fit-canvas",
    inheritedStored: null, migrated: true });
  assert.deepEqual(errors, []);
  console.log("e2e-settings-migration: PASS (explicit choice, inherited default, idempotence; originals restored)");
} finally {
  await browser.close();
}
