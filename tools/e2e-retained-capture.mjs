/** Close/Submit overlap through real player capture, uploads, socketlib and Journal persistence. */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const run = `CaptureE2E-${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const pages = [];
const errors = [];
let userId, promptId, cleanupPaths = [];
async function page(label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  pages.push(page);
  page.on("pageerror", error => errors.push(`${label}: ${error.message}`));
  page.on("console", message => { if ( message.type() === "error" ) errors.push(`${label}: ${message.text()}`); });
  return page;
}
async function join(page, name) {
  await page.goto(`${process.env.FOUNDRY_URL || "http://localhost:30000"}/join`);
  await page.locator("select[name='userid']").selectOption({ label: name });
  await page.locator("input[name='password']").fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit']").first().click();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 30000 });
}
const gm = await page("GM");
const player = await page("player");
try {
  await join(gm, process.env.GM_USER || "Gamemaster");
  userId = await gm.evaluate(async name => (await User.create({ name, role: CONST.USER_ROLES.PLAYER, password: "" })).id, run);
  await join(player, run);
  await player.evaluate(async () => {
    const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
    globalThis.captureTest = { original: PlayerDrawingApp.captureRetainedForAssignment };
    PlayerDrawingApp.captureRetainedForAssignment = async function (...args) {
      const result = await captureTest.original.apply(this, args);
      captureTest.captured = result;
      await new Promise(resolve => { captureTest.release = resolve; });
      return result;
    };
  });
  const fixture = await gm.evaluate(async ({ userId, run }) => {
    const prompt = await game.modules.get("drawing-prompts").api.sendPrompt({
      promptName: run, promptText: run, canvasWidth: 256, canvasHeight: 256,
      background: { sourceType: "blank" }, selectedUserIds: [userId], awaitDeliveries: true
    });
    return { promptId: prompt.id, assignmentId: Object.keys(prompt.assignments)[0] };
  }, { userId, run });
  promptId = fixture.promptId;
  const root = player.locator(".drawing-prompts-player").first();
  await root.waitFor({ state: "visible" });
  const box = await root.locator(".dp-display-canvas").boundingBox();
  assert.ok(box, "real player drawing canvas is visible");
  const draw = async offset => {
    await player.mouse.move(box.x + box.width * 0.2, box.y + box.height * offset);
    await player.mouse.down();
    await player.mouse.move(box.x + box.width * 0.7, box.y + box.height * offset, { steps: 8 });
    await player.mouse.up();
  };
  await draw(0.3);
  await gm.evaluate(async id => {
    const { closePrompt } = await import("/modules/drawing-prompts/scripts/prompts/prompt-service.mjs");
    globalThis.captureClose = { done: false };
    captureClose.promise = closePrompt(id).then(() => { captureClose.done = true; }, error => {
      captureClose.error = error.message; captureClose.done = true;
    });
  }, promptId);
  await player.waitForFunction(() => Boolean(globalThis.captureTest?.captured && captureTest.release));
  const captured = await player.evaluate(() => captureTest.captured.submission);
  cleanupPaths = Object.values(captured.staged ?? {}).filter(Boolean);
  assert.equal(captured.mode, "staged", "native player upload lane is exercised");
  assert.match(captured.staged.overlayPath, /-overlay-capture-[A-Za-z0-9_-]+\.webp$/, "capture has its own scoped file");
  await draw(0.7);
  await root.locator("button[data-action='submit']").click();
  await player.locator("dialog [data-action='yes']").last().click();
  await gm.waitForFunction(({ promptId, assignmentId }) =>
    game.journal.get(promptId)?.getFlag("drawing-prompts", "prompt")?.assignments[assignmentId]?.status === "submitted", fixture);
  const before = await gm.evaluate(({ promptId, assignmentId }) =>
    game.journal.get(promptId).getFlag("drawing-prompts", "prompt").assignments[assignmentId], fixture);
  cleanupPaths.push(...Object.values(before.pendingSubmission.staged).filter(Boolean));
  assert.notEqual(before.pendingSubmission.staged.overlayPath, captured.staged.overlayPath, "Submit never overwrites retained capture file");
  await player.evaluate(() => { captureTest.release(); });
  await gm.waitForFunction(() => captureClose.done, null, { timeout: 20000 });
  const after = await gm.evaluate(({ promptId, assignmentId }) => {
    const prompt = game.journal.get(promptId).getFlag("drawing-prompts", "prompt");
    return { error: captureClose.error, status: prompt.lifecycleStatus, assignment: prompt.assignments[assignmentId] };
  }, fixture);
  assert.equal(after.error, undefined);
  assert.equal(after.status, "closed");
  assert.equal(after.assignment.status, "submitted", "Close preserves accepted submission");
  assert.deepEqual(after.assignment.pendingSubmission, before.pendingSubmission, "Close preserves accepted image paths and metadata");
  assert.deepEqual(errors, [], "GM/player consoles remain clean");
} finally {
  await player.evaluate(async () => {
    const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
    if ( globalThis.captureTest ) {
      PlayerDrawingApp.captureRetainedForAssignment = captureTest.original;
      captureTest.release?.();
    }
  }).catch(() => {});
  const hostCleanup = await gm.evaluate(async ({ promptId }) => {
    if ( !promptId || !game.journal.has(promptId) ) return false;
    const { deletePrompt } = await import("/modules/drawing-prompts/scripts/prompts/prompt-service.mjs");
    try { await deletePrompt(promptId, { confirmed: true }); return false; }
    catch (error) {
      if ( !error.message.includes("This host cannot delete uploaded files") ) throw error;
      if ( !game.journal.has(promptId) ) throw new Error("Unsupported host deletion lost the Prompt");
      return true;
    }
  }, { promptId }).catch(error => { console.error("capture fixture cleanup preflight failed", error); process.exitCode = 1; });
  if ( hostCleanup ) {
    // Local test operator removes only this fixture's exact uploaded paths. This
    // is development tooling, not an unavailable browser deletion API.
    const dataRoot = resolve(process.env.FOUNDRY_DATA_PATH || fileURLToPath(new URL("../../../FoundryVTT-WindowsPortable-14.364/Data/", import.meta.url)));
    for ( const path of cleanupPaths ) {
      const absolute = resolve(dataRoot, path);
      assert.ok(absolute.startsWith(`${dataRoot}${sep}`), "fixture path stays under the local Foundry Data directory");
      await unlink(absolute).catch(error => { if ( error.code !== "ENOENT" ) throw error; });
    }
  }
  await gm.evaluate(async ({ promptId, userId, cleanupPaths }) => {
    const { closePrompt, deletePrompt } = await import("/modules/drawing-prompts/scripts/prompts/prompt-service.mjs");
    if ( promptId && game.journal.has(promptId) ) {
      if ( game.journal.get(promptId).getFlag("drawing-prompts", "prompt")?.lifecycleStatus === "open" ) {
        await closePrompt(promptId, { closeWithoutCaptures: true });
      }
      if ( !await deletePrompt(promptId, { confirmed: true }) ) throw new Error("Fixture Prompt was not deleted");
    }
    const { browseFiles } = await import("/modules/drawing-prompts/scripts/prompts/asset-service.mjs");
    for ( const dir of new Set(cleanupPaths.map(path => path.slice(0, path.lastIndexOf("/")))) ) {
      const files = await browseFiles(dir);
      if ( cleanupPaths.some(path => files.includes(path)) ) throw new Error("Delete left fixture capture/submission files behind");
    }
    if ( userId && game.users.has(userId) ) await game.users.get(userId).delete();
  }, { promptId, userId, cleanupPaths }).catch(error => { console.error("capture fixture cleanup failed", error); process.exitCode = 1; });
  await browser.close();
}
if ( !process.exitCode ) console.log("e2e-retained-capture: PASS (staged capture/Submit preserves accepted work; unsupported host deletion retains Prompt and succeeds after exact fixture host cleanup)");
