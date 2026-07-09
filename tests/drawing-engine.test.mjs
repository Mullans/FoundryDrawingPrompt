import assert from "node:assert/strict";
import { test } from "node:test";

import { DrawingEngine, mapClientPointToLogical } from "../scripts/drawing/drawing-engine.mjs";

test("mapClientPointToLogical maps CSS-scaled display coordinates to logical pixels", () => {
  const point = mapClientPointToLogical({
    clientX: 250,
    clientY: 125,
    rect: { left: 50, top: 25, width: 400, height: 200 },
    width: 800,
    height: 400
  });

  assert.deepEqual(point, { x: 400, y: 200 });
});

test("mapClientPointToLogical clamps points to the logical canvas bounds", () => {
  const point = mapClientPointToLogical({
    clientX: -100,
    clientY: 999,
    rect: { left: 0, top: 0, width: 100, height: 100 },
    width: 300,
    height: 200
  });

  assert.deepEqual(point, { x: 0, y: 199 });
});

test("DrawingEngine records brush opacity on stroke operations", () => {
  installFakeCanvas();
  globalThis.requestAnimationFrame = callback => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "op-opacity" }
  });

  const engine = new DrawingEngine({ width: 16, height: 16 });
  engine.setBrushOpacity(0.35);
  engine.beginStroke("stroke", { x: 1, y: 1 });
  engine.extendStroke({ x: 8, y: 8 });
  engine.commitStroke({ x: 12, y: 12 });

  assert.equal(engine.getOpLog().ops[0].opacity, 0.35);
});

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
    return { data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData() {}
}
