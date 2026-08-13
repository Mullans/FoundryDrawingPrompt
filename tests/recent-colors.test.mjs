import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeRecentHex,
  parseRecentColors,
  pushRecentColor,
  recentColorSlots,
  serializeRecentColors,
  shouldRecordDrawnColor
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

test("shouldRecordDrawnColor records a new stroke or fill at the tip", () => {
  assert.deepEqual(
    shouldRecordDrawnColor({ op: { id: "op-1", type: "stroke", color: "#ff0000" }, lastRecordedOpId: null }),
    { record: true, nextLastRecordedOpId: "op-1" }
  );
  assert.deepEqual(
    shouldRecordDrawnColor({ op: { id: "op-2", type: "fill", color: "#00ff00" }, lastRecordedOpId: "op-1" }),
    { record: true, nextLastRecordedOpId: "op-2" }
  );
});

test("shouldRecordDrawnColor adopts the tip id while suppressed without recording", () => {
  // SCR-55: restoration replays the stored op log and the engine emits onChange.
  // Suppression must skip the *record* but still claim the id.
  assert.deepEqual(
    shouldRecordDrawnColor({
      op: { id: "restored-9", type: "stroke", color: "#123456" },
      lastRecordedOpId: null,
      suppressed: true
    }),
    { record: false, nextLastRecordedOpId: "restored-9" }
  );
});

test("shouldRecordDrawnColor does not re-record a replayed tip after suppression lifts", () => {
  // Regression for the whole point of adopting the id: replay, then a later
  // onChange for the same unchanged tip must stay silent.
  const replayed = { id: "restored-9", type: "stroke", color: "#123456" };
  const afterReplay = shouldRecordDrawnColor({ op: replayed, lastRecordedOpId: null, suppressed: true });
  assert.equal(afterReplay.record, false);

  const secondLook = shouldRecordDrawnColor({
    op: replayed,
    lastRecordedOpId: afterReplay.nextLastRecordedOpId,
    suppressed: false
  });
  assert.deepEqual(secondLook, { record: false, nextLastRecordedOpId: "restored-9" });

  // A genuinely new stroke afterwards still records.
  const fresh = shouldRecordDrawnColor({
    op: { id: "op-10", type: "stroke", color: "#abcdef" },
    lastRecordedOpId: secondLook.nextLastRecordedOpId,
    suppressed: false
  });
  assert.deepEqual(fresh, { record: true, nextLastRecordedOpId: "op-10" });
});

test("shouldRecordDrawnColor treats a repeated tip id as a no-op", () => {
  assert.deepEqual(
    shouldRecordDrawnColor({ op: { id: "op-1", type: "stroke", color: "#ff0000" }, lastRecordedOpId: "op-1" }),
    { record: false, nextLastRecordedOpId: "op-1" }
  );
});

test("shouldRecordDrawnColor ignores op types that are not stroke or fill", () => {
  for ( const type of ["image", "clear", "text", undefined] ) {
    assert.deepEqual(
      shouldRecordDrawnColor({ op: { id: `op-${type}`, type, color: "#ff0000" }, lastRecordedOpId: null }),
      { record: false, nextLastRecordedOpId: `op-${type}` },
      `type ${type} must not record but must still adopt the id`
    );
  }
});

test("shouldRecordDrawnColor ignores a stroke with no color", () => {
  for ( const color of [undefined, null, ""] ) {
    assert.deepEqual(
      shouldRecordDrawnColor({ op: { id: "op-3", type: "stroke", color }, lastRecordedOpId: null }),
      { record: false, nextLastRecordedOpId: "op-3" }
    );
  }
});

test("shouldRecordDrawnColor is inert with no tip op", () => {
  // The app passes null when the op-log pointer sits behind the end (post-undo)
  // or the log is empty; the retained id must survive untouched.
  assert.deepEqual(
    shouldRecordDrawnColor({ op: null, lastRecordedOpId: "op-7" }),
    { record: false, nextLastRecordedOpId: "op-7" }
  );
  assert.deepEqual(shouldRecordDrawnColor(), { record: false, nextLastRecordedOpId: null });
});
