import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTokenTransformPlan,
  isTransformConfirmationNeeded
} from "../scripts/foundry/token-transform-service.mjs";

test("isTransformConfirmationNeeded skips confirmation for zero or one target", () => {
  assert.equal(isTransformConfirmationNeeded(0), false);
  assert.equal(isTransformConfirmationNeeded(1), false);
});

test("isTransformConfirmationNeeded requires confirmation for multiple targets", () => {
  assert.equal(isTransformConfirmationNeeded(2), true);
});

test("buildTokenTransformPlan stores the current texture when no original flag exists", () => {
  const token = { id: "fresh" };

  assert.deepEqual(buildTokenTransformPlan([{
    token,
    currentTexture: "tokens/original.webp",
    originalTexture: undefined
  }]), [{
    token,
    originalTexture: "tokens/original.webp",
    shouldStoreOriginal: true
  }]);
});

test("buildTokenTransformPlan preserves the true original texture when re-applying", () => {
  const token = { id: "transformed" };

  assert.deepEqual(buildTokenTransformPlan([{
    token,
    currentTexture: "drawings/previous.webp",
    originalTexture: "tokens/true-original.webp"
  }]), [{
    token,
    originalTexture: "tokens/true-original.webp",
    shouldStoreOriginal: false
  }]);
});
