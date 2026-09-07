import test from "node:test";
import assert from "node:assert/strict";
import { selectLiveSnapshotPayload } from "../scripts/prompts/live-snapshot.mjs";
import { INTERNAL } from "../scripts/constants.mjs";

const image = bytes => "data:image/png;base64,".padEnd(bytes, "A");
test("Full Framing keeps the current overlay when the pair exceeds the shared cap", () => {
  const composite = image(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES / 2 + 1);
  const overlay = image(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES / 2);
  assert.deepEqual(selectLiveSnapshotPayload({ composite, overlay, overlayRequested: true }), { overlay });
});

test("a pair exactly at the cap keeps both views", () => {
  const composite = image(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES / 2);
  const overlay = composite;
  assert.deepEqual(selectLiveSnapshotPayload({ composite, overlay, overlayRequested: true }), { composite, overlay });
});

test("successive oversized pairs retain each new overlay, never the earlier frame", () => {
  const composite = image(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES);
  for ( const overlay of [image(100), image(200)] ) {
    const payload = selectLiveSnapshotPayload({ composite, overlay, overlayRequested: true });
    assert.deepEqual(Object.keys(payload), ["overlay"]);
    assert.equal(payload.overlay, overlay);
  }
});

test("Prompt canvas ignores unrequested overlay and invalid data never travels", () => {
  const composite = image(100);
  assert.deepEqual(selectLiveSnapshotPayload({ composite, overlay: image(200) }), { composite });
  assert.deepEqual(selectLiveSnapshotPayload({ composite, overlay: "bad", overlayRequested: true }), { composite });
  assert.equal(selectLiveSnapshotPayload({ composite: "bad", overlay: "bad", overlayRequested: true }), null);
  assert.equal(selectLiveSnapshotPayload({ composite: image(INTERNAL.MAX_SNAPSHOT_WIRE_BYTES + 1) }), null);
});
