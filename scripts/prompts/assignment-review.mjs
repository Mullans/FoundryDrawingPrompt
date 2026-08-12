/**
 * Deep Assignment review: Framing View seed ladder, Save-gate paths, Full Framing
 * remap/cache policy, plate aspect, and Place enablement behind one interface.
 *
 * Callers (GM manager) supply live/pending inputs and optional remap cache;
 * Foundry globals stay outside this module.
 */

import { FRAMING_VIEW, STATUS } from "../constants.mjs";
import {
  buildSourceFramingPreviewDataUrl,
  canPlaceFramingView,
  hasSourceBackground,
  normalizeFramingView,
  pickSubmissionOverlaySrc,
  pickSubmissionPromptCanvasSrc,
  resolveFramingViewAssetPath
} from "./dual-save.mjs";
import {
  resolvePromptCanvasReviewSrc,
  resolveReviewPlateAspect,
  resolveSourceFramingReviewSrc
} from "./review-preview.mjs";
import { isSaveGateOpen } from "./transitions.mjs";

/**
 * @typedef {object} AssignmentReviewResult
 * @property {string|null} src Preview image URL / data URL.
 * @property {string} heading Preview panel heading.
 * @property {{width: number, height: number}} plateAspect Canvas plate aspect box.
 * @property {boolean} canPlace Whether Place/Transform may run for this view.
 * @property {string} framingView Normalized Framing View id.
 * @property {boolean} pendingRemap True when Full Framing is waiting on live overlay ink
 *   (caller must keep the prior frame — never flash bare source).
 */

/**
 * Whether Full Framing should defer painting instead of falling back to the bare source.
 * Live Prompt-canvas composites arrive before overlay ink; source-alone would flash underlay.
 * @param {{liveSnapshot?: string|null, overlaySrc?: string|null}} [options]
 * @returns {boolean}
 */
export function shouldDeferFullFramingSourceFallback({ liveSnapshot = null, overlaySrc = null } = {}) {
  return Boolean(liveSnapshot) && !overlaySrc;
}

/**
 * Resolve a Prompt-canvas preview source from a cached pending submission (prefers merged).
 * @param {object|null|undefined} submission Submission payload.
 * @returns {string|null}
 */
export function pendingSubmissionPromptCanvasPreviewSrc(submission) {
  const src = pickSubmissionPromptCanvasSrc(submission);
  if ( !src ) return null;
  if ( submission?.mode === "staged" ) {
    return `${encodeURI(src)}?ts=${encodeURIComponent(String(submission.receiptTs ?? Date.now()))}`;
  }
  return src;
}

/**
 * Resolve an overlay-only preview source for Full Framing remap (never merged).
 * @param {object|null|undefined} submission Submission payload.
 * @returns {string|null}
 */
export function pendingSubmissionOverlayPreviewSrc(submission) {
  const src = pickSubmissionOverlaySrc(submission);
  if ( !src ) return null;
  if ( submission?.mode === "staged" ) {
    return `${encodeURI(src)}?ts=${encodeURIComponent(String(submission.receiptTs ?? Date.now()))}`;
  }
  return src;
}

/**
 * Compact cache key for Full Framing remapped previews (avoid storing full data URLs as keys).
 * @param {string} assignmentId Assignment id.
 * @param {string} promptId Prompt id.
 * @param {string} src Overlay image source.
 * @returns {string}
 */
export function sourceFramingPreviewCacheKey(assignmentId, promptId, src) {
  const value = String(src ?? "");
  const head = value.slice(0, 48);
  const tail = value.length > 64 ? value.slice(-24) : "";
  return `${assignmentId}|${promptId}|${value.length}|${head}|${tail}`;
}

/**
 * Drop remap cache entries for an assignment (other overlay keys), keeping growth bounded.
 * @param {Map<string, string>} cache Remap cache.
 * @param {string} assignmentId Assignment id.
 * @returns {void}
 */
export function clearSourceFramingPreviewCacheForAssignment(cache, assignmentId) {
  if ( !cache || typeof cache.keys !== "function" ) return;
  const prefix = `${assignmentId}|`;
  for ( const key of cache.keys() ) {
    if ( key.startsWith(prefix) ) cache.delete(key);
  }
}

/**
 * Resolve GM Assignment review preview for one selection + Framing View.
 * Owns seed ladder, Save-gate `_full` short-circuit, overlay remap/cache, heading,
 * plate aspect, and Place enablement.
 *
 * @param {object} [options] Review inputs.
 * @param {object|null} [options.assignment] Selected assignment.
 * @param {object|null} [options.prompt] Active prompt.
 * @param {string} [options.framingView] Requested Framing View.
 * @param {string|null} [options.liveSnapshot] Live composite (Prompt-canvas).
 * @param {string|null} [options.liveOverlaySnapshot] Live ink-only overlay (Full Framing).
 * @param {object|null} [options.pendingSubmission] Cached pending submission, if any.
 * @param {Map<string, string>|null} [options.remapCache] Mutable Full Framing remap cache.
 * @param {typeof buildSourceFramingPreviewDataUrl} [options.buildRemap] Remap builder (injectable).
 * @param {(key: string) => string} [options.localize] Localization for headings.
 * @returns {Promise<AssignmentReviewResult>}
 */
