import assert from "node:assert/strict";
import { test } from "node:test";

import { DrawingEngine } from "../scripts/drawing/drawing-engine.mjs";
import { LineTool } from "../scripts/drawing/tools/line-tool.mjs";

test("LineTool accumulates vertices and commits a stroke with N points", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 32, height: 32 });
  engine.setTool("line");
  const tool = new LineTool();
  const ctx = toolContext(engine);

  tool.onPointerDown({ x: 2, y: 2 }, ctx);
  tool.onPointerMove({ x: 10, y: 2 }, ctx);
  tool.onPointerDown({ x: 10, y: 2 }, ctx);
  tool.onPointerDown({ x: 10, y: 20 }, ctx);
  assert.equal(tool.isDrafting(), true);
  assert.equal(tool.commit(ctx), true);
  assert.equal(tool.isDrafting(), false);

  const ops = engine.getOpLog().ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "stroke");
  assert.equal(ops[0].straight, true);
  assert.equal(ops[0].points.length, 3);
  assert.deepEqual(ops[0].points[0], { x: 2, y: 2 });
  assert.deepEqual(ops[0].points[2], { x: 10, y: 20 });
});

test("LineTool cancel drops the draft without committing", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  const tool = new LineTool();
  const ctx = toolContext(engine);

  tool.onPointerDown({ x: 1, y: 1 }, ctx);
  tool.onPointerDown({ x: 8, y: 8 }, ctx);
  tool.cancel(ctx);
  assert.equal(tool.isDrafting(), false);
  assert.equal(engine.getOpLog().ops.length, 0);
});

test("LineTool commit with fewer than two vertices is a no-op", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  const tool = new LineTool();
  const ctx = toolContext(engine);

  tool.onPointerDown({ x: 4, y: 4 }, ctx);
  assert.equal(tool.commit(ctx), false);
  assert.equal(engine.getOpLog().ops.length, 0);
});

test("LineTool onDoubleClick commits after deduping the trailing click", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  const tool = new LineTool();
  const ctx = toolContext(engine);

  tool.onPointerDown({ x: 1, y: 1 }, ctx);
  tool.onPointerDown({ x: 12, y: 1 }, ctx);
  // Second click of a double-click near the previous vertex.
  tool.onPointerDown({ x: 12.5, y: 1.2 }, ctx);
  assert.equal(tool.onDoubleClick({ x: 12.5, y: 1.2 }, ctx), true);
  const ops = engine.getOpLog().ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].points.length, 2);
});

test("DrawingEngine undo discards an in-progress line draft before history restore", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  seedCommittedStroke(engine);
  assert.equal(engine.getOpLog().ops.length, 1);

  beginLineDraft(engine, [
    { x: 1, y: 1 },
    { x: 10, y: 10 }
  ]);
  assert.equal(engine.undo(), true);
  // If the draft were still active, commit would succeed and re-pollute history.
  assert.equal(engine.commitLineDraft(), false);
  assert.equal(engine.getOpLog().pointer, 0);
  assert.equal(engine.getOpLog().ops.length, 1);
});

test("DrawingEngine clearLayer discards an in-progress line draft", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  beginLineDraft(engine, [
    { x: 2, y: 2 },
    { x: 8, y: 8 }
  ]);
  engine.clearLayer();
  assert.equal(engine.commitLineDraft(), false);
  assert.equal(engine.getOpLog().ops.at(-1)?.type, "clear");
});

test("DrawingEngine commitLineDraft before submit keeps pixels and op log aligned", () => {
  installFakeCanvas();
  const engine = new DrawingEngine({ width: 16, height: 16 });
  beginLineDraft(engine, [
    { x: 1, y: 1 },
    { x: 12, y: 4 }
  ]);
  assert.equal(engine.commitLineDraft(), true);
  assert.equal(engine.cancelLineDraft(), false);
  const ops = engine.getOpLog().ops;
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "stroke");
  assert.equal(ops[0].straight, true);
  assert.equal(ops[0].points.length, 2);
});

function toolContext(engine) {
  return {
    previewPolyline: points => engine.previewPolyline(points),
    cancelStrokePreview: () => engine.cancelStrokePreview(),
    commitStrokePreview: () => engine.commitStrokePreview()
  };
}

function seedCommittedStroke(engine) {
  engine.beginStroke("stroke", { x: 0, y: 0 });
  engine.extendStroke({ x: 5, y: 5 });
  engine.commitStroke({ x: 5, y: 5 });
}

/**
 * Drive the engine-owned line tool into a multi-vertex draft via pointer events.
 * @param {DrawingEngine} engine Engine.
 * @param {{x: number, y: number}[]} points Logical points.
 */
function beginLineDraft(engine, points) {
  const display = createFakeDisplay(engine.width, engine.height);
  engine.attach(display);
  engine.setTool("line");
  let pointerId = 1;
  for ( const point of points ) {
    firePointer(display, "pointerdown", {
      clientX: point.x,
      clientY: point.y,
      pointerId
    });
    firePointer(display, "pointerup", {
      clientX: point.x,
      clientY: point.y,
      pointerId
    });
    pointerId += 1;
  }
}

function createFakeDisplay(width, height) {
  const target = new EventTarget();
  const display = Object.assign(target, {
    width,
    height,
    context: new FakeContext(),
    getContext() {
      return this.context;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width, height };
    }
  });
  return display;
}

function firePointer(display, type, { clientX, clientY, pointerId }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerId: { value: pointerId }
  });
  display.dispatchEvent(event);
}

function installFakeCanvas() {
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.context = new FakeContext();
    }

    getContext() {
      return this.context;
    }
  };
  delete globalThis.document;
  globalThis.requestAnimationFrame = callback => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => `op-${Math.random().toString(16).slice(2)}` }
  });
}

class FakeContext {
  save() {}
  restore() {}
  clearRect() {}
  drawImage() {}
  beginPath() {}
  arc() {}
  fill() {}
  moveTo() {}
  quadraticCurveTo() {}
  lineTo() {}
  stroke() {}
  setTransform() {}
  getImageData(_x, _y, width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }
  putImageData() {}
}
