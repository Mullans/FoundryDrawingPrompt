/** SCR-57 real Place dialog + persisted Tile/Token reconciliation. Requires running Foundry. */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.FOUNDRY_URL || "http://localhost:30000";
const RUN = `PlacementRace-${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
const errors = [];
const watchdog = setTimeout(() => { console.error("Placement race harness exceeded 180 seconds"); process.exitCode = 1; void browser.close(); }, 180_000);
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if ( message.type() === "error" ) errors.push(message.text()); });
const wait = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 20_000 });
let stages = [];
const stage = name => { stages.push({ name, at: Date.now() }); };

async function runCase(mode, order) {
  stages = [];
  try { await runCaseSteps(mode, order); }
  catch (error) {
    let timer;
    const diagnostics = await Promise.race([
      page.evaluate(() => {
        const f = globalThis.placementRace;
        const c = f?.case;
        const el = document.querySelector(".drawing-prompts-manager");
        const describeLayer = layer => ({ active: layer?.active,
          previews: layer?.preview?.children?.slice(0, 5).map(p => ({ destroyed: p.destroyed, x: p.x, y: p.y, id: p.document?.id })),
          controlled: layer?.controlled?.map(p => p.id),
          objects: layer?.placeables?.slice(0, 8).map(p => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h })) });
        return { canvasReady: canvas.ready, sceneId: canvas.scene?.id,
          activeLayer: canvas.activeLayer?.constructor?.name,
          mouse: canvas.mousePosition ? { x: canvas.mousePosition.x, y: canvas.mousePosition.y } : null,
          pointerdownListeners: canvas.stage?.listenerCount?.("pointerdown"),
          tiles: describeLayer(canvas.tiles), tokens: describeLayer(canvas.tokens),
          manager: { present: Boolean(el), display: el?.style.display, hiddenClass: el?.classList.contains("dp-canvas-yield-hidden") },
          case: c ? { kind: c.kind, order: c.order, entered: c.entered, created: c.created, finished: c.finished, calls: c.calls, timedOut: c.timedOut } : null };
      }).catch(reason => ({ diagnosticError: String(reason) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ diagnosticError: "snapshot exceeded 3 seconds" }), 3000); })
    ]);
    clearTimeout(timer);
    console.error("Placement case failed", JSON.stringify({ mode, order, stages, diagnostics, errors }));
    throw error;
  }
}

async function clickBoard() {
  const box = await page.locator("canvas#board").boundingBox();
  assert.ok(box, "canvas exists");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function runCaseSteps(mode, order) {
  const kind = mode === "tile" ? "Tile" : "Token";
  stage("prepare-original-scene-and-manager");
  await page.evaluate(async ({ kind, order, label }) => {
    const f = globalThis.placementRace;
    await game.scenes.get(f.scenes[0]).view();
    const scene = canvas.scene;
    const own = Object.getOwnPropertyDescriptor(scene, "createEmbeddedDocuments");
    const original = scene.createEmbeddedDocuments;
    f.restoreCreate?.();
    f.restoreCreate = () => { if ( own ) Object.defineProperty(scene, "createEmbeddedDocuments", own); else delete scene.createEmbeddedDocuments; };
    f.case = { kind, order, label, calls: 0, entered: false, createdIds: [], actorIds: [] };
    const c = f.case;
    scene.createEmbeddedDocuments = async function (type, data, ...args) {
      if ( type !== kind ) return original.call(this, type, data, ...args);
      c.calls++;
      c.entered = true;
      c.actorIds = data.map(d => d.actorId).filter(Boolean);
      f.actorIds.push(...c.actorIds);
      const gate = new Promise(resolve => { c.release = resolve; });
      // Bound the injected delay even if the browser-side assertion fails.
      const timer = setTimeout(() => { c.timedOut = true; c.release(); }, 20_000);
      try {
        if ( order === "abandon-first" || order === "reject" ) await gate;
        if ( order === "reject" ) throw new Error("PlacementRace intentional create rejection");
        const documents = await original.call(this, type, data, ...args);
        c.createdIds = documents.map(d => d.id);
        c.created = true;
        if ( order === "create-first" ) await gate;
        return documents;
      } finally { clearTimeout(timer); c.finished = true; }
    };
    const { DrawingPromptManager } = await import("/modules/drawing-prompts/scripts/apps/drawing-prompt-manager.mjs");
    await DrawingPromptManager.openPrompt(f.promptId);
    const manager = foundry.applications.instances.get("drawing-prompts-manager");
    manager.selectedAssignmentId = f.assignmentId;
    await manager.render({ parts: ["body"] });
    c.placementsBefore = manager.activePrompt.getAssignment(f.assignmentId).placements.length;
  }, { kind, order, label: `${RUN}-${mode}-${order}` });
  stage("open-place-dialog");
  await page.locator(".drawing-prompts-manager button[data-action='openPlaceDialog']").click();
  const dialog = page.locator("#drawing-prompts-place-dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator(`input[name='mode'][value='${mode}']`).check();
  await dialog.locator("input[name='name']").fill(`${RUN}-${mode}-${order}`);
  await dialog.locator("button[data-action='place']").click();
  stage("wait-manager-hidden-preview-present");
  await wait(() => {
    const el = document.querySelector(".drawing-prompts-manager");
    const layer = placementRace.case.kind === "Tile" ? canvas.tiles : canvas.tokens;
    return el?.style.display === "none" && layer.preview?.children?.length > 0;
  });
  stage("first-click");
  await clickBoard();
  stage("wait-create-entered");
  await wait(() => placementRace.case.entered);
  if ( order === "create-first" ) { stage("wait-document-created"); await wait(() => placementRace.case.created); }
  assert.equal(await page.evaluate(() => document.querySelector(".drawing-prompts-manager")?.style.display), "none", "manager waits for create settlement");
  stage("abandon-layer-and-scene");
  await page.evaluate(async () => {
    const f = placementRace;
    (f.case.kind === "Tile" ? canvas.tokens : canvas.tiles).activate();
    await game.scenes.get(f.scenes[1]).view();
  });
  stage("duplicate-click");
  await clickBoard();
  assert.equal(await page.evaluate(() => placementRace.case.calls), 1, "duplicate click cannot create again");
  assert.equal(await page.evaluate(() => document.querySelector(".drawing-prompts-manager")?.style.display), "none", "abandonment cannot report cancellation during create");
  stage("release-create-and-wait-manager-restored");
  await page.evaluate(() => placementRace.case.release());
  await wait(() => {
    const el = document.querySelector(".drawing-prompts-manager");
    return placementRace.case.finished && Boolean(el) && el.style.display !== "none" && !el.classList.contains("dp-canvas-yield-hidden");
  });
  stage("assert-records-and-actors");
  const result = await page.evaluate(() => {
    const f = placementRace;
    const c = f.case;
    const assignment = game.journal.get(f.promptId).getFlag("drawing-prompts", "prompt").assignments[f.assignmentId];
    const records = assignment.placements.slice(c.placementsBefore);
    const collection = c.kind === "Tile" ? "tiles" : "tokens";
    const original = game.scenes.get(f.scenes[0]);
    const other = game.scenes.get(f.scenes[1]);
    const documents = c.createdIds.map(id => original[collection].get(id)?.toObject());
    return { calls: c.calls, timedOut: Boolean(c.timedOut), records, documents,
      newSceneCount: other[collection].size, actorIds: c.actorIds,
      actorsRetained: c.actorIds.every(id => game.actors.has(id)), actorsRemoved: c.actorIds.every(id => !game.actors.has(id)), sceneId: original.id };
  });
  assert.equal(result.timedOut, false, "test gate did not expire");
  assert.equal(result.calls, 1);
  assert.equal(result.newSceneCount, 0, "no creation redirected to new scene");
  if ( order === "reject" ) {
    assert.equal(result.records.length, 0);
    assert.equal(result.actorIds.length, 1, "New Actor existed before rejected Token creation");
    assert.equal(result.actorsRemoved, true, "failed placement removes only its temporary Actor");
  } else {
    assert.equal(result.records.length, 1);
    assert.equal(result.documents.length, 1);
    assert.ok(result.documents[0], "document exists on original scene");
    const record = result.records[0];
    assert.equal(record.sceneId, result.sceneId);
    assert.equal(record[kind === "Tile" ? "tileId" : "tokenId"], result.documents[0]._id);
    if ( kind === "Token" ) {
      assert.equal(result.actorIds.length, 1);
      assert.equal(result.actorsRetained, true);
      assert.equal(record.actorId, result.documents[0].actorId);
      assert.equal(record.actorId, result.actorIds[0]);
    }
  }
  await page.evaluate(async () => {
    const f = placementRace;
    f.restoreCreate();
    f.restoreCreate = null;
    // Assertions above already proved the committed documents and records agree.
    // Clear only this case's documents so a previous Token cannot intercept the
    // next case's deliberately identical click location before it reaches the stage.
    if ( f.case.createdIds.length ) await game.scenes.get(f.scenes[0]).deleteEmbeddedDocuments(f.case.kind, f.case.createdIds);
  });
  console.log(`PASS ${mode}: ${order}`);
}

try {
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  await page.locator("select[name='userid'], select[name='user'], select#userid").first().selectOption({ label: process.env.GM_USER || "Gamemaster" });
  const password = page.locator("input[type='password']").first();
  if ( await password.count() ) await password.fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit']").first().click();
  await wait(() => globalThis.game?.ready);
  await page.evaluate(async name => {
    const f = globalThis.placementRace = { scenes: [], actorIds: [], originalScene: canvas.scene?.id };
    f.actorHook = Hooks.on("createActor", actor => { if ( actor.name === f.case?.label ) f.actorIds.push(actor.id); });
    f.userId = (await User.create({ name, role: CONST.USER_ROLES.PLAYER })).id;
    for ( const suffix of ["original", "other"] ) {
      f.scenes.push((await Scene.create({ name: `${name}-${suffix}`, width: 1500, height: 1000, grid: { size: 100 } })).id);
    }
    const { DrawingPrompt } = await import("/modules/drawing-prompts/scripts/prompts/prompt-models.mjs");
    const { createPromptEntry, savePrompt } = await import("/modules/drawing-prompts/scripts/prompts/persistence-service.mjs");
    const prompt = DrawingPrompt.create({ gmUserId: game.user.id, promptText: name, promptName: name, canvasWidth: 256, canvasHeight: 256, sentAt: Date.now() }, [f.userId]);
    await createPromptEntry(prompt);
    f.promptId = prompt.id;
    const assignment = Object.values(prompt.assignments)[0];
    f.assignmentId = assignment.id;
    assignment.status = "submitted";
    assignment.delivery.status = "received";
    assignment.delivery.receivedAt = Date.now();
    assignment.submittedAt = assignment.savedSubmissionTs = Date.now();
    Object.assign(assignment.assets, { mergedPath: "icons/svg/mystery-man.svg", tileWidth: 256, tileHeight: 256 });
    await savePrompt(prompt);
  }, RUN);
  for ( const mode of ["tile", "newActor"] ) {
    for ( const order of ["abandon-first", "create-first"] ) await runCase(mode, order);
  }
  await runCase("newActor", "reject");
  assert.deepEqual(errors, [], "no page or console errors (intentional rejection may log a warning)");
  console.log("e2e-placement-race: PASS (Tile/Token race orders, original scene records, manager restoration, Actor retention/cleanup)");
} finally {
  await page.evaluate(async () => {
    const f = globalThis.placementRace;
    if ( !f ) return;
    f.case?.release?.();
    f.restoreCreate?.();
    // Allow the operation to settle before removing its fixture documents.
    const deadline = Date.now() + 20_000;
    while ( f.case?.entered && (!f.case.finished || document.querySelector(".drawing-prompts-manager")?.style.display === "none") && Date.now() < deadline ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if ( Date.now() >= deadline ) throw new Error("Placement operation did not settle; fixture cleanup deferred");
    Hooks.off("createActor", f.actorHook);
    await foundry.applications.instances.get("drawing-prompts-manager")?.close();
    if ( f.originalScene && game.scenes.has(f.originalScene) ) await game.scenes.get(f.originalScene).view();
    else if ( canvas.scene && f.scenes.includes(canvas.scene.id) ) await canvas.tearDown();
    for ( const id of f.scenes ) await game.scenes.get(id)?.delete();
    for ( const id of new Set(f.actorIds) ) await game.actors.get(id)?.delete();
    await game.journal.get(f.promptId)?.delete();
    await game.users.get(f.userId)?.delete();
  }).catch(error => { console.error("Placement fixture cleanup failed", error); process.exitCode = 1; });
  clearTimeout(watchdog);
  await browser.close();
}
