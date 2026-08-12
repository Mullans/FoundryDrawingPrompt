import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hideApplicationForCanvasYield,
  previewPixelSize,
  restoreApplicationAfterCanvasYield,
  topLeftCenteredOn
} from "../scripts/foundry/canvas-place-preview.mjs";

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
