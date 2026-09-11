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
    mesh: { x: 0, y: 0 },
    refreshCount: 0,
    refresh() {
      if ( this.destroyed ) throw new Error("refresh on destroyed preview");
      this.refreshCount += 1;
      // Foundry v14 places the centered Tile mesh at the document's top-left.
      this.mesh.x = this.document.x;
      this.mesh.y = this.document.y;
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
  Object.defineProperty(preview, "renderedBounds", {
    get() {
      return {
        x: this.x + this.mesh.x - (this.w / 2),
        y: this.y + this.mesh.y - (this.h / 2),
        width: this.w,
        height: this.h
      };
    }
  });

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

test("SCR-57 a committed create remains pending through abandonment and records its result once", async () => {
  const env = installFoundryEnvironment();
  let release;
  try {
    const originalScene = canvas.scene;
    originalScene.createEmbeddedDocuments = async (documentName, data) => {
      env.createCalls.push({ documentName, data });
      await new Promise(resolve => { release = resolve; });
      return [env.createdDoc];
    };
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();
    env.stage.emit("pointerdown", leftClick());
    env.hooks.callAll("activateCanvasLayer", env.otherLayer);
    env.hooks.callAll("canvasTearDown");
    canvas.scene = { createEmbeddedDocuments() { throw new Error("wrong scene"); } };
    env.stage.emit("pointerdown", leftClick());
    await assertStillPending(pending);
    release();
    assert.equal(await pending, env.createdDoc);
    assert.equal(env.createCalls.length, 1);
    env.assertFullyUnregistered();
  } finally { release?.(); env.restore(); }
});

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

test("tile preview's rendered bounds are centered on the cursor before commit", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({
      layerName: "tiles",
      createData: { width: 100, height: 100, texture: { src: "p.webp" } }
    });
    await flush();

    assert.deepEqual(env.preview.renderedBounds, { x: 50, y: 50, width: 100, height: 100 });

    env.stage.emit("pointerdown", leftClick());
    await pending;
    assert.equal(env.createCalls[0].data[0].x, 50);
    assert.equal(env.createCalls[0].data[0].y, 50);
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

test("placeWithLayerPreview commits against the scene captured at start (SCR-50)", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();

    // Scene swapped without canvasTearDown firing. The teardown hook makes this unreachable
    // today, so this guards the invariant rather than a live path: callers record sceneId from
    // the scene they resolved up front, and must never get a document on a different one.
    const swappedCalls = [];
    globalThis.canvas.scene = {
      async createEmbeddedDocuments(documentName, data) {
        swappedCalls.push({ documentName, data });
        return [{ id: "wrong-scene-tile" }];
      }
    };

    env.stage.emit("pointerdown", leftClick());

    assert.equal(await pending, null, "must not commit against a scene the caller did not resolve");
    assert.equal(swappedCalls.length, 0, "created against the swapped scene");
    assert.equal(env.createCalls.length, 0, "created against the captured scene");
    env.assertFullyUnregistered();
  } finally {
    env.restore();
  }
});

