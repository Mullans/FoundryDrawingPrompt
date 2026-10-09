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
    const [{ DrawingEngine }, { createIndexedDbRecoveryAdapter, createRecoveryStore, recoveryStore }, { createRecoverySaveCoordinator }] = await Promise.all([
      import("/modules/drawing-prompts/scripts/drawing/drawing-engine.mjs"),
      import("/modules/drawing-prompts/scripts/drawing/recovery-store.mjs"),
      import("/modules/drawing-prompts/scripts/drawing/recovery-save-coordinator.mjs")
    ]);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    // Compare incremental clipped rendering against a one-pass native canvas.
    // Recovery tiles preserve exact RGBA; the unit FakeContext cannot exercise clip().
    const size = { width: 512, height: 384 };
    const pixelEngine = new DrawingEngine(size);
    pixelEngine.setColor("#000000");
    pixelEngine.setBrushSize(27);
    pixelEngine.setBrushOpacity(1);
    const points = [{ x: 25, y: 64 }, { x: 150, y: 64 }, { x: 270, y: 64 }, { x: 470, y: 64 }];
    const linePoints = [{ x: 25, y: 64 }, { x: 150, y: 64 }, { x: 150, y: 280 }, { x: 470, y: 280 }];
    const readPixels = () => {
      const snapshot = pixelEngine.getRecoverySnapshot();
      const versions = new Map(snapshot.versions.map(version => [version.id, version]));
      const pixels = new Uint8ClampedArray(size.width * size.height * 4);
      for ( const [tile, id] of snapshot.current ) {
        const version = versions.get(id);
        const x = tile % 4 * 128, y = Math.floor(tile / 4) * 128;
        for ( let row = 0; row < 128; row++ ) for ( let column = 0; column < 128; column++ ) {
          const offset = ((y + row) * size.width + x + column) * 4;
          const data = version.kind === "uniform" ? version.rgba : version.data.subarray((row * 128 + column) * 4, (row * 128 + column) * 4 + 4);
          pixels.set(data, offset);
        }
      }
      return pixels;
    };
    const equalPixels = (actual, expected, label) => {
      const index = actual.findIndex((byte, index) => byte !== expected[index]);
      if ( index !== -1 ) {
        const offset = index - index % 4;
        throw new Error(`${label}: RGBA mismatch at byte ${index}: ${[...actual.slice(offset, offset + 4)]} != ${[...expected.slice(offset, offset + 4)]}`);
      }
    };
    const nativePixels = (actual, expected, label) => {
      // Native clipped rendering quantizes antialiased edges differently. Compare
      // exact stable interiors and untouched exterior at least two pixels away.
      let checked = 0;
      for ( let y = 2; y < size.height - 2; y++ ) for ( let x = 2; x < size.width - 2; x++ ) {
        const offset = (y * size.width + x) * 4, alpha = expected[offset + 3];
        if ( alpha !== 0 && alpha !== 255 ) continue;
        let stable = true;
        for ( let dy = -2; dy <= 2; dy++ ) for ( let dx = -2; dx <= 2; dx++ ) {
          if ( expected[((y + dy) * size.width + x + dx) * 4 + 3] !== alpha ) stable = false;
        }
        if ( !stable ) continue;
        checked++;
        equalPixels(actual.subarray(offset, offset + 4), expected.subarray(offset, offset + 4), label + offset);
      }
      if ( checked < 1000 ) throw new Error(label + ' insufficient stable pixel coverage');
    };
    const reference = document.createElement("canvas");
    reference.width = size.width; reference.height = size.height;
    const ctx = reference.getContext("2d", { willReadFrequently: true });
    ctx.strokeStyle = "#000000"; ctx.lineWidth = 27; ctx.globalAlpha = 1;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for ( let index = 1; index < points.length - 1; index++ ) {
      ctx.quadraticCurveTo(points[index].x, points[index].y,
        (points[index].x + points[index + 1].x) / 2, (points[index].y + points[index + 1].y) / 2);
    }
    ctx.lineTo(points.at(-1).x, points.at(-1).y); ctx.stroke();
    pixelEngine.beginStroke("stroke", points[0]); await frame();
    for ( const point of points.slice(1) ) { pixelEngine.extendStroke(point); await frame(); }
    pixelEngine.commitStroke(points.at(-1));
    const committedPixels = await readPixels();
    nativePixels(committedPixels, ctx.getImageData(0, 0, size.width, size.height).data, "multi-tile brush");
    pixelEngine.previewPolyline(linePoints.slice(0, 2)); await frame();
    pixelEngine.previewPolyline(linePoints.slice(0, 3)); await frame();
    pixelEngine.previewPolyline(linePoints); await frame();
    pixelEngine.cancelStrokePreview();
    equalPixels(await readPixels(), committedPixels, "cancel multi-tile line preview");
    // A first preview may contain several points (public engine API).
    pixelEngine.previewPolyline(linePoints); await frame();
    pixelEngine.commitStrokePreview();
    const linePixels = await readPixels();
    ctx.beginPath(); ctx.moveTo(linePoints[0].x, linePoints[0].y);
    for ( const point of linePoints.slice(1) ) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    nativePixels(linePixels, ctx.getImageData(0, 0, size.width, size.height).data, "multi-tile line");
    pixelEngine.undo(); equalPixels(await readPixels(), committedPixels, "line Undo");
    pixelEngine.redo(); equalPixels(await readPixels(), linePixels, "line Redo");
    pixelEngine.undo(); pixelEngine.undo();
    equalPixels(await readPixels(), new Uint8ClampedArray(size.width * size.height * 4), "brush Undo");
    pixelEngine.redo(); equalPixels(await readPixels(), committedPixels, "brush Redo");
    // Full curved/translucent layer comparisons use the engine's own lossless
    // baseline, avoiding native clipping antialias differences at path edges.
    const layer = () => pixelEngine.getOverlaySnapshot({ maxEdge: 512, type: "image/png" });
    const baselineLayer = layer();
    const curved = [{ x: 25, y: 25 }, { x: 150, y: 280 }, { x: 270, y: 35 }, { x: 470, y: 310 }];
    pixelEngine.setColor("#349ac8"); pixelEngine.setBrushOpacity(0.35);
    pixelEngine.beginStroke("stroke", curved[0]); await frame();
    for ( const point of curved.slice(1) ) { pixelEngine.extendStroke(point); await frame(); }
    pixelEngine.commitStroke(curved.at(-1));
    const curvedLayer = layer();
    if ( curvedLayer === baselineLayer ) throw new Error("curved stroke did not change foreground pixels");
    pixelEngine.previewPolyline(curved); await frame();
    pixelEngine.cancelStrokePreview();
    if ( layer() !== curvedLayer ) throw new Error("curved cancellation changed committed foreground pixels");
    pixelEngine.undo();
    if ( layer() !== baselineLayer ) throw new Error("curved Undo did not restore exact foreground pixels");
    pixelEngine.redo();
    if ( layer() !== curvedLayer ) throw new Error("curved Redo did not restore exact foreground pixels");
    pixelEngine.destroy();
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
    // Separate native IndexedDB connections must not evict another writer's
    // staged tiles, even when quota pressure occurs before publication resumes.
    const quotaAdapter = createIndexedDbRecoveryAdapter(indexedDB, { dbName });
    let releaseStaging;
    let signalStaging;
    const stagingBlocked = new Promise(resolve => { releaseStaging = resolve; });
    const atStaging = new Promise(resolve => { signalStaging = resolve; });
    const protectedIdentity = { ...identity, assignmentId: "runtime-protected" };
    const quotaIdentity = { ...identity, assignmentId: "runtime-quota" };
    const protectedStore = createRecoveryStore({ writerId: "runtime-protected", adapter: {
      ...adapter, async putTiles(versions) {
        await adapter.putTiles(versions);
        signalStaging();
        await stagingBlocked;
      }
    } });
    const quotaStore = createRecoveryStore({ adapter: quotaAdapter, writerId: "runtime-quota", quotaBytes: 1 });
    const protectedSnapshot = { ...snapshot, writerId: "protected-pixels", cursor: 0, entries: [],
      current: [[0, "protected-pixels:1"]],
      versions: [{ id: "protected-pixels:1", kind: "uniform", rgba: [9, 8, 7, 255] }] };
    const saving = protectedStore.save(protectedIdentity, protectedSnapshot, { artworkOnly: true });
    await atStaging;
    try {
      await quotaStore.save(quotaIdentity, { ...protectedSnapshot, writerId: "quota-pixels",
        current: [[0, "quota-pixels:1"]],
        versions: [{ id: "quota-pixels:1", kind: "uniform", rgba: [4, 5, 6, 255] }] }, { artworkOnly: true });
    } finally {
      releaseStaging();
      await quotaStore.close();
    }
    await saving;
    const protectedRecovery = await protectedStore.load(protectedIdentity);
    if ( protectedRecovery?.kind !== "artwork"
      || protectedRecovery.snapshot.versions[0]?.rgba[0] !== 9 ) {
      throw new Error("Native IndexedDB quota eviction corrupted an acknowledged staged save");
    }
    await protectedStore.clear(protectedIdentity);
    await store.clear(quotaIdentity);
    await store.clear(identity);
    await store.close();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const reloadIdentity = { ...identity, promptId: `runtime-reload-${Date.now()}`, assignmentId: `runtime-reload-${Date.now()}` };
    await recoveryStore.save(reloadIdentity, snapshot);
    const rapidReloadIdentity = { ...identity, promptId: `runtime-rapid-${Date.now()}`, assignmentId: `runtime-rapid-${Date.now()}` };
    await createRecoverySaveCoordinator({ store: recoveryStore }).changed(rapidReloadIdentity, snapshot);
    return { timings, recoveredKind: recovered?.kind, recoveredCursor: recovered?.snapshot?.cursor, reloadIdentity, rapidReloadIdentity };
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
  const reloaded = await page.evaluate(async ({ reloadIdentity, rapidReloadIdentity }) => {
    const { recoveryStore } = await import("/modules/drawing-prompts/scripts/drawing/recovery-store.mjs");
    const normal = await recoveryStore.load(reloadIdentity);
    const rapid = await recoveryStore.load(rapidReloadIdentity);
    await recoveryStore.clear(reloadIdentity);
    await recoveryStore.clear(rapidReloadIdentity);
    return {
      normal: { kind: normal?.kind, cursor: normal?.snapshot?.cursor },
      rapid: { kind: rapid?.kind, current: rapid?.snapshot?.current }
    };
  }, results);
  assert.deepEqual(reloaded.normal, { kind: "history", cursor: 1 });
  assert.deepEqual(reloaded.rapid.current, [[0, "runtime-history:1"]]);
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
