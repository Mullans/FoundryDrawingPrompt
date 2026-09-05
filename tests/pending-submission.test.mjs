import assert from "node:assert/strict";
import { test } from "node:test";

import { formatFromAssetPath } from "../scripts/prompts/pending-submission.mjs";

test("formatFromAssetPath maps common image extensions", () => {
  assert.equal(formatFromAssetPath("drawings/a.webp"), "webp");
  assert.equal(formatFromAssetPath("drawings/a.PNG"), "png");
  assert.equal(formatFromAssetPath("drawings/a.jpg"), "jpeg");
  assert.equal(formatFromAssetPath("drawings/a.jpeg"), "jpeg");
  assert.equal(formatFromAssetPath("drawings/a"), "webp");
  assert.equal(formatFromAssetPath(""), "webp");
});
