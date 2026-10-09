import assert from "node:assert/strict";
import { test } from "node:test";

import { PixelTileHistory } from "../scripts/drawing/pixel-tile-history.mjs";

test("pixel history retains only the 25 newest actions without changing current pixels", () => {
  const surface = new FakeSurface(1, 1);
  const history = new PixelTileHistory({ width: 1, height: 1, tileSize: 1 });

  for ( let value = 1; value <= 30; value++ ) {
    const before = surface.copy();
    surface.set(value);
    assert.equal(history.commit({ id: `a${value}`, kind: "stroke", tiles: [[0, 0]], before, after: surface }), true);
  }

  assert.equal(surface.value(), 30);
  let undos = 0;
  while ( history.undo(surface) ) undos++;
  assert.equal(undos, 25);
  assert.equal(surface.value(), 5);
});

test("pixel history restores Redo exactly and a no-op preserves the Redo tail", () => {
  const surface = new FakeSurface(1, 1);
  const history = new PixelTileHistory({ width: 1, height: 1, tileSize: 1 });
  const commit = value => {
    const before = surface.copy();
    surface.set(value);
    return history.commit({ id: `a${value}`, kind: "stroke", tiles: [[0, 0]], before, after: surface });
  };

  commit(1);
  commit(2);
  assert.equal(history.undo(surface), true);
  assert.equal(surface.value(), 1);
  assert.equal(history.commit({ id: "noop", kind: "stroke", tiles: [[0, 0]], before: surface.copy(), after: surface }), false);
  assert.equal(history.redo(surface), true);
  assert.equal(surface.value(), 2);
});

test("a real edit after Undo discards Redo", () => {
  const surface = new FakeSurface(1, 1);
  const history = new PixelTileHistory({ width: 1, height: 1, tileSize: 1 });
  for ( const value of [1, 2] ) {
    const before = surface.copy();
    surface.set(value);
    history.commit({ id: `a${value}`, kind: "stroke", tiles: [[0, 0]], before, after: surface });
  }
  history.undo(surface);
  const before = surface.copy();
  surface.set(3);
  history.commit({ id: "branch", kind: "fill", tiles: [[0, 0]], before, after: surface });

  assert.equal(history.canRedo, false);
  assert.equal(history.undo(surface), true);
  assert.equal(surface.value(), 1);
});

test("a recovery snapshot restores current artwork, Undo, and Redo without replay", () => {
  const surface = new FakeSurface(1, 1);
  const history = new PixelTileHistory({ width: 1, height: 1, tileSize: 1 });
  for ( const value of [1, 2, 3] ) {
    const before = surface.copy();
    surface.set(value);
    history.commit({ id: `a${value}`, kind: "stroke", tiles: [[0, 0]], before, after: surface });
  }
  history.undo(surface);
  const snapshot = history.snapshot();

  const recoveredSurface = new FakeSurface(1, 1);
  const recovered = PixelTileHistory.restore(snapshot, recoveredSurface);
  assert.equal(recoveredSurface.value(), 2);
  assert.equal(recovered.undo(recoveredSurface), true);
  assert.equal(recoveredSurface.value(), 1);
  assert.equal(recovered.redo(recoveredSurface), true);
  assert.equal(recoveredSurface.value(), 2);
  assert.equal(recovered.redo(recoveredSurface), true);
  assert.equal(recoveredSurface.value(), 3);
});

