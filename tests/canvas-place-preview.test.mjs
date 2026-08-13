import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hideApplicationForCanvasYield,
  placeWithLayerPreview,
  previewPixelSize,
  restoreApplicationAfterCanvasYield,
  topLeftCenteredOn
} from "../scripts/foundry/canvas-place-preview.mjs";

/** Flush pending microtasks/awaits so the placement promise's listeners are registered. */
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Sentinel proving a promise has not settled yet. */
const STILL_PENDING = Symbol("still-pending");

/**
 * Assert the placement promise has not resolved.
 * @param {Promise<unknown>} pending Placement promise.
 * @returns {Promise<void>}
 */
async function assertStillPending(pending) {
  const raced = await Promise.race([pending, flush().then(() => STILL_PENDING)]);
  assert.equal(raced, STILL_PENDING, "placement promise settled early");
}

/** Minimal addEventListener/removeEventListener target for window/document stubs. */
function createEventTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn) {
      const index = listeners.findIndex(entry => (entry.type === type) && (entry.fn === fn));
      if ( index >= 0 ) listeners.splice(index, 1);
    }
  };
}

/**
 * Install Foundry globals and drive the real `placeWithLayerPreview`.
 * The stub layer fires `activateCanvasLayer` from `activate()` exactly as
 * InteractionLayer#activate does, so the self-abort trap is exercised by every test here.
 * @returns {object} Environment handles plus a `restore` function.
 */
function installFoundryEnvironment() {
  const saved = {
    canvas: globalThis.canvas,
    Hooks: globalThis.Hooks,
    foundry: globalThis.foundry,
    window: globalThis.window,
    document: globalThis.document
  };

  const hooks = {
    registered: [],
    offCalls: [],
    on(hook, fn) {
      this.registered.push({ hook, fn, once: false });
    },
    once(hook, fn) {
      this.registered.push({ hook, fn, once: true });
    },
    off(hook, fn) {
      this.offCalls.push({ hook, fn });
      const index = this.registered.findIndex(entry => (entry.hook === hook) && (entry.fn === fn));
      if ( index >= 0 ) this.registered.splice(index, 1);
    },
    // Mirrors Foundry: `once` entries are dropped by the dispatcher itself, not by our module.
    callAll(hook, ...args) {
      for ( const entry of this.registered.filter(e => e.hook === hook) ) {
        if ( entry.once ) this.registered.splice(this.registered.indexOf(entry), 1);
        entry.fn(...args);
      }
    },
    hookNames(name) {
      return this.registered.filter(entry => entry.hook === name).length;
    }
  };

  const stage = {
    handlers: new Map(),
    on(type, fn) {
      if ( !this.handlers.has(type) ) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
    },
    off(type, fn) {
      const list = this.handlers.get(type) ?? [];
      const index = list.indexOf(fn);
      if ( index >= 0 ) list.splice(index, 1);
    },
    emit(type, event) {
      for ( const fn of [...(this.handlers.get(type) ?? [])] ) fn(event);
    },
    count() {
      return [...this.handlers.values()].reduce((total, list) => total + list.length, 0);
    }
  };

  const preview = {
    destroyed: false,
    w: 100,
    h: 100,
    x: 0,
    y: 0,
    refreshCount: 0,
    refresh() {
      if ( this.destroyed ) throw new Error("refresh on destroyed preview");
      this.refreshCount += 1;
    },
    document: {
      _id: "preview-id",
      x: 0,
      y: 0,
      texture: { src: "prompt.webp" },
      updateSource(changes) {
        Object.assign(this, changes);
      },
      toObject() {
        return { _id: this._id, x: this.x, y: this.y, texture: { ...this.texture } };
      }
    }
  };

  class StubTilesLayer {
    static documentName = "Tile";

    activate() {
      hooks.callAll("activateCanvasLayer", this);
      return this;
    }

    async _createPreview(data) {
      this.previewData = data;
      return preview;
    }

    clearPreviewContainer() {
      this.cleared = (this.cleared ?? 0) + 1;
    }
  }

  const layer = new StubTilesLayer();
  const otherLayer = new StubTilesLayer();
  const createdDoc = { id: "created-tile" };
  const createCalls = [];

  const canvasStub = {
    stage,
    mousePosition: { x: 100, y: 100 },
    tiles: layer,
    scene: {
      async createEmbeddedDocuments(documentName, data) {
        createCalls.push({ documentName, data });
        return [createdDoc];
      }
    }
  };

  const win = createEventTarget();
  const doc = createEventTarget();

  globalThis.canvas = canvasStub;
  globalThis.Hooks = hooks;
  globalThis.foundry = { utils: { deepClone: value => structuredClone(value) } };
  globalThis.window = win;
  globalThis.document = doc;

  return {
    hooks,
    stage,
    preview,
    layer,
    otherLayer,
    createdDoc,
    createCalls,
    win,
    doc,
    /** Assert every listener and hook this module registered is gone. */
    assertFullyUnregistered() {
      assert.equal(hooks.registered.length, 0, "hooks still registered");
      assert.equal(stage.count(), 0, "PIXI stage listeners still registered");
      assert.equal(win.listeners.length, 0, "window keydown listener still registered");
      assert.equal(doc.listeners.length, 0, "document keydown listener still registered");
    },
    restore() {
      for ( const [key, value] of Object.entries(saved) ) {
        if ( value === undefined ) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

/** Left mouse button pointerdown event. */
const leftClick = () => ({ button: 0, preventDefault() {}, stopPropagation() {} });

test("previewPixelSize prefers placeable w/h over grid-unit document width", () => {
  assert.deepEqual(
    previewPixelSize({ w: 100, h: 200, document: { width: 1, height: 1 } }, { width: 1, height: 1 }),
    { width: 100, height: 200 }
  );
});

test("previewPixelSize uses TokenDocument.getSize when present", () => {
  const preview = {
    document: {
      width: 1,
      height: 1,
      getSize() {
        return { width: 150, height: 150 };
      }
    }
  };
  assert.deepEqual(previewPixelSize(preview), { width: 150, height: 150 });
});

test("topLeftCenteredOn puts the cursor at the pixel center", () => {
  assert.deepEqual(topLeftCenteredOn({ x: 100, y: 80 }, { width: 40, height: 20 }), { x: 80, y: 70 });
});

test("hideApplicationForCanvasYield uses display none and restores prior styles", () => {
  const el = {
    style: { display: "flex", visibility: "", pointerEvents: "auto" },
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); }
    },
    attrs: new Map(),
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; },
    setAttribute(name, value) { this.attrs.set(name, value); },
    removeAttribute(name) { this.attrs.delete(name); }
  };
  const app = { rendered: true, element: el };
  const state = hideApplicationForCanvasYield(app);
  assert.equal(state.didHide, true);
  assert.equal(el.style.display, "none");
  assert.equal(el.style.visibility, "hidden");
  assert.equal(el.style.pointerEvents, "none");
  assert.ok(el.classList.values.has("dp-canvas-yield-hidden"));
  restoreApplicationAfterCanvasYield(app, state);
  assert.equal(el.style.display, "flex");
  assert.equal(el.style.visibility, "");
  assert.equal(el.style.pointerEvents, "auto");
  assert.equal(el.classList.values.has("dp-canvas-yield-hidden"), false);
});

