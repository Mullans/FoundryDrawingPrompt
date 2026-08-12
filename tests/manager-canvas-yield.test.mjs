import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shouldMinimizeManagerForCanvasYield,
  shouldRestoreManagerAfterCanvasYield,
  waitForApplicationClose
} from "../scripts/apps/manager-canvas-yield.mjs";

test("shouldMinimizeManagerForCanvasYield requires a rendered, expandable framed window", () => {
  assert.equal(shouldMinimizeManagerForCanvasYield(null), false);
  assert.equal(shouldMinimizeManagerForCanvasYield({
    rendered: false,
    minimized: false,
    hasFrame: true,
    minimizable: true
  }), false);
  assert.equal(shouldMinimizeManagerForCanvasYield({
    rendered: true,
    minimized: true,
    hasFrame: true,
    minimizable: true
  }), false);
  assert.equal(shouldMinimizeManagerForCanvasYield({
    rendered: true,
    minimized: false,
    hasFrame: false,
    minimizable: true
  }), false);
  assert.equal(shouldMinimizeManagerForCanvasYield({
    rendered: true,
    minimized: false,
    hasFrame: true,
    minimizable: false
  }), false);
  assert.equal(shouldMinimizeManagerForCanvasYield({
    rendered: true,
    minimized: false,
    hasFrame: true,
    minimizable: true
  }), true);
});

test("shouldRestoreManagerAfterCanvasYield only maximizes yields we started", () => {
  assert.equal(shouldRestoreManagerAfterCanvasYield({
    didMinimize: false,
    rendered: true,
    minimized: true
  }), false);
  assert.equal(shouldRestoreManagerAfterCanvasYield({
    didMinimize: true,
    rendered: false,
    minimized: true
  }), false);
  assert.equal(shouldRestoreManagerAfterCanvasYield({
    didMinimize: true,
    rendered: true,
    minimized: false
  }), false);
  assert.equal(shouldRestoreManagerAfterCanvasYield({
    didMinimize: true,
    rendered: true,
    minimized: true
  }), true);
});

test("waitForApplicationClose resolves immediately when already closed", async () => {
  await waitForApplicationClose(null);
  await waitForApplicationClose({ rendered: false });
});

test("waitForApplicationClose resolves on the ApplicationV2 close event", async () => {
  const listeners = new Map();
  const app = {
    rendered: true,
    addEventListener(type, handler, options) {
      listeners.set(type, { handler, options });
    }
  };
  const pending = waitForApplicationClose(app);
  assert.equal(listeners.get("close")?.options?.once, true);
  listeners.get("close").handler();
  await pending;
});
