import assert from "node:assert/strict";
import { test } from "node:test";

class ApplicationV2 {
  async render() { return this; }
  async _onRender() {}
  bringToFront() {}
}
globalThis.foundry = { applications: { api: {
  ApplicationV2, DialogV2: { wait: async () => "ok" }, HandlebarsApplicationMixin: Base => Base
} } };
globalThis.game = {
  world: { id: "world" }, user: { id: "player", color: "#000000" },
  settings: { get: () => "" }
};
const { PlayerDrawingApp } = await import("../scripts/apps/player-drawing-app.mjs");
const { recoveryStore } = await import("../scripts/drawing/recovery-store.mjs");
const { DrawingEngine } = await import("../scripts/drawing/drawing-engine.mjs");

test("unavailable IndexedDB still restores the matching full-quality GM capture", async () => {
  const load = recoveryStore.load;
  const attach = DrawingEngine.prototype.attach;
  const install = DrawingEngine.prototype.loadOverlayRgba;
  let restored = null;
  recoveryStore.load = async () => { throw new Error("IndexedDB unavailable"); };
  DrawingEngine.prototype.attach = () => {};
  DrawingEngine.prototype.loadOverlayRgba = rgba => { restored = rgba; };
  globalThis.OffscreenCanvas = class {
    getContext() { return { clearRect() {} }; }
  };
  globalThis.Image = class {
    addEventListener(type, handler) { if ( type === "load" ) this.loaded = handler; }
    set src(value) { this.source = value; this.loaded(); }
  };
  globalThis.document = { createElement: () => ({
    getContext: () => ({ clearRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([9, 8, 7, 255]) }) })
  }) };
  const app = new PlayerDrawingApp({ assignmentPayload: {
    prompt: { id: "fallback-prompt", gmUserId: "owner", canvasWidth: 1, canvasHeight: 1 },
    assignment: { id: "fallback-assignment" },
    restorationSubmission: { recoveryKind: "full-submission", assignmentId: "fallback-assignment", width: 1, height: 1,
      overlay: { dataUrl: "data:image/png;base64,full-quality-capture" } }
  } });
  app.element = {
    querySelector: selector => selector === ".dp-display-canvas" ? { classList: { add() {}, remove() {} } } : null,
    querySelectorAll: () => []
  };
  try {
    await app._onRender({}, {});
    assert.deepEqual(restored?.data, new Uint8ClampedArray([9, 8, 7, 255]));
  } finally {
    recoveryStore.load = load;
    DrawingEngine.prototype.attach = attach;
    DrawingEngine.prototype.loadOverlayRgba = install;
    delete globalThis.OffscreenCanvas;
    delete globalThis.Image;
    delete globalThis.document;
  }
});

test("cleanup with a colliding assignment ID cannot close another owner's live drawing", async () => {
  const app = await PlayerDrawingApp.open({
    prompt: { id: "prompt", gmUserId: "owner", canvasWidth: 64, canvasHeight: 64 },
    assignment: { id: "assignment" }
  });
  let closed = 0;
  app.close = async () => { closed++; };
  const clear = recoveryStore.clear;
  recoveryStore.clear = async () => {};
  const identity = { worldId: "world", userId: "player", gmUserId: "owner", promptId: "prompt", assignmentId: "assignment", width: 64, height: 64 };
  try {
    for ( const [field, wrong] of Object.entries({ worldId: "elsewhere", userId: "other-player", gmUserId: "other-gm", promptId: "other-prompt", width: 65, height: 65 }) ) {
      await PlayerDrawingApp.clearRecoveryForIdentity({ ...identity, [field]: wrong });
      assert.equal(closed, 0, `mismatched ${field} closed the live drawing`);
    }
    await PlayerDrawingApp.clearRecoveryForIdentity(identity);
    assert.equal(closed, 1);
  } finally {
    recoveryStore.clear = clear;
  }
});
