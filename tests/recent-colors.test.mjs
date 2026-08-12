import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeRecentHex,
  parseRecentColors,
  pushRecentColor,
  recentColorSlots,
  serializeRecentColors
} from "../scripts/drawing/recent-colors.mjs";

test("normalizeRecentHex accepts 3- and 6-digit hex", () => {
  assert.equal(normalizeRecentHex("#AbC"), "#aabbcc");
  assert.equal(normalizeRecentHex("#ff00aa"), "#ff00aa");
  assert.equal(normalizeRecentHex("nope"), null);
});

test("pushRecentColor keeps last 3 distinct colors most-recent first", () => {
  let history = [];
  history = pushRecentColor(history, "#ff0000");
  history = pushRecentColor(history, "#00ff00");
  history = pushRecentColor(history, "#0000ff");
  history = pushRecentColor(history, "#ffffff");
  assert.deepEqual(history, ["#ffffff", "#0000ff", "#00ff00"]);
  history = pushRecentColor(history, "#0000ff");
  assert.deepEqual(history, ["#0000ff", "#ffffff", "#00ff00"]);
});

test("recentColorSlots always returns fixed-length slots with null empties", () => {
  assert.deepEqual(recentColorSlots(["#ff0000"], 3), ["#ff0000", null, null]);
  assert.deepEqual(recentColorSlots([], 3), [null, null, null]);
});

test("parseRecentColors and serializeRecentColors round-trip JSON", () => {
  const serialized = serializeRecentColors(["#ff0000", "#00FF00", "bad", "#00ff00"]);
  assert.equal(serialized, JSON.stringify(["#ff0000", "#00ff00"]));
  assert.deepEqual(parseRecentColors(serialized), ["#ff0000", "#00ff00"]);
});
