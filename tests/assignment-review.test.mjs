import assert from "node:assert/strict";
import { test } from "node:test";

import { FRAMING_VIEW, STATUS } from "../scripts/constants.mjs";
import {
  clearSourceFramingPreviewCacheForAssignment,
  pendingSubmissionOverlayPreviewSrc,
  pendingSubmissionPromptCanvasPreviewSrc,
  resolveAssignmentReview,
  resolveReviewContextSrc,
  shouldDeferFullFramingSourceFallback,
  sourceFramingPreviewCacheKey
} from "../scripts/prompts/assignment-review.mjs";

test("pendingSubmissionPromptCanvasPreviewSrc stamps staged paths", () => {
  assert.equal(pendingSubmissionPromptCanvasPreviewSrc(null), null);
  assert.equal(
    pendingSubmissionPromptCanvasPreviewSrc({
      mode: "staged",
      receiptTs: 42,
      staged: { mergedPath: "drawings/a.webp" }
    }),
    "drawings/a.webp?ts=42"
  );
  assert.equal(
    pendingSubmissionPromptCanvasPreviewSrc({
      mode: "inline",
      merged: { dataUrl: "data:image/webp;base64,abc" }
    }),
    "data:image/webp;base64,abc"
  );
});

test("pendingSubmissionOverlayPreviewSrc never prefers merged", () => {
  assert.equal(
    pendingSubmissionOverlayPreviewSrc({
      mode: "inline",
      merged: { dataUrl: "data:merged" },
      overlay: { dataUrl: "data:overlay" }
    }),
    "data:overlay"
  );
});

test("sourceFramingPreviewCacheKey is compact and stable", () => {
  const key = sourceFramingPreviewCacheKey("a1", "p1", "data:image/webp;base64,abcdefghijklmnop");
  assert.match(key, /^a1\|p1\|/);
  assert.equal(key, sourceFramingPreviewCacheKey("a1", "p1", "data:image/webp;base64,abcdefghijklmnop"));
});

test("clearSourceFramingPreviewCacheForAssignment drops only that assignment", () => {
  const cache = new Map([
    ["a1|p1|1|x|", "one"],
    ["a2|p1|1|y|", "two"]
  ]);
  clearSourceFramingPreviewCacheForAssignment(cache, "a1");
  assert.equal(cache.has("a1|p1|1|x|"), false);
  assert.equal(cache.get("a2|p1|1|y|"), "two");
});

test("resolveAssignmentReview Prompt-canvas prefers live snapshot", async () => {
  const result = await resolveAssignmentReview({
    assignment: { id: "a1", status: STATUS.OPENED, primaryImagePath: "saved.webp" },
    prompt: { id: "p1", canvasWidth: 400, canvasHeight: 300, background: { framedPath: "framed.webp" } },
    framingView: FRAMING_VIEW.PROMPT_CANVAS,
    liveSnapshot: "data:live",
    localize: key => key
  });
  assert.equal(result.src, "data:live");
  assert.deepEqual(result.plateAspect, { width: 400, height: 300 });
  assert.equal(result.framingView, FRAMING_VIEW.PROMPT_CANVAS);
});

test("resolveAssignmentReview Full Framing uses saved _full when Save gate open", async () => {
  const result = await resolveAssignmentReview({
    assignment: {
      id: "a1",
      status: STATUS.SUBMITTED,
      submittedAt: 10,
      savedSubmissionTs: 10,
      assets: { fullPath: "full.webp" },
      primaryImagePath: "merged.webp"
    },
    prompt: {
      id: "p1",
      canvasWidth: 400,
      canvasHeight: 300,
      background: { path: "source.jpg", naturalWidth: 800, naturalHeight: 600 }
    },
    framingView: FRAMING_VIEW.FULL,
    liveOverlaySnapshot: "data:overlay",
    localize: key => key
  });
  assert.equal(result.src, "full.webp");
  assert.deepEqual(result.plateAspect, { width: 800, height: 600 });
  assert.equal(result.canPlace, true);
});

test("resolveAssignmentReview Full Framing remaps via injectable builder + cache", async () => {
  const calls = [];
  const remapCache = new Map();
  const buildRemap = async ({ src }) => {
    calls.push(src);
    return `data:remapped:${src}`;
  };
  const prompt = {
    id: "p1",
    canvasWidth: 400,
    canvasHeight: 300,
    background: { path: "source.jpg", naturalWidth: 800, naturalHeight: 600 }
  };
  const assignment = { id: "a1", status: STATUS.OPENED, assets: {} };

  const first = await resolveAssignmentReview({
    assignment,
    prompt,
    framingView: FRAMING_VIEW.FULL,
    liveOverlaySnapshot: "data:overlay",
    remapCache,
    buildRemap,
    localize: key => key
  });
  assert.equal(first.src, "data:remapped:data:overlay");
  assert.equal(calls.length, 1);

  const second = await resolveAssignmentReview({
    assignment,
    prompt,
    framingView: FRAMING_VIEW.FULL,
    liveOverlaySnapshot: "data:overlay",
    remapCache,
    buildRemap,
    localize: key => key
  });
  assert.equal(second.src, "data:remapped:data:overlay");
  assert.equal(calls.length, 1, "cache hit skips remap");
});