test("placeWithLayerPreview commits on left click and unregisters everything (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: { texture: { src: "p.webp" } } });
    await flush();
    // The layer's own activate() already fired activateCanvasLayer; placement must survive it.
    assert.equal(env.hooks.hookNames("activateCanvasLayer"), 1);
    await assertStillPending(pending);

    env.stage.emit("pointerdown", leftClick());
    assert.equal(await pending, env.createdDoc);
    assert.equal(env.createCalls.length, 1);
    assert.equal(env.createCalls[0].documentName, "Tile");
    // Cursor-centered top-left, with the preview _id stripped before creation.
    assert.equal(env.createCalls[0].data[0].x, 50);
    assert.equal(env.createCalls[0].data[0].y, 50);
    assert.equal("_id" in env.createCalls[0].data[0], false);
    env.assertFullyUnregistered();
  } finally {
    env.restore();
  }
});

test("placeWithLayerPreview ignores activateCanvasLayer for its own layer (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();
    // Re-activating the layer we are placing on is not an abort.
    env.hooks.callAll("activateCanvasLayer", env.layer);
    await assertStillPending(pending);

    env.stage.emit("pointerdown", leftClick());
    assert.equal(await pending, env.createdDoc);
  } finally {
    env.restore();
  }
});

test("placeWithLayerPreview aborts when another canvas layer activates (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();

    // GM clicks another scene control: PlaceablesLayer#_deactivate destroys the preview.
    env.hooks.callAll("activateCanvasLayer", env.otherLayer);
    env.preview.destroyed = true;
    assert.equal(await pending, null);

    // A stray left click on canvas afterwards must not create a zombie placeable.
    env.stage.emit("pointerdown", leftClick());
    assert.equal(env.createCalls.length, 0);
    env.assertFullyUnregistered();
    assert.deepEqual(
      env.hooks.offCalls.map(entry => entry.hook).sort(),
      ["activateCanvasLayer", "canvasTearDown"]
    );
  } finally {
    env.restore();
  }
});

test("placeWithLayerPreview aborts on canvasTearDown (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();

    env.hooks.callAll("canvasTearDown");
    assert.equal(await pending, null);

    // The captured scene is gone; a later click must not create against the new one.
    env.stage.emit("pointerdown", leftClick());
    assert.equal(env.createCalls.length, 0);
    env.assertFullyUnregistered();
  } finally {
    env.restore();
  }
});

test("placeWithLayerPreview settles null when the preview is destroyed under it (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();

    // Destroyed with no hook fired at all: pointermove must not refresh a dead PIXI object.
    env.preview.destroyed = true;
    const refreshesBefore = env.preview.refreshCount;
    env.stage.emit("pointermove", {});
    assert.equal(await pending, null);
    assert.equal(env.preview.refreshCount, refreshesBefore);
    assert.equal(env.createCalls.length, 0);
    env.assertFullyUnregistered();
  } finally {
    env.restore();
  }
});
