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

test("retained saved preview is inspectable after live cache loss and cannot be placed", async () => {
  const assignment = { id: "retained", status: STATUS.CANCELLED, retainedCapture: {
    kind: "saved-preview", receiptTs: 42, overlayPath: "saved-preview.webp", mergedPath: null
  } };
  const prompt = { id: "closed", canvasWidth: 400, canvasHeight: 300, background: { framedPath: "background.webp" } };
  const review = await resolveAssignmentReview({ assignment, prompt });
  assert.equal(review.src, "saved-preview.webp?ts=42");
  assert.equal(review.heading, "DRAWING-PROMPTS.manager.savedPreview");
  assert.equal(review.canPlace, false);
});

test("retained saved preview is a composite and never used as Full Framing ink", async () => {
  let remaps = 0;
  const review = await resolveAssignmentReview({
    assignment: { id: "retained", status: STATUS.CANCELLED, retainedCapture: {
      kind: "saved-preview", overlayPath: "composite.webp", receiptTs: 42
    } },
    prompt: { id: "closed", background: { path: "source.webp", naturalWidth: 800, naturalHeight: 600 } },
    framingView: FRAMING_VIEW.FULL,
    buildRemap: async () => { remaps++; return "remap"; }
  });
  assert.equal(remaps, 0);
  assert.equal(review.src, "source.webp");
  assert.equal(review.canPlace, false);
});

test("retained full submission survives cache loss in both Framing Views", async () => {
  const assignment = { id: "full", status: STATUS.CANCELLED, retainedCapture: {
    kind: "full-submission", receiptTs: 42, width: 400, height: 300,
    overlayPath: "ink.webp", mergedPath: "composite.webp"
  } };
  const prompt = { id: "closed", canvasWidth: 400, canvasHeight: 300,
    background: { path: "source.webp", framedPath: "framed.webp", naturalWidth: 800, naturalHeight: 600 } };
  const canvas = await resolveAssignmentReview({ assignment, prompt });
  assert.equal(canvas.src, "composite.webp?ts=42");
  assert.notEqual(canvas.heading, "DRAWING-PROMPTS.manager.savedPreview");
  const full = await resolveAssignmentReview({ assignment, prompt, framingView: FRAMING_VIEW.FULL,
    buildRemap: async ({ src, submission }) => {
      assert.equal(src, "ink.webp?ts=42");
      assert.equal(submission.width, 400);
      return "data:full-retained";
    }
  });
  assert.equal(full.src, "data:full-retained");
  assert.equal(canvas.canPlace, false);
  assert.equal(full.canPlace, false);
});

test("overlay-only retained full capture composites over framed Prompt background", async () => {
  const result = await resolveAssignmentReview({
    assignment: { id: "full", status: STATUS.CANCELLED, retainedCapture: {
      kind: "full-submission", overlayPath: "ink.webp", receiptTs: 42, width: 400, height: 300
    } },
    prompt: { id: "closed", canvasWidth: 400, canvasHeight: 300, background: { framedPath: "framed.webp" } },
    buildPromptCanvas: async ({ src, prompt, submission }) => {
      assert.equal(src, "ink.webp?ts=42");
      assert.equal(prompt.background.framedPath, "framed.webp");
      assert.equal(submission.width, 400);
      return "data:composed-retained";
    }
  });
  assert.equal(result.src, "data:composed-retained");
});

test("Saved preview cannot unlock Place using stale saved assets", async () => {
  const result = await resolveAssignmentReview({ assignment: {
    id: "preview", status: STATUS.SUBMITTED, submittedAt: 10, savedSubmissionTs: 10,
    primaryImagePath: "old.webp", assets: { overlayPath: "old.webp", fullPath: "old-full.webp" },
    retainedCapture: { kind: "saved-preview", overlayPath: "preview.webp", receiptTs: 42 }
  } });
  assert.equal(result.canPlace, false);
});

test("a newer submitted and saved drawing supersedes an older retained preview", async () => {
  const assignment = {
    id: "resubmitted", status: STATUS.SUBMITTED, submittedAt: 20, savedSubmissionTs: 20,
    primaryImagePath: "new.webp", assets: { overlayPath: "new-ink.webp", fullPath: "new-full.webp" },
    retainedCapture: { kind: "saved-preview", receiptTs: 10, overlayPath: "old-preview.webp" }
  };
  const prompt = { id: "reopened", background: { path: "source.webp", naturalWidth: 800, naturalHeight: 600 } };
  const canvas = await resolveAssignmentReview({ assignment, prompt });
  assert.equal(canvas.src, "new.webp");
  assert.notEqual(canvas.heading, "DRAWING-PROMPTS.manager.savedPreview");
  assert.equal(canvas.canPlace, true);
  const full = await resolveAssignmentReview({ assignment, prompt, framingView: FRAMING_VIEW.FULL });
  assert.equal(full.src, "new-full.webp");
  assert.equal(full.canPlace, true);
});

test("newer saved artwork supersedes an older retained full capture in both Framing Views", async () => {
  const assignment = {
    id: "resubmitted-full", status: STATUS.SUBMITTED, submittedAt: 20, savedSubmissionTs: 20,
    primaryImagePath: "new-composite.webp", assets: { overlayPath: "new-ink.webp", fullPath: "new-full.webp" },
    retainedCapture: { kind: "full-submission", receiptTs: 10, width: 400, height: 300,
      overlayPath: "old-ink.webp", mergedPath: "old-composite.webp" }
  };
  const prompt = { id: "reopened", canvasWidth: 400, canvasHeight: 300,
    background: { path: "source.webp", naturalWidth: 800, naturalHeight: 600 } };
  const canvas = await resolveAssignmentReview({ assignment, prompt });
  assert.equal(canvas.src, "new-composite.webp");
  assert.equal(canvas.canPlace, true);
  const full = await resolveAssignmentReview({ assignment, prompt, framingView: FRAMING_VIEW.FULL });
  assert.equal(full.src, "new-full.webp");
  assert.equal(full.canPlace, true);
});

test("equal and newer retained full captures remain eligible for review", async () => {
  for (const receiptTs of [20, 30]) {
    const review = await resolveAssignmentReview({ assignment: {
      id: "retained-current", status: STATUS.SUBMITTED, submittedAt: 20, savedSubmissionTs: 20,
      primaryImagePath: "saved.webp", assets: { overlayPath: "saved-ink.webp" },
      retainedCapture: { kind: "full-submission", receiptTs, overlayPath: "retained-ink.webp", mergedPath: "retained.webp" }
    } });
    assert.equal(review.src, `retained.webp?ts=${receiptTs}`);
  }
});

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
