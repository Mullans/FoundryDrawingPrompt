/** SCR-59/60 regression. Requires running local Foundry and socketlib.
 * Run PLAYWRIGHT_BROWSERS_PATH=0 node tools/e2e-reliability.mjs.
 * Creates one temporary player and two prompts; removes only its own records.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
let playwright;
try { playwright = createRequire(import.meta.url)("playwright"); }
catch { playwright = createRequire(new URL("../../../tools/package.json", import.meta.url))("playwright"); }
const browser = await playwright.chromium.launch({ headless: true });
const RUN = `ReliabilityE2E-${Date.now()}`;
const BASE_URL = process.env.FOUNDRY_URL || "http://localhost:30000";
const errors = [];
let userId;
let stage = "start";
const progress = text => { stage = text; console.log(`${RUN}: ${text}`); };
async function bounded(promise, label, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out at ${stage}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function page(label) {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (...args) => bounded(evaluate(...args), `${label} evaluate`);
  page.on("pageerror", e => errors.push(`${label}: ${e.message}`));
  page.on("console", e => { if ( e.type() === "error" ) errors.push(`${label}: ${e.text()}`); });
  return page;
}
const gm = await page("GM");
const player = await page("player");
async function join(page, name) {
  await page.goto(`${BASE_URL}/join`);
  await page.locator("select[name='userid']").selectOption({ label: name });
  await page.locator("input[name='password']").fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit']").first().click();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 30000 });
}
try {
  progress("join temporary drawing client");
  await join(gm, process.env.GM_USER || "Gamemaster");
  userId = await gm.evaluate(async name => (await User.create({ name, role: CONST.USER_ROLES.PLAYER, password: "" })).id, RUN);
  await join(player, RUN);
  await player.evaluate(async () => {
    const { DrawingEngine } = await import("/modules/drawing-prompts/scripts/drawing/drawing-engine.mjs");
    globalThis.reliabilityTest = { engines: new Map(), originalAttach: DrawingEngine.prototype.attach };
    DrawingEngine.prototype.attach = function (canvas) {
      const root = canvas.closest(".drawing-prompts-player");
      if ( root ) reliabilityTest.engines.set(root.id, this);
      return reliabilityTest.originalAttach.call(this, canvas);
    };
  });
  const assignments = [];
  for ( let i = 0; i < 2; i++ ) {
    assignments.push(await gm.evaluate(async ({ userId, text }) => {
      const prompt = await game.modules.get("drawing-prompts").api.createPrompt({
        promptText: text, drawingName: text, canvasWidth: 256, canvasHeight: 256,
        background: { sourceType: "blank" }, selectedUserIds: [userId], awaitDeliveries: true
      });
      return { promptId: prompt.id, assignmentId: Object.keys(prompt.assignments)[0] };
    }, { userId, text: `${RUN}-${i}` }));
  }
  await player.waitForFunction(() => reliabilityTest.engines.size === 2);
  const appIds = await player.evaluate(ids => ids.map((id, i) => {
    const app = [...foundry.applications.instances.values()].find(a => a.assignmentPayload?.assignment.id === id);
    app.setPosition({ left: 20 + 820 * i, top: 60, width: 780, height: 750 });
    return app.id;
  }), assignments.map(a => a.assignmentId));
  const roots = appIds.map(id => player.locator(`[id='${id}']`));
  const focus = async index => roots[index].locator(".dp-display-stage").focus();
  const tools = () => player.evaluate(ids => ids.map(id => document.getElementById(id).querySelector("[data-tool].is-active")?.dataset.tool), appIds);

  progress("focused tools and outside/text focus");
  await focus(0);
  await player.keyboard.press("e");
  assert.deepEqual(await tools(), ["eraser", "brush"]);
  await focus(1);
  await player.keyboard.press("l");
  assert.deepEqual(await tools(), ["eraser", "line"]);
  await roots[0].locator("input").first().focus();
  await player.keyboard.press("b");
  assert.deepEqual(await tools(), ["eraser", "line"]);
  // A real board click releases drawing focus even if Foundry retains activeWindow.
  await player.mouse.click(10, 900);
  await player.keyboard.press("f");
  assert.deepEqual(await tools(), ["eraser", "line"]);

  progress("Enter commits only the focused draft; Escape cancels only its owner");
  async function lineDraft(index) {
    await focus(index);
    await player.keyboard.press("l");
    const canvas = roots[index].locator(".dp-display-canvas");
    const box = await canvas.boundingBox();
    assert.ok(box);
    await player.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);
    await player.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.65);
  }
  const counts = () => player.evaluate(ids => ids.map(id => reliabilityTest.engines.get(id).getOpLog().ops.length), appIds);
  await lineDraft(0);
  await lineDraft(1);
  assert.deepEqual(await counts(), [0, 0]);
  await focus(0);
  await player.keyboard.press("Enter");
  assert.deepEqual(await counts(), [1, 0]);
  await focus(1);
  await player.keyboard.press("Escape");
  assert.deepEqual(await counts(), [1, 0]);
  assert.equal(await player.evaluate(id => reliabilityTest.engines.get(id).commitLineDraft(), appIds[1]), false);
  await focus(0);
  const spaceHandled = await player.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(spaceHandled, true);
  await player.keyboard.up("Space");
  await player.mouse.click(10, 900);
  const outsideHandled = await player.evaluate(() => {
    const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(outsideHandled, false);

  progress("successive oversized snapshots reach Full Framing");
  await gm.evaluate(async ({ promptId, assignmentId }) => {
    const { loadPrompt } = await import("/modules/drawing-prompts/scripts/prompts/persistence-service.mjs");
    const { FRAMING_VIEW } = await import("/modules/drawing-prompts/scripts/constants.mjs");
    await game.modules.get("drawing-prompts").api.openPromptManager();
    const manager = foundry.applications.instances.get("drawing-prompts-manager");
    manager.activePrompt = loadPrompt(promptId);
    // A local, unsaved source plate fixture avoids leaving files on the server.
    const source = document.createElement("canvas"); source.width = source.height = 256;
    manager.activePrompt.background = { sourceType: "file", path: source.toDataURL("image/png"), naturalWidth: 256, naturalHeight: 256, fitMode: "stretch" };
    manager.selectedAssignmentId = assignmentId;
    manager.framingView = FRAMING_VIEW.FULL;
    await manager.render({ parts: ["body"] });
  }, assignments[0]);
  let previousSrc = null;
  for ( const color of ["#ff0000", "#0000ff"] ) {
    const overlay = await player.evaluate(async ({ assignmentId, color }) => {
      const { DrawingEngine } = await import("/modules/drawing-prompts/scripts/drawing/drawing-engine.mjs");
      const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
      const { INTERNAL } = await import("/modules/drawing-prompts/scripts/constants.mjs");
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, 256, 256);
      const overlay = canvas.toDataURL("image/png");
      const originalComposite = DrawingEngine.prototype.getCompositeSnapshot;
      const originalOverlay = DrawingEngine.prototype.getOverlaySnapshot;
      try {
        DrawingEngine.prototype.getCompositeSnapshot = () => overlay.padEnd(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES, "A");
        DrawingEngine.prototype.getOverlaySnapshot = () => overlay;
        await PlayerDrawingApp.sendSnapshotForAssignment(assignmentId, { includeOverlay: true });
      } finally {
        DrawingEngine.prototype.getCompositeSnapshot = originalComposite;
        DrawingEngine.prototype.getOverlaySnapshot = originalOverlay;
      }
      return overlay;
    }, { assignmentId: assignments[0].assignmentId, color });
    await gm.waitForFunction(({ id, overlay, previousSrc, color }) => {
      const manager = foundry.applications.instances.get("drawing-prompts-manager");
      const image = manager.element.querySelector(".dp-preview-frame img");
      if ( manager.latestOverlaySnapshots.get(id) !== overlay || !image?.complete || !image.naturalWidth
        || image.src === previousSrc || !image.src.startsWith("data:image/") ) return false;
      const sample = document.createElement("canvas"); sample.width = sample.height = 1;
      const context = sample.getContext("2d"); context.drawImage(image, 0, 0, 1, 1);
      const [red, , blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha > 240 && (color === "#ff0000" ? red > 240 && blue < 15 : blue > 240 && red < 15);
    }, { id: assignments[0].assignmentId, overlay, previousSrc, color }, { timeout: 15000 });
    previousSrc = await gm.locator(".dp-preview-frame img").getAttribute("src");
  }
  assert.deepEqual(errors, []);
  progress("PASS: two-window shortcut ownership and successive Full Framing fallback");
} catch (error) {
  console.error(`e2e-reliability failed at ${stage}`, error, errors);
  process.exitCode = 1;
} finally {
  progress("cleanup only this run");
  await player.evaluate(async () => {
    if ( !globalThis.reliabilityTest ) return;
    const { DrawingEngine } = await import("/modules/drawing-prompts/scripts/drawing/drawing-engine.mjs");
    DrawingEngine.prototype.attach = reliabilityTest.originalAttach;
  }).catch(error => { console.error(error); process.exitCode = 1; });
  await gm.evaluate(async ({ prefix, userId }) => {
    if ( !globalThis.game?.ready ) return;
    const ids = game.journal.filter(e => e.getFlag("drawing-prompts", "prompt")?.promptText?.startsWith(prefix)).map(e => e.id);
    if ( ids.length ) await JournalEntry.deleteDocuments(ids);
    if ( game.users.get(userId)?.name === prefix ) await game.users.get(userId).delete();
  }, { prefix: RUN, userId }).catch(error => { console.error(error); process.exitCode = 1; });
  await bounded(browser.close(), "browser close", 10000);
}