test("a gesture prepares changed tiles incrementally and seals them as one action", () => {
  const surface = new FakeSurface(2, 1);
  const before = surface.copy();
  const history = new PixelTileHistory({ width: 2, height: 1, tileSize: 1 });
  history.beginEdit();
  surface.data.set([1, 1, 1, 255], 0);
  history.updateEdit({ tiles: [[0, 0]], before, after: surface });
  surface.data.set([2, 2, 2, 255], 4);
  history.updateEdit({ tiles: [[1, 0]], before, after: surface });

  assert.equal(history.commitEdit({ id: "gesture", kind: "stroke" }), true);
  assert.equal(history.actionCount, 1);
  assert.equal(history.undo(surface), true);
  assert.deepEqual([...surface.data], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test("Clear records compact transparent after-versions and remains undoable", () => {
  const surface = new FakeSurface(2, 1);
  const history = new PixelTileHistory({ width: 2, height: 1, tileSize: 1 });
  const blank = surface.copy();
  surface.data.set([9, 9, 9, 255], 0);
  history.commit({ id: "draw", kind: "stroke", tiles: [[0, 0]], before: blank, after: surface });
  const beforeBytes = history.allocatedBytes;
  const beforeClear = surface.copy();
  surface.clearRect(0, 0, 2, 1);

  assert.equal(history.commitClear({ id: "clear", before: beforeClear }), true);
  assert.equal(history.allocatedBytes, beforeBytes);
  history.undo(surface);
  assert.equal(surface.value(), 9);
});

test("recovery snapshots cannot mutate the live immutable tile store", () => {
  const surface = new FakeSurface(2, 1);
  const history = new PixelTileHistory({ width: 2, height: 1, tileSize: 2 });
  const before = surface.copy();
  surface.data.set([1, 2, 3, 255, 4, 5, 6, 255]);
  history.commit({ id: "draw", kind: "stroke", tiles: [[0, 0]], before, after: surface });
  const snapshot = history.snapshot();
  snapshot.versions.find(version => version.kind === "rgba").data.fill(99);

  history.undo(surface);
  history.redo(surface);
  assert.deepEqual([...surface.data], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("metadata pressure evicts old actions while retaining the latest action", () => {
  const surface = new FakeSurface(2, 1);
  const history = new PixelTileHistory({ width: 2, height: 1, tileSize: 1, metadataBudget: 400 });
  for ( let value = 1; value <= 4; value++ ) {
    const before = surface.copy();
    surface.data.set([value, value, value, 255, value + 1, value + 1, value + 1, 255]);
    history.commit({ id: `a${value}`, kind: "fill", tiles: [[0, 0], [1, 0]], before, after: surface });
  }
  assert.equal(history.actionCount, 1);
  assert.equal(history.undo(surface), true);
  assert.equal(surface.value(), 3);
});

test("Undo and Redo swap one directional reference without growing retained versions", () => {
  const surface = new FakeSurface(1, 1);
  const history = new PixelTileHistory({ width: 1, height: 1, tileSize: 1, writerId: "test" });
  for ( const value of [1, 2] ) {
    const before = surface.copy(); surface.set(value);
    history.commit({ id: `a${value}`, kind: "stroke", tiles: [0], before, after: surface });
  }
  const initial = history.snapshot();
  assert.deepEqual(initial.entries[1].changes, [[0, "test:1"]]);
  assert.equal(Object.hasOwn(initial.entries[1].changes[0], "before"), false);
  const versionCount = initial.versions.length;

  for ( let cycle = 0; cycle < 10; cycle++ ) {
    assert.equal(history.undo(surface), true);
    assert.equal(history.redo(surface), true);
  }
  assert.equal(surface.value(), 2);
  assert.equal(history.snapshot().versions.length, versionCount);
});

class FakeSurface {
  constructor(width, height, data = null) {
    this.width = width;
    this.height = height;
    this.data = data ? new Uint8ClampedArray(data) : new Uint8ClampedArray(width * height * 4);
  }

  copy() {
    return new FakeSurface(this.width, this.height, this.data);
  }

  set(value) {
    this.data.set([value, value, value, 255]);
  }

  value() {
    return this.data[0];
  }

  getImageData(x, y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for ( let row = 0; row < height; row++ ) {
      for ( let col = 0; col < width; col++ ) {
        const source = ((y + row) * this.width + x + col) * 4;
        data.set(this.data.subarray(source, source + 4), (row * width + col) * 4);
      }
    }
    return { width, height, data };
  }

  putImageData(image, x, y) {
    for ( let row = 0; row < image.height; row++ ) {
      for ( let col = 0; col < image.width; col++ ) {
        const target = ((y + row) * this.width + x + col) * 4;
        const source = (row * image.width + col) * 4;
        this.data.set(image.data.subarray(source, source + 4), target);
      }
    }
  }

  clearRect(x, y, width, height) {
    for ( let row = y; row < y + height; row++ ) {
      for ( let col = x; col < x + width; col++ ) this.data.fill(0, (row * this.width + col) * 4, (row * this.width + col + 1) * 4);
    }
  }
}
