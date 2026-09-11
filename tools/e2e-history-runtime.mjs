/* Real-browser gate for bounded tile history and IndexedDB Recovery. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE_URL = process.env.FOUNDRY_URL || "http://localhost:30000";
const PLAYER_USER = process.env.PLAYER_USER || "Player2";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => {
  if ( message.type() === "error" && !/requires a screen resolution of/i.test(message.text()) ) errors.push(message.text());
});

try {
  await joinWorld(page, PLAYER_USER);
  const results = await page.evaluate(async () => {
    const [{ DrawingEngine }, { createIndexedDbRecoveryAdapter, createRecoveryStore, recoveryStore }] = await Promise.all([
      import("/modules/drawing-prompts/scripts/drawing/drawing-engine.mjs"),
      import("/modules/drawing-prompts/scripts/drawing/recovery-store.mjs")
    ]);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const dimensions = [2048, 4096];
    const timings = [];
    const baselineStart = performance.now();
    await frame();
    const frameDelayMs = performance.now() - baselineStart;
    for ( const size of dimensions ) {
      const engine = new DrawingEngine({ width: size, height: size });
      engine.setBrushSize(12);
      const points = [];
      const tiles = size / 128;
      for ( let row = 0; row < tiles; row++ ) {
        const columns = Array.from({ length: tiles }, (_, index) => row % 2 ? tiles - index - 1 : index);
        for ( const column of columns ) points.push({ x: column * 128 + 64, y: row * 128 + 64 });
      }
      engine.beginStroke("stroke", points[0]);
      let maxRenderTaskMs = 0;
      for ( let index = 1; index < points.length; index += 16 ) {
        const taskStart = performance.now();
        for ( const point of points.slice(index, index + 16) ) engine.extendStroke(point);
        await Promise.resolve();
        maxRenderTaskMs = Math.max(maxRenderTaskMs, performance.now() - taskStart);
        await frame();
      }
      await frame();
      const pointerStart = performance.now();
      engine.commitStroke(points.at(-1));
      const pointerUpMs = performance.now() - pointerStart;
      let visibleAt = null;
      const inputStart = performance.now();
      const unsubscribe = engine.onChange(() => { visibleAt ??= performance.now(); });
      engine.beginStroke("stroke", { x: 10, y: 10 });
      const beginSyncMs = performance.now() - inputStart;
      engine.extendStroke({ x: 30, y: 30 });
      await frame();
      unsubscribe();
      engine.commitStroke({ x: 30, y: 30 });
      timings.push({ size, pointerUpMs, beginSyncMs, nextVisibleMs: visibleAt - inputStart, maxRenderTaskMs, frameDelayMs, bytes: engine.recoveryBytes });
      if ( !engine.canUndo ) throw new Error(`${size} drawing did not create Undo history`);
      engine.destroy();
    }

    const dbName = `drawing-prompts-e2e-${Date.now()}`;
    const adapter = createIndexedDbRecoveryAdapter(indexedDB, { dbName });
    const store = createRecoveryStore({ adapter, writerId: "runtime-tab" });
    const identity = { worldId: game.world.id, gmUserId: "gm", userId: game.user.id, promptId: "runtime", assignmentId: "runtime-a", width: 1, height: 1 };
    const snapshot = {
      schema: 2, width: 1, height: 1, tileSize: 128, actionLimit: 25, writerId: "runtime-history", cursor: 1,
      current: [[0, "runtime-history:1"]],
      versions: [{ id: "runtime-history:1", kind: "uniform", rgba: [9, 8, 7, 255] }],
      entries: [{ id: "a1", kind: "stroke", color: "#090807", changes: [[0, "transparent"]] }]
    };
    await store.save(identity, snapshot);
    const recovered = await store.load(identity);
    await store.clear(identity);
    await store.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const reloadIdentity = { ...identity, promptId: `runtime-reload-${Date.now()}`, assignmentId: `runtime-reload-${Date.now()}` };
    await recoveryStore.save(reloadIdentity, snapshot);
    await recoveryStore.close();
    return { timings, recoveredKind: recovered?.kind, recoveredCursor: recovered?.snapshot?.cursor, reloadIdentity };
  });

  assert.equal(results.recoveredKind, "history");
  assert.equal(results.recoveredCursor, 1);
  console.log(`e2e-history-runtime measurements ${JSON.stringify(results.timings)}`);
  for ( const timing of results.timings ) {
    assert.ok(timing.pointerUpMs < 8, `${timing.size} pointer-up history work was ${timing.pointerUpMs.toFixed(2)}ms`);
    assert.ok(timing.nextVisibleMs < 50, `${timing.size} next-stroke feedback was ${timing.nextVisibleMs.toFixed(2)}ms`);
    assert.ok(timing.maxRenderTaskMs < 50, `${timing.size} gesture render task was ${timing.maxRenderTaskMs.toFixed(2)}ms`);
  }
  assert.deepEqual(errors, []);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 30000 });
  const reloaded = await page.evaluate(async identity => {
    const { recoveryStore } = await import("/modules/drawing-prompts/scripts/drawing/recovery-store.mjs");
    const value = await recoveryStore.load(identity);
    await recoveryStore.clear(identity);
    return { kind: value?.kind, cursor: value?.snapshot?.cursor };
  }, results.reloadIdentity);
  assert.deepEqual(reloaded, { kind: "history", cursor: 1 });
  console.log(`e2e-history-runtime: PASS ${JSON.stringify(results.timings)}`);
} finally {
  await browser.close();
}

async function joinWorld(page, userName) {
  await page.goto(`${BASE_URL}/join`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const select = page.locator("select[name='userid'], select[name='user'], select#userid").first();
  await select.waitFor({ state: "visible", timeout: 15000 });
  await select.selectOption({ label: userName });
  const password = page.locator("input[type='password']").first();
  if ( await password.count() ) await password.fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit'], button:has-text('Join'), button:has-text('Log In')").first().click();
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 30000 });
}
