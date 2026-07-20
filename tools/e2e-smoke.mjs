/*
 * Drawing Prompts E2E smoke.
 *
 * Prerequisites:
 * - Local Foundry is already running at http://localhost:30000 with --world=test-world.
 * - The world has users named "Gamemaster" and "Player2" with no join password, or set
 *   GM_USER / PLAYER_USER to matching names.
 * - The Drawing Prompts and socketlib modules are enabled in that world.
 * - Playwright is available locally: npm i playwright
 *
 * This script is a development tool only; tools/ is excluded from release archives.
 */

import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE_URL = process.env.FOUNDRY_URL || "http://localhost:30000";
const GM_USER = process.env.GM_USER || "Gamemaster";
const PLAYER_USER = process.env.PLAYER_USER || "Player2";
const PROMPT_TEXT = `Smoke prompt ${Date.now()}`;
const DRAWING_NAME = "Smoke Drawing";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const gm = await browser.newPage();
  const player = await browser.newPage();

  try {
    // Clean BEFORE the player connects: connecting triggers redelivery of any
    // stale active prompt, which would open a second player window and break
    // strict-mode locators.
    await joinWorld(gm, GM_USER);
    await cleanupWorld(gm);
    await joinWorld(player, PLAYER_USER);

    await openManager(gm);
    await fillAndSendPrompt(gm);
    await assertState(gm, data => {
      const prompt = newestPrompt();
      assert.equal(prompt?.promptText, data.promptText);
      assert.ok(Object.values(prompt.assignments).some(a => a.userName === data.playerUser));
    }, "prompt persisted after send", smokeData());

    const playerApp = player.locator(".drawing-prompts-player").first();
    await playerApp.waitFor({ state: "visible", timeout: 15000 });
    await drawStroke(player);

    await gm.locator(".dp-preview-frame img").first().waitFor({ state: "visible", timeout: 10000 });
    await submitDrawing(player);
    await assertState(gm, () => {
      const assignment = playerAssignment();
      assert.equal(assignment.status, "submitted");
    }, "assignment submitted", smokeData());

    await saveSubmittedDrawing(gm);
    await placeSavedTile(gm);
    await assertState(gm, () => {
      const assignment = playerAssignment();
      assert.ok(assignment.assets.mergedPath || assignment.assets.overlayPath);
      assert.ok(canvas.scene.tiles.some(tile => tile.texture?.src === assignment.assets.mergedPath || tile.texture?.src === assignment.assets.overlayPath));
    }, "saved drawing placed as tile", smokeData());

    await finishPrompt(gm);
    await gm.locator("textarea[name='promptText']").waitFor({ state: "visible", timeout: 10000 });
    await assertState(gm, data => {
      const manager = foundry.applications.instances.get("drawing-prompts-manager");
      assert.equal(manager?.activePrompt, null);
      assert.equal(manager?.draft?.promptText, data.promptText);
    }, "manager returned to setup with retained draft", smokeData());
  } finally {
    await browser.close();
  }
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

async function cleanupWorld(page) {
  await page.evaluate(async () => {
    const moduleId = "drawing-prompts";
    const promptIds = game.journal
      .filter(entry => entry.getFlag(moduleId, "prompt"))
      .map(entry => entry.id);
    if ( promptIds.length ) await JournalEntry.deleteDocuments(promptIds);

    const scene = canvas.scene;
    const tileIds = scene.tiles
      .filter(tile => String(tile.texture?.src ?? "").includes("/drawing-prompts/"))
      .map(tile => tile.id);
    if ( tileIds.length ) await scene.deleteEmbeddedDocuments("Tile", tileIds);
  });
}

async function openManager(page) {
  const candidates = [
    "button[data-control='drawing-prompts']",
    "[data-tool='drawing-prompts']",
    "button[aria-label='Drawing Prompts']",
    "button[title='Drawing Prompts']"
  ];
  for ( const selector of candidates ) {
    const control = page.locator(selector).first();
    if ( await control.count() ) {
      await control.click();
      await page.locator(".drawing-prompts-manager").waitFor({ state: "visible", timeout: 10000 });
      return;
    }
  }
  throw new Error("Could not find Drawing Prompts scene control.");
}

