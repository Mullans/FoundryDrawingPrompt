/** SCR-58 real-client delivery regression. Run with Foundry already on :30000.
 * Uses temporary players and uniquely named prompts; never cleans unrelated world data.
 * PLAYWRIGHT_BROWSERS_PATH=0 node tools/e2e-delivery.mjs
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.FOUNDRY_URL || "http://localhost:30000";
const RUN = `DeliveryE2E-${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const gm = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pages = [gm];
const errors = [];
const userIds = [];
let stage = "initialization";
function progress(label) {
  stage = label;
  console.log(`[${new Date().toISOString()}] ${RUN}: ${label}`);
}
async function bounded(promise, label, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms (stage: ${stage})`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function observe(page, label) {
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  // Playwright's action timeout does not bound page.evaluate promises (including
  // socket acknowledgements). Bound every browser evaluation separately.
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (...args) => bounded(evaluate(...args), `${label} browser evaluation`);
  page.on("pageerror", error => errors.push(`${label}: ${error.message}`));
  page.on("console", message => {
    if ( message.type() === "error" ) errors.push(`${label}: ${message.text()}`);
  });
}
observe(gm, "GM");

async function join(page, name) {
  progress(`join ${name}`);
  await page.goto(`${BASE}/join`, { waitUntil: "domcontentloaded" });
  await page.locator("select[name='userid'], select[name='user'], select#userid").first().selectOption({ label: name });
  const password = page.locator("input[type='password']").first();
  if ( await password.count() ) await password.fill(process.env.FOUNDRY_PASSWORD || "");
  await page.locator("button[type='submit']").first().click();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 30000 });
}

async function openSetup() {
  progress("open compose fixture");
  await gm.evaluate(async () => {
    await foundry.applications.instances.get("drawing-prompts-manager")?.close();
    await game.modules.get("drawing-prompts").api.openPromptManager();
    // The current manager auto-adopts unfinished prompts and has no New action.
    // Set up compose without deleting any earlier scenario or preexisting prompt.
    const manager = foundry.applications.instances.get("drawing-prompts-manager");
    manager.activePrompt = null;
    manager.selectedAssignmentId = null;
    manager.draft.selectedUserIds = new Set();
    await manager.render({ parts: ["body"] });
  });
  await gm.locator("textarea[name='promptText']").waitFor({ state: "visible" });
}

async function send(name, selected) {
  await openSetup();
  progress(`fill/send ${name}`);
  const manager = gm.locator(".drawing-prompts-manager");
  await manager.locator("textarea[name='promptText']").fill(`${RUN}-${name}`);
  await manager.locator("input[name='drawingName']").fill(`${RUN}-${name}`);
  await manager.locator("input[name='canvasWidth']").fill("256");
  await manager.locator("input[name='canvasHeight']").fill("256");
  // Snapshot identifiers, not nth() locators over a shrinking :checked collection.
  const checkedIds = await manager.locator("input[name='selectedUserIds']:checked").evaluateAll(inputs => inputs.map(input => input.value));
  for ( const id of checkedIds ) {
    const checkbox = manager.locator(`input[name='selectedUserIds'][value='${id}']`);
    if ( await checkbox.isEnabled() ) await checkbox.uncheck();
  }
  for ( const id of selected ) await manager.locator(`input[name='selectedUserIds'][value='${id}']`).check();
  await manager.locator("button[data-action='sendPrompt']").click();
}

async function prompt(name) {
  return gm.evaluate(text => game.journal.map(e => e.getFlag("drawing-prompts", "prompt")).find(p => p?.promptText === text), `${RUN}-${name}`);
}

async function waitDelivery(name, statuses) {
  progress(`wait ${name}: ${statuses.join(", ")}`);
  await gm.waitForFunction(({ text, statuses }) => {
    const p = game.journal.map(e => e.getFlag("drawing-prompts", "prompt")).find(p => p?.promptText === text);
    const actual = Object.values(p?.assignments ?? {}).map(a => a.delivery?.status).sort();
    return JSON.stringify(actual) === JSON.stringify([...statuses].sort());
  }, { text: `${RUN}-${name}`, statuses }, { timeout: 20000 });
  return prompt(name);
}

async function blockDelivery(ids) {
  await gm.evaluate(async ids => {
    const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
    globalThis.deliveryTest.originalOpen ??= emit.openDrawingPrompt;
    emit.openDrawingPrompt = function (id, ...args) {
      if ( ids.includes(id) ) return new Promise(() => {});
      return globalThis.deliveryTest.originalOpen.call(this, id, ...args);
    };
  }, ids);
}

async function restoreOpen() {
  await gm.evaluate(async () => {
    const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
    if ( deliveryTest.originalOpen ) emit.openDrawingPrompt = deliveryTest.originalOpen;
  });
}

try {
  await join(gm, process.env.GM_USER || "Gamemaster");
  await gm.evaluate(() => {
    globalThis.deliveryTest = { timing: [] };
    deliveryTest.hook = Hooks.on("drawing-prompts.deliveryTiming", event => deliveryTest.timing.push(event));
  });
  await gm.evaluate(async () => {
    const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
    deliveryTest.originalRequestSnapshot = emit.requestSnapshot;
    deliveryTest.pendingSnapshotRequests = 0;
    emit.requestSnapshot = async function (...args) {
      deliveryTest.pendingSnapshotRequests++;
      try { return await deliveryTest.originalRequestSnapshot.apply(this, args); }
      finally { deliveryTest.pendingSnapshotRequests--; }
    };
  });
  for ( let i = 0; i < 2; i++ ) {
    const name = `${RUN}-P${i}`;
    userIds.push(await gm.evaluate(async name => (await User.create({ name, role: CONST.USER_ROLES.PLAYER, password: "" })).id, name));
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pages.push(page);
    observe(page, name);
    await join(page, name);
  }
  await gm.waitForFunction(ids => ids.every(id => game.users.get(id)?.active), userIds);
  const [player, other] = pages.slice(1);

  // Delayed Journal creation proves Sending is painted before storage work finishes.
  await gm.evaluate(() => {
    deliveryTest.originalCreate = JournalEntry.create;
    JournalEntry.create = async function (...args) {
      const started = performance.now();
      deliveryTest.storageEntered = true;
      await new Promise(resolve => { deliveryTest.releaseStorage = resolve; });
      const result = await deliveryTest.originalCreate.apply(this, args);
      deliveryTest.timing.push({ stage: "storage-create", elapsedMs: performance.now() - started });
      return result;
    };
  });
  // Delayed window creation must not delay automatic authenticated receipt.
  await player.evaluate(async () => {
    const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
    globalThis.deliveryPlayer = { originalOpen: PlayerDrawingApp.open };
    PlayerDrawingApp.open = async function (...args) {
      deliveryPlayer.openEntered = true;
      await new Promise(resolve => { deliveryPlayer.releaseOpen = resolve; });
      return deliveryPlayer.originalOpen.apply(this, args);
    };
  });
  await send("immediate", [userIds[0]]);
  progress("assert Sending before storage release");
  await gm.waitForFunction(() => deliveryTest.storageEntered);
  assert.match(await gm.locator(".dp-delivery-feedback").first().innerText(), /Sending/i);
  assert.equal(await gm.locator("button[data-action='sendPrompt']").isDisabled(), true);
  assert.equal(await prompt("immediate"), undefined, "storage remains held while Sending is visible");
  await gm.evaluate(() => { JournalEntry.create = deliveryTest.originalCreate; deliveryTest.releaseStorage(); });
  let immediate = await waitDelivery("immediate", ["received"]);
  await player.waitForFunction(() => deliveryPlayer.openEntered);
  assert.equal(await player.locator(".drawing-prompts-player").count(), 0, "receipt precedes window opening");
  await player.evaluate(async () => {
    const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
    PlayerDrawingApp.open = deliveryPlayer.originalOpen;
    deliveryPlayer.releaseOpen();
  });
  await player.locator(".drawing-prompts-player").waitFor({ state: "visible" });
  progress("forged receipt through real socketlib");
  const immediateId = Object.keys(immediate.assignments)[0];
  const gmId = await gm.evaluate(() => game.user.id);
  const forged = await other.evaluate(async ({ gmId, id, owner }) => {
    const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
    return emit.assignmentReceived(gmId, id, owner);
  }, { gmId, id: immediateId, owner: userIds[0] });
  assert.equal(forged.accepted, false, "real socketlib initiator defeats forged wire owner");

  // One client times out; Retry must reuse the invitation/assignment.
  await blockDelivery([userIds[1]]);
  await send("retry", userIds);
  const partial = await waitDelivery("retry", ["received", "failed"]);
  const originalIds = Object.keys(partial.assignments).sort();
  await restoreOpen();
  progress("click Retry");
  await gm.locator("button[data-action='retryDeliveries']").click();
  const retried = await waitDelivery("retry", ["received", "received"]);
  assert.deepEqual(Object.keys(retried.assignments).sort(), originalIds);

  // Continue withdraws only unresolved invitation; a real late receipt cannot revive it.
  await blockDelivery([userIds[1]]);
  await send("continue", userIds);
  const unresolved = await waitDelivery("continue", ["received", "failed"]);
  const failed = Object.values(unresolved.assignments).find(a => a.userId === userIds[1]);
  progress("click Continue and reject late receipt");
  await gm.locator("button[data-action='continueDeliveries']").click();
  await waitDelivery("continue", ["received", "withdrawn"]);
  const late = await other.evaluate(async ({ gmId, id }) => {
    const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
    return emit.assignmentReceived(gmId, id, game.user.id);
  }, { gmId, id: failed.id });
  assert.equal(late.accepted, false);
  await waitDelivery("continue", ["received", "withdrawn"]);

  // With no receipts setup and its authored draft remain available.
  await blockDelivery(userIds);
  await send("zero", [userIds[0]]);
  await waitDelivery("zero", ["failed"]);
  assert.equal(await gm.locator("textarea[name='promptText']").inputValue(), `${RUN}-zero`);
  assert.equal(await gm.locator(".dp-review-mode").count(), 0);
  await gm.locator("button[data-action='continueDeliveries']").click();
  await gm.waitForFunction(text => !game.journal.some(e => e.getFlag("drawing-prompts", "prompt")?.promptText === text), `${RUN}-zero`);
  assert.equal(await gm.locator("textarea[name='promptText']").inputValue(), `${RUN}-zero`);
  await restoreOpen();

  // Bulk resend must capture both cancelled assignments before the first delivery
  // refresh replaces the prompt's assignment collection.
  await send("bulk", userIds);
  const bulk = await waitDelivery("bulk", ["received", "received"]);
  const bulkAssignments = Object.values(bulk.assignments);
  for ( const [index, page] of [player, other].entries() ) {
    const id = bulkAssignments.find(a => a.userId === userIds[index]).id;
    await page.waitForFunction(id => [...foundry.applications.instances.values()].some(app =>
      app.assignmentPayload?.assignment?.id === id && app.mode === "live" && app.rendered
    ), id);
  }
  progress("Cancel All then UI Resend All for two recipients");
  await gm.evaluate(async id => {
    const { cancelAllAssignments } = await import("/modules/drawing-prompts/scripts/prompts/prompt-lifecycle.mjs");
    await cancelAllAssignments(id);
  }, bulk.id);
  assert.ok(Object.values((await prompt("bulk")).assignments).every(a => a.status === "cancelled"));
  for ( const [index, page] of [player, other].entries() ) {
    const id = bulkAssignments.find(a => a.userId === userIds[index]).id;
    await page.waitForFunction(id => ![...foundry.applications.instances.values()].some(app =>
      app.assignmentPayload?.assignment?.id === id && app.rendered
    ), id);
  }
  await gm.locator("button[data-action='resendAll']").click();
  await gm.waitForFunction(id => {
    const p = game.journal.get(id)?.getFlag("drawing-prompts", "prompt");
    const assignments = Object.values(p?.assignments ?? {});
    return assignments.length === 2 && assignments.every(a =>
      ["pending", "opened"].includes(a.status) && a.delivery?.status === "received" && a.delivery?.generation === 1
    );
  }, bulk.id, { timeout: 20000 });
  for ( const [index, page] of [player, other].entries() ) {
    const id = bulkAssignments.find(a => a.userId === userIds[index]).id;
    await page.waitForFunction(id => [...foundry.applications.instances.values()].some(app => {
      const assignment = app.assignmentPayload?.assignment;
      return assignment?.id === id && app.mode === "live" && app.rendered
        && assignment.delivery?.generation === 1 && ["pending", "opened"].includes(assignment.status)
        && app.element?.isConnected && app.element.getBoundingClientRect().width > 0;
    }), id, { timeout: 20000 });
  }
  progress("bulk resend reopened both generation-1 player windows");

  // Established membership is durable across connectivity changes; no new offline invitations.
  progress("disconnect established recipient");
  // This case tests membership, not a preview request losing its target client.
  await gm.evaluate(async () => {
    await foundry.applications.instances.get("drawing-prompts-manager")?.close();
  });
  await gm.waitForFunction(() => deliveryTest.pendingSnapshotRequests === 0);
  await bounded(other.close(), "close second player");
  await gm.waitForFunction(id => !game.users.get(id)?.active, userIds[1], { timeout: 20000 });
  assert.equal(Object.values((await prompt("retry")).assignments).find(a => a.userId === userIds[1]).delivery.status, "received");
  await openSetup();
  const offline = gm.locator(`input[name='selectedUserIds'][value='${userIds[1]}']`);
  assert.ok(await offline.count() === 0 || await offline.isDisabled(), "offline recipient cannot be selected");
  await send("offline", [userIds[0]]);
  const onlineOnly = await waitDelivery("offline", ["received"]);
  assert.deepEqual(Object.values(onlineOnly.assignments).map(a => a.userId), [userIds[0]]);
  const timing = await gm.evaluate(() => deliveryTest.timing);
  for ( const stage of ["storage-create", "framing", "preparation", "receipt", "client-open"] ) assert.ok(timing.some(t => t.stage === stage), `timing captures ${stage}`);
  assert.deepEqual(errors, [], "GM/player consoles remain error-free");
  console.log(JSON.stringify({ timing }, null, 2));
  console.log("e2e-delivery: PASS (Sending, receipt/render independence, Retry, Continue, zero receipts, membership, socket identity). Local Foundry only; Forge not verified.");
} catch (error) {
  console.error(`e2e-delivery: FAIL at ${stage}`, error);
  if ( errors.length ) console.error("Browser errors captured:", errors);
  process.exitCode = 1;
} finally {
  progress("restore instrumentation and remove this run's fixtures");
  for ( const page of pages.slice(1) ) {
    if ( page.isClosed() ) continue;
    await page.evaluate(async () => {
      const { PlayerDrawingApp } = await import("/modules/drawing-prompts/scripts/apps/player-drawing-app.mjs");
      if ( globalThis.deliveryPlayer ) {
        PlayerDrawingApp.open = deliveryPlayer.originalOpen;
        deliveryPlayer.releaseOpen?.();
      }
    }).catch(error => { console.error("Player instrumentation cleanup failed", error); process.exitCode = 1; });
  }
  await gm.evaluate(async ({ prefix, ids }) => {
    if ( globalThis.deliveryTest ) {
      if ( deliveryTest.originalCreate ) JournalEntry.create = deliveryTest.originalCreate;
      deliveryTest.releaseStorage?.();
      const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
      if ( deliveryTest.originalOpen ) emit.openDrawingPrompt = deliveryTest.originalOpen;
      if ( deliveryTest.originalRequestSnapshot ) emit.requestSnapshot = deliveryTest.originalRequestSnapshot;
      Hooks.off("drawing-prompts.deliveryTiming", deliveryTest.hook);
    }
    const prompts = game.journal.filter(e => e.getFlag("drawing-prompts", "prompt")?.promptText?.startsWith(prefix)).map(e => e.id);
    if ( prompts.length ) await JournalEntry.deleteDocuments(prompts);
    const ownedUsers = ids.filter(id => game.users.get(id)?.name?.startsWith(prefix));
    if ( ownedUsers.length ) await User.deleteDocuments(ownedUsers);
  }, { prefix: RUN, ids: userIds }).catch(error => { console.error("Delivery test cleanup failed", error); process.exitCode = 1; });
  progress("close browser");
  await bounded(browser.close(), "browser cleanup", 10000).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  progress("finished");
}
