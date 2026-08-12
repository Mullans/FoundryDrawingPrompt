import assert from "node:assert/strict";
import { test } from "node:test";

import { FRAMING_VIEW } from "../scripts/constants.mjs";
import {
  firstPreviewSrc,
  resolvePromptCanvasReviewSrc,
  resolveReviewPlateAspect,
  resolveSourceFramingReviewSrc
} from "../scripts/prompts/review-preview.mjs";

test("firstPreviewSrc skips empty and null candidates", () => {
  assert.equal(firstPreviewSrc(null, "", "ok"), "ok");
  assert.equal(firstPreviewSrc(null, "", null), null);
});

test("resolvePromptCanvasReviewSrc prefers live over saved and framed", () => {
  assert.equal(resolvePromptCanvasReviewSrc({
    liveSrc: "data:live",
    pendingSrc: "pending.webp",
    savedPath: "saved.webp",
    framedPath: "framed.webp"
  }), "data:live");
});

test("resolvePromptCanvasReviewSrc uses pending then saved then framed", () => {
  assert.equal(resolvePromptCanvasReviewSrc({
    pendingSrc: "pending.webp",
    savedPath: "saved.webp",
    framedPath: "framed.webp"
  }), "pending.webp");
  assert.equal(resolvePromptCanvasReviewSrc({
    savedPath: "saved.webp",
    framedPath: "framed.webp"
  }), "saved.webp");
  assert.equal(resolvePromptCanvasReviewSrc({
    framedPath: "framed.webp"
  }), "framed.webp");
  assert.equal(resolvePromptCanvasReviewSrc({}), null);
});

test("resolveSourceFramingReviewSrc prefers saved full then remapped then source", () => {
  assert.equal(resolveSourceFramingReviewSrc({
    savedFullPath: "full.webp",
    remappedSrc: "data:remap",
    sourcePath: "source.jpg"
  }), "full.webp");
  assert.equal(resolveSourceFramingReviewSrc({
    remappedSrc: "data:remap",
    sourcePath: "source.jpg"
  }), "data:remap");
  assert.equal(resolveSourceFramingReviewSrc({
    sourcePath: "source.jpg"
  }), "source.jpg");
  assert.equal(resolveSourceFramingReviewSrc({}), null);
});

test("resolveReviewPlateAspect uses prompt canvas for Prompt-canvas view", () => {
  assert.deepEqual(resolveReviewPlateAspect({
    framingView: FRAMING_VIEW.PROMPT_CANVAS,
    prompt: {
      canvasWidth: 800,
      canvasHeight: 600,
      background: { naturalWidth: 1920, naturalHeight: 1080 }
    },
    hasSource: true
  }), { width: 800, height: 600 });
});

test("resolveReviewPlateAspect uses composition size for Full Framing", () => {
  assert.deepEqual(resolveReviewPlateAspect({
    framingView: FRAMING_VIEW.FULL,
    prompt: {
      canvasWidth: 800,
      canvasHeight: 600,
      background: { naturalWidth: 1920, naturalHeight: 1080 }
    },
    hasSource: true
  }), { width: 1920, height: 1080 });
});

test("resolveReviewPlateAspect expands Full Framing plate for pad framing", () => {
  assert.deepEqual(resolveReviewPlateAspect({
    framingView: FRAMING_VIEW.FULL,
    prompt: {
      canvasWidth: 100,
      canvasHeight: 100,
      background: {
        naturalWidth: 4,
        naturalHeight: 4,
        framing: { x: -1, y: -1, width: 6, height: 6 }
      }
    },
    hasSource: true
  }), { width: 6, height: 6 });
});

test("resolveReviewPlateAspect falls back to prompt canvas without source dims", () => {
  assert.deepEqual(resolveReviewPlateAspect({
    framingView: FRAMING_VIEW.FULL,
    prompt: { canvasWidth: 512, canvasHeight: 256, background: {} },
    hasSource: false
  }), { width: 512, height: 256 });
});
