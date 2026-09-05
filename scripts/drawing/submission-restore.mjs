import { isStagedSubmission, stagedFetchUrl } from "../prompts/assignment-save.mjs";
import { decodeImageToRgba, resolveSubmissionOverlaySize } from "../prompts/dual-save.mjs";

/**
 * Restore a drawing engine from a submission payload (reopen/resume).
 * @param {import("./drawing-engine.mjs").DrawingEngine} engine Drawing engine.
 * @param {object|null|undefined} submission Submission payload.
 * @param {{canvasWidth?: number, canvasHeight?: number}|null|undefined} prompt Prompt dimensions.
 * @returns {Promise<boolean>} Whether restoration applied.
 */
export async function restoreEngineFromSubmission(engine, submission, prompt) {
  if ( !submission ) return false;
  const canUseOpLog = Boolean(submission.opLog?.ops?.length) && !submission.opLogTruncated;
  if ( canUseOpLog ) {
    engine.loadOpLog(submission.opLog);
    return true;
  }
  const overlaySrc = resolveOverlaySource(submission);
  if ( !overlaySrc ) return false;
  const { width, height } = resolveSubmissionOverlaySize(submission, prompt);
  const rgba = await decodeImageToRgba(overlaySrc, width, height);
  engine.loadOverlayRgba(rgba);
  return true;
}

/**
 * Resolve an overlay image source from a submission payload.
 * @param {object} submission Submission payload.
 * @returns {string|null}
 */
function resolveOverlaySource(submission) {
  if ( isStagedSubmission(submission) ) {
    const path = submission.staged?.overlayPath;
    return path ? stagedFetchUrl(path, submission.receiptTs) : null;
  }
  return submission.overlay?.dataUrl ?? null;
}