test("resolveAssignmentReview falls back to source path when no overlay and no live composite", async () => {
  const result = await resolveAssignmentReview({
    assignment: { id: "a1", status: STATUS.OPENED, assets: {} },
    prompt: {
      id: "p1",
      canvasWidth: 400,
      canvasHeight: 300,
      background: { path: "source.jpg", naturalWidth: 800, naturalHeight: 600 }
    },
    framingView: FRAMING_VIEW.FULL,
    localize: key => key
  });
  assert.equal(result.src, "source.jpg");
  assert.equal(result.pendingRemap, false);
});

test("resolveAssignmentReview defers Full Framing when live composite exists without overlay", async () => {
  const result = await resolveAssignmentReview({
    assignment: { id: "a1", status: STATUS.OPENED, assets: {} },
    prompt: {
      id: "p1",
      canvasWidth: 400,
      canvasHeight: 300,
      background: { path: "source.jpg", naturalWidth: 800, naturalHeight: 600 }
    },
    framingView: FRAMING_VIEW.FULL,
    liveSnapshot: "data:live-composite",
    liveOverlaySnapshot: null,
    localize: key => key
  });
  assert.equal(result.src, null);
  assert.equal(result.pendingRemap, true);
});

test("resolveReviewContextSrc keeps the painted frame while a remap is pending", () => {
  assert.deepEqual(
    resolveReviewContextSrc({
      review: { src: null, heading: "Preview", pendingRemap: true },
      lastPaintedSrc: "data:prior-frame"
    }),
    { src: "data:prior-frame", heading: "Preview" }
  );
});

test("resolveReviewContextSrc falls back to the review src when nothing was painted yet", () => {
  assert.deepEqual(
    resolveReviewContextSrc({
      review: { src: null, heading: "Preview", pendingRemap: true },
      lastPaintedSrc: null
    }),
    { src: null, heading: "Preview" }
  );
});

test("resolveReviewContextSrc never overrides a settled review src", () => {
  // A settled null is a genuine empty state (no snapshot yet) and must stay empty --
  // only pendingRemap earns the prior frame.
  assert.deepEqual(
    resolveReviewContextSrc({
      review: { src: null, heading: "Preview", pendingRemap: false },
      lastPaintedSrc: "data:prior-frame"
    }),
    { src: null, heading: "Preview" }
  );
  assert.deepEqual(
    resolveReviewContextSrc({
      review: { src: "data:fresh", heading: "Preview", pendingRemap: false },
      lastPaintedSrc: "data:prior-frame"
    }),
    { src: "data:fresh", heading: "Preview" }
  );
});

test("resolveReviewContextSrc tolerates a missing review", () => {
  assert.deepEqual(resolveReviewContextSrc(), { src: null, heading: "" });
  assert.deepEqual(resolveReviewContextSrc({ lastPaintedSrc: "data:prior" }), { src: null, heading: "" });
});

test("a Full Framing composite-only tick renders the prior frame, not the empty state", async () => {
  // Regression: a body render during pendingRemap used to bind src=null, and the template's
  // {{else}} replaced the review plate with "no snapshot" until overlay ink arrived.
  const review = await resolveAssignmentReview({
    assignment: { id: "a1", status: STATUS.OPENED, assets: {} },
    prompt: {
      id: "p1",
      canvasWidth: 400,
      canvasHeight: 300,
      background: { path: "source.jpg", naturalWidth: 800, naturalHeight: 600 }
    },
    framingView: FRAMING_VIEW.FULL,
    liveSnapshot: "data:live-composite",
    liveOverlaySnapshot: null,
    localize: key => key
  });
  assert.equal(review.src, null);
  assert.equal(review.pendingRemap, true);

  const context = resolveReviewContextSrc({ review, lastPaintedSrc: "data:remapped-full" });
  assert.equal(context.src, "data:remapped-full");
});

test("shouldDeferFullFramingSourceFallback is true only with live composite and no overlay", () => {
  assert.equal(shouldDeferFullFramingSourceFallback({
    liveSnapshot: "data:live",
    overlaySrc: null
  }), true);
  assert.equal(shouldDeferFullFramingSourceFallback({
    liveSnapshot: "data:live",
    overlaySrc: "data:overlay"
  }), false);
  assert.equal(shouldDeferFullFramingSourceFallback({
    liveSnapshot: null,
    overlaySrc: null
  }), false);
});