test("commit ignores duplicate clicks and queued Escape, then settles creation failure", async () => {
  const env = installFoundryEnvironment();
  let rejectCreate;
  try {
    canvas.scene.createEmbeddedDocuments = () => {
      env.createCalls.push({});
      return new Promise((_resolve, reject) => { rejectCreate = reject; });
    };
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();
    const queuedEscape = env.win.listeners[0].fn;
    const queuedClick = env.stage.handlers.get("pointerdown")[0];
    env.stage.emit("pointerdown", leftClick());
    queuedClick(leftClick());
    queuedEscape({ key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
    await assertStillPending(pending);
    assert.equal(env.createCalls.length, 1);
    env.assertFullyUnregistered();
    rejectCreate(new Error("expected server rejection"));
    assert.equal(await pending, null);
    env.assertFullyUnregistered();
  } finally { env.restore(); }
});

test("creation completion before abandonment retains the committed result", async () => {
  const env = installFoundryEnvironment();
  try {
    const pending = placeWithLayerPreview({ layerName: "tiles", createData: {} });
    await flush();
    env.stage.emit("pointerdown", leftClick());
    assert.equal(await pending, env.createdDoc);
    env.hooks.callAll("canvasTearDown");
    env.hooks.callAll("activateCanvasLayer", env.otherLayer);
    assert.equal(await pending, env.createdDoc);
    assert.equal(env.createCalls.length, 1);
    env.assertFullyUnregistered();
  } finally { env.restore(); }
});

/** Exercise public placement callers with their real Journal persistence. */
async function installPlacementCallerEnvironment() {
  const env = installFoundryEnvironment();
  const saved = Object.fromEntries(["game", "CONFIG", "sessionStorage"].map(key => [key, globalThis[key]]));
  foundry.applications = { api: { ApplicationV2: class {}, DialogV2: class {}, HandlebarsApplicationMixin: Base => class extends Base {} } };
  let stored = { id: "placement-p", gmUserId: "gm", canvasWidth: 100, canvasHeight: 100,
    assignments: { "placement-a": { id: "placement-a", promptId: "placement-p", userId: "player", status: "submitted",
      submittedAt: 10, savedSubmissionTs: 10, assets: { overlayPath: "ink.webp", mergedPath: "drawing.webp", tileWidth: 100, tileHeight: 100 } } } };
  const entry = { id: "placement-p", getFlag: () => stored,
    setFlag: async (_module, _flag, value) => { stored = structuredClone(value); return entry; } };
  const actor = { id: "created-actor", deleted: false,
    delete: async () => { actor.deleted = true; },
    getTokenDocument: async overrides => ({ toObject: () => ({ ...overrides }) }) };
  globalThis.game = { user: { id: "gm", isGM: true }, system: { id: "dnd5e" }, documentTypes: { Actor: ["npc"] },
    journal: { get: id => id === entry.id ? entry : null, [Symbol.iterator]: function* () { yield entry; } },
    actors: [{ uuid: "Actor.source", clone: async () => actor }],
    i18n: { localize: key => key } };
  globalThis.CONFIG = { Tile: { documentClass: { schema: { fields: { name: {} } } } },
    Actor: { documentClass: { create: async () => actor } } };
  globalThis.sessionStorage = { getItem: () => null };
  Object.assign(canvas.scene, { id: "original-scene", width: 1000, height: 1000, grid: { size: 100 } });
  canvas.tokens = new (class extends env.layer.constructor { static documentName = "Token"; })();
  const service = await import("../scripts/prompts/assignment-placement.mjs");
  return { ...env, actor, service, stored: () => stored, restore() {
    env.restore();
    for ( const [key, value] of Object.entries(saved) ) {
      if ( value === undefined ) delete globalThis[key]; else globalThis[key] = value;
    }
  } };
}

for ( const mode of ["tile", "newActor", "copyActor"] ) {
  test(`${mode} caller records delayed committed creation on original scene and retains its Actor`, async () => {
    const env = await installPlacementCallerEnvironment();
    let release;
    try {
      canvas.scene.createEmbeddedDocuments = async (documentName, data) => {
        env.createCalls.push({ documentName, data });
        await new Promise(resolve => { release = resolve; });
        return [env.createdDoc];
      };
      const pending = mode === "tile"
        ? env.service.placeAssignmentAsTile("placement-a", { interactive: true })
        : env.service.placeAssignmentAsToken("placement-a", { mode, name: "Drawing", actorUuid: "Actor.source", interactive: true });
      await flush();
      env.stage.emit("pointerdown", leftClick());
      env.hooks.callAll("canvasTearDown");
      canvas.scene = { id: "new-scene", createEmbeddedDocuments() { throw new Error("wrong scene"); } };
      await assertStillPending(pending);
      assert.equal(env.actor.deleted, false);
      release();
      assert.equal(await pending, env.createdDoc);
      assert.equal(env.actor.deleted, false);
      const records = env.stored().assignments["placement-a"].placements;
      assert.equal(records.length, 1);
      assert.equal(records[0].sceneId, "original-scene");
      assert.equal(records[0].kind, mode === "tile" ? "tile" : "token");
      assert.equal(env.createCalls[0].documentName, mode === "tile" ? "Tile" : "Token");
      if ( mode !== "tile" ) assert.equal(records[0].actorId, env.actor.id);
      env.assertFullyUnregistered();
    } finally { release?.(); env.restore(); }
  });
}

for ( const outcome of ["cancel", "failure", "scene-change-during-prepare"] ) {
  test(`Token ${outcome} cleans its temporary Actor without recording a placement`, async () => {
    const env = await installPlacementCallerEnvironment();
    try {
      if ( outcome === "scene-change-during-prepare" ) {
        env.actor.getTokenDocument = async overrides => {
          canvas.scene = { id: "other-scene" };
          return { toObject: () => ({ ...overrides }) };
        };
      }
      if ( outcome === "failure" ) canvas.scene.createEmbeddedDocuments = async () => { throw new Error("expected create failure"); };
      const pending = env.service.placeAssignmentAsToken("placement-a", { mode: "newActor", name: "Drawing", interactive: true });
      await flush();
      if ( outcome === "cancel" ) env.win.listeners[0].fn({ key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
      if ( outcome === "failure" ) env.stage.emit("pointerdown", leftClick());
      assert.equal(await pending, null);
      assert.equal(env.actor.deleted, true);
      assert.equal(env.stored().assignments["placement-a"].placements?.length ?? 0, 0);
      env.assertFullyUnregistered();
    } finally { env.restore(); }
  });
}