export async function resolveAssignmentReview({
  assignment = null,
  prompt = null,
  framingView = FRAMING_VIEW.PROMPT_CANVAS,
  liveSnapshot = null,
  liveOverlaySnapshot = null,
  pendingSubmission = null,
  remapCache = null,
  buildRemap = buildSourceFramingPreviewDataUrl,
  localize = defaultLocalize
} = {}) {
  const hasSource = hasSourceBackground(prompt);
  const view = normalizeFramingView(framingView, { hasSource });
  const plateAspect = resolveReviewPlateAspect({
    framingView: view,
    prompt,
    hasSource
  });
  const heading = resolveReviewHeading(assignment, localize);
  const canPlace = canPlaceFramingView(assignment, view);

  if ( !assignment ) {
    return { src: null, heading, plateAspect, canPlace, framingView: view, pendingRemap: false };
  }

  if ( view === FRAMING_VIEW.FULL ) {
    const resolved = await resolveFullFramingSrc({
      assignment,
      prompt,
      liveSnapshot,
      liveOverlaySnapshot,
      pendingSubmission,
      remapCache,
      buildRemap,
      hasSource
    });
    return {
      src: resolved.src,
      heading,
      plateAspect,
      canPlace,
      framingView: view,
      pendingRemap: resolved.pendingRemap
    };
  }

  const pendingSrc = assignment.status === STATUS.SUBMITTED
    ? pendingSubmissionPromptCanvasPreviewSrc(pendingSubmission)
    : null;
  const src = resolvePromptCanvasReviewSrc({
    liveSrc: liveSnapshot,
    pendingSrc,
    savedPath: assignment.primaryImagePath ?? null,
    framedPath: prompt?.background?.framedPath ?? null
  });
  return { src, heading, plateAspect, canPlace, framingView: view, pendingRemap: false };
}

/**
 * Full Framing: saved `_full` when Save gate open; else remapped overlay; else source path.
 * Bare source is deferred when a live Prompt-canvas composite exists but overlay ink has not
 * arrived yet — callers keep the prior frame instead of flashing underlay-only.
 * @param {object} options Inputs.
 * @returns {Promise<{src: string|null, pendingRemap: boolean}>}
 */
async function resolveFullFramingSrc({
  assignment,
  prompt,
  liveSnapshot,
  liveOverlaySnapshot,
  pendingSubmission,
  remapCache,
  buildRemap,
  hasSource
}) {
  const savedFull = resolveFramingViewAssetPath(assignment, FRAMING_VIEW.FULL);
  const savedFullPath = savedFull && isSaveGateOpen(assignment) ? savedFull : null;
  if ( savedFullPath ) {
    return {
      src: resolveSourceFramingReviewSrc({
        savedFullPath,
        remappedSrc: null,
        sourcePath: null
      }),
      pendingRemap: false
    };
  }

  let overlaySrc = liveOverlaySnapshot;
  if ( assignment.status === STATUS.SUBMITTED ) {
    overlaySrc = pendingSubmissionOverlayPreviewSrc(pendingSubmission)
      ?? liveOverlaySnapshot
      ?? null;
  }

  let remappedSrc = null;
  if ( overlaySrc && prompt ) {
    remappedSrc = await resolveRemappedPreviewSrc({
      assignmentId: assignment.id,
      prompt,
      overlaySrc,
      pendingSubmission,
      remapCache,
      buildRemap
    });
  }

  if ( remappedSrc ) {
    return {
      src: resolveSourceFramingReviewSrc({
        savedFullPath: null,
        remappedSrc,
        sourcePath: null
      }),
      pendingRemap: false
    };
  }

  if ( shouldDeferFullFramingSourceFallback({ liveSnapshot, overlaySrc }) ) {
    return { src: null, pendingRemap: true };
  }

  const sourcePath = hasSource ? (prompt?.background?.path ?? null) : null;
  return {
    src: resolveSourceFramingReviewSrc({
      savedFullPath: null,
      remappedSrc: null,
      sourcePath
    }),
    pendingRemap: false
  };
}

/**
 * Remap overlay into Full Framing plate space, using cache when provided.
 * @param {object} options Inputs.
 * @returns {Promise<string|null>}
 */
async function resolveRemappedPreviewSrc({
  assignmentId,
  prompt,
  overlaySrc,
  pendingSubmission,
  remapCache,
  buildRemap
}) {
  const cacheKey = sourceFramingPreviewCacheKey(assignmentId, prompt.id, overlaySrc);
  if ( remapCache?.has?.(cacheKey) ) return remapCache.get(cacheKey);

  if ( remapCache ) clearSourceFramingPreviewCacheForAssignment(remapCache, assignmentId);

  try {
    const dataUrl = await buildRemap({
      src: overlaySrc,
      prompt,
      submission: pendingSubmission
    });
    if ( dataUrl && remapCache ) remapCache.set(cacheKey, dataUrl);
    return dataUrl ?? null;
  } catch ( err ) {
    console.warn("drawing-prompts | Full Framing preview remap failed", err);
    return null;
  }
}

/**
 * @param {object|null} assignment Assignment.
 * @param {(key: string) => string} localize Localizer.
 * @returns {string}
 */
function resolveReviewHeading(assignment, localize) {
  if ( !assignment ) return localize("DRAWING-PROMPTS.manager.sections.preview");
  if ( assignment.status === STATUS.SUBMITTED ) {
    return assignment.assets?.name || localize("DRAWING-PROMPTS.manager.submittedDrawing");
  }
  return localize("DRAWING-PROMPTS.manager.sections.preview");
}

/**
 * @param {string} key Localization key.
 * @returns {string}
 */
function defaultLocalize(key) {
  return key;
}