async function fillAndSendPrompt(page) {
  const manager = page.locator(".drawing-prompts-manager").first();
  await manager.locator("textarea[name='promptText']").fill(PROMPT_TEXT);
  await manager.locator("input[name='drawingName']").fill(DRAWING_NAME);
  await manager.locator("input[name='canvasWidth']").fill("512");
  await manager.locator("input[name='canvasHeight']").fill("384");
  await manager.locator(".dp-user-row", { hasText: PLAYER_USER }).locator("input[name='selectedUserIds']").check();
  await manager.locator("button[data-action='sendPrompt']").click();
  await manager.locator(".dp-review-mode").waitFor({ state: "visible", timeout: 10000 });
}

async function drawStroke(page) {
  const canvas = page.locator(".drawing-prompts-player .dp-display-canvas").first();
  const box = await canvas.boundingBox();
  assert.ok(box, "player drawing canvas has a bounding box");
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 120, { steps: 12 });
  await page.mouse.up();
}

async function submitDrawing(page) {
  await page.locator(".drawing-prompts-player button[data-action='submit']").first().click();
  // DialogV2 renders a native <dialog>; the confirm button carries data-action="yes".
  await page.locator("dialog [data-action='yes']").last().click();
  await page.locator(".drawing-prompts-player").waitFor({ state: "hidden", timeout: 10000 });
}

async function saveSubmittedDrawing(page) {
  const manager = page.locator(".drawing-prompts-manager").first();
  await manager.locator("button[data-action='saveAssignment']").click();
  const dialog = page.locator("dialog").last();
  await dialog.locator("input[name='name']").fill(DRAWING_NAME);
  await dialog.locator("button[type='submit'], [data-action='ok']").first().click();
  await manager.locator(".dp-saved-indicator").waitFor({ state: "visible", timeout: 15000 });
}

async function placeSavedTile(page) {
  await page.locator(".drawing-prompts-manager button[data-action='openPlaceDialog']").click();
  const placeDialog = page.locator(".drawing-prompts").filter({ has: page.locator("button[data-action='place']") }).last();
  await placeDialog.locator("input[name='mode'][value='tile']").check();
  await placeDialog.locator("button[data-action='place']").click();
  await page.waitForFunction(playerUser => {
    const prompt = game.journal
      .map(entry => entry.getFlag("drawing-prompts", "prompt"))
      .filter(Boolean)
      .sort((a, b) => Number(b.sentAt ?? 0) - Number(a.sentAt ?? 0))[0] ?? null;
    const assignment = Object.values(prompt?.assignments ?? {}).find(item => item.userName === playerUser);
    const src = assignment?.assets?.mergedPath || assignment?.assets?.overlayPath;
    if ( !src ) return false;
    return canvas.scene.tiles.some(tile => tile.texture?.src === src);
  }, PLAYER_USER, { timeout: 15000 });
}

async function finishPrompt(page) {
  await page.locator(".drawing-prompts-manager button[data-action='finishPrompt']").click();
  // Finish only confirms when work would be discarded; the confirm is a DialogV2 yes button.
  const confirm = page.locator("dialog [data-action='yes']").last();
  try {
    await confirm.click({ timeout: 5000 });
  } catch {
    // No confirmation dialog appeared — nothing unsaved to discard.
  }
}

function smokeData() {
  return {
    promptText: PROMPT_TEXT,
    playerUser: PLAYER_USER
  };
}

async function assertState(page, assertion, label, data = {}) {
  const result = await page.evaluate(({ fnText, data }) => {
    try {
      const assert = {
        equal(actual, expected) {
          if ( actual !== expected ) throw new Error(`Expected ${actual} to equal ${expected}`);
        },
        ok(value, message = "Expected value to be truthy") {
          if ( !value ) throw new Error(message);
        }
      };
      const newestPrompt = () => game.journal
        .map(entry => entry.getFlag("drawing-prompts", "prompt"))
        .filter(Boolean)
        .sort((a, b) => Number(b.sentAt ?? 0) - Number(a.sentAt ?? 0))[0] ?? null;
      const playerAssignment = () => Object.values(newestPrompt()?.assignments ?? {})
        .find(assignment => assignment.userName === data.playerUser);
      Function("assert", "newestPrompt", "playerAssignment", "ui", "canvas", "data", fnText)(assert, newestPrompt, playerAssignment, ui, canvas, data);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }, { fnText: `(${assertion.toString()})(data)`, data });

  if ( !result.ok ) throw new Error(`${label}: ${result.message}`);
}

await main().then(() => {
  console.log("e2e-smoke: PASS (send → draw → snapshot → submit → save → place → finish)");
}).catch(err => {
  console.error(err);
  process.exitCode = 1;
});
