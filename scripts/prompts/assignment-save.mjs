/**
 * Assignment Save — dual Framing View asset write + single Save gate.
 *
 * Domain depth lives here so callers and tests share one seam (ADR-0001 / SCR-12).
 * Encode/bake helpers stay in dual-save; this module owns orchestration:
 * naming, uploads, optional Full Framing pair, gate stamp on the Assignment.
 */

import { MODULE_ID, SETTINGS } from "../constants.mjs";
import { resolvePromptAssetLocation } from "../foundry/path-provider.mjs";
import {
  browseFiles,
  defaultAssetFolder,
  ensureDir,
  normalizePath,
  uploadBlob,
  uploadDataUrl,
  uploadJson
} from "./asset-service.mjs";
import {
  bakeAndEncodePromptCanvasMerged,
  bakeAndEncodeSourceSpaceAssets,
  computeDualSaveGeometry,
  decodeImageToRgba,
  hasSourceBackground,
  resolveSubmissionOverlaySize,
  shouldWriteMergedSubmission
} from "./dual-save.mjs";
import { promptAssetFolderName, uniqueDrawingAssetFilenames } from "./naming-service.mjs";
import { isSaveGateOpen } from "./transitions.mjs";

/**
 * Deep Save interface: write dual Framing View assets for a Submission.
 * Mutates `assignment.assets` and stamps `savedSubmissionTs` (opens Save gate).
 * Always uses one detection path for source and no-source prompts.
 *
 * @param {object} options Options.
 * @param {import("./prompt-models.mjs").DrawingPrompt} options.prompt Prompt.
 * @param {import("./prompt-models.mjs").DrawingAssignment} options.assignment Assignment.
 * @param {object} options.submission Pending submission payload.
 * @param {string} options.name Resolved drawing name (non-empty).
 * @param {string} [options.folder] Optional parent folder chosen by the GM.
 * @param {AssignmentSavePorts} [options.ports] IO / bake adapters (defaults to Foundry runtime).
 * @returns {Promise<AssignmentSaveResult>}
 */
export async function saveAssignmentAssets({
  prompt,
  assignment,
  submission,
  name,
  folder = "",
  ports = createAssignmentSavePorts()
} = {}) {
  if ( !prompt || !assignment || !submission ) {
    throw new Error("saveAssignmentAssets requires prompt, assignment, and submission.");
  }
  const resolvedName = String(name ?? "").trim();
  if ( !resolvedName ) throw new Error("saveAssignmentAssets requires a non-empty name.");

  prompt.assetFolderName ??= ports.promptAssetFolderName({
    promptId: prompt.id,
    promptText: prompt.promptText,
    sentAt: prompt.sentAt,
    createdAt: prompt.createdAt
  });

  const location = ports.resolveLocation({
    selectedParent: folder,
    rememberedParent: await ports.getRememberedFolder(),
    defaultParent: ports.defaultAssetFolder(),
    assignmentFolder: assignment.assets?.folder,
    promptFolderName: prompt.assetFolderName
  });
  const dir = location.final;
  await ports.ensureDir(dir);

  const writeSourceFull = ports.hasSourceBackground(prompt);
  let hasMerged = hasMergedSubmission(submission);
  let rematerializedMergedBlob = null;
  const format = extensionFor(primarySubmissionFormat(submission, hasMerged));

  if ( shouldWriteMergedSubmission(submission, prompt) && !hasMerged ) {
    const overlayRgba = await loadSubmissionOverlayRgba(submission, prompt, ports);
    const rematerialized = await ports.bakeAndEncodePromptCanvasMerged({
      overlay: overlayRgba,
      prompt,
      format
    });
    if ( rematerialized ) {
      rematerializedMergedBlob = rematerialized.blob;
      hasMerged = true;
    }
  }

  const filenames = uniqueDrawingAssetFilenames({
    name: resolvedName,
    playerName: assignment.userName,
    extension: format,
    hasMerged,
    hasSourceFull: writeSourceFull,
    existingFiles: await ports.browseFiles(dir),
    fallback: ports.fallbackSlug()
  });

  const [primary, opLog, overlay] = await uploadSubmissionAssets(
    dir,
    filenames,
    submission,
    hasMerged,
    rematerializedMergedBlob,
    ports
  );

  assignment.assets.overlayPath = hasMerged ? overlay.path : primary.path;
  assignment.assets.mergedPath = hasMerged ? primary.path : null;
  assignment.assets.oplogPath = opLog.path;

  if ( writeSourceFull ) {
    const sourceAssets = await uploadSourceFramingAssets({
      dir,
      filenames,
      submission,
      prompt,
      format,
      ports
    });
    assignment.assets.fullPath = sourceAssets.full.path;
    assignment.assets.sourceOverlayPath = sourceAssets.sourceOverlay.path;
  } else {
    assignment.assets.fullPath = null;
    assignment.assets.sourceOverlayPath = null;
  }

  assignment.assets.folder = dir;
  assignment.assets.tileWidth = submissionTileWidth(submission, prompt);
  assignment.assets.tileHeight = submissionTileHeight(submission, prompt);
  if ( writeSourceFull ) {
    const geometry = computeDualSaveGeometry(prompt);
    assignment.assets.fullTileWidth = Math.round(geometry.fullRect.width);
    assignment.assets.fullTileHeight = Math.round(geometry.fullRect.height);
  } else {
    assignment.assets.fullTileWidth = null;
    assignment.assets.fullTileHeight = null;
  }
  assignment.pendingSubmission = null;
  // Single Save gate for both Framing Views — not per-file.
  assignment.savedSubmissionTs = assignment.submittedAt ?? Date.now();
  assignment.assets.name = resolvedName;

  await ports.rememberFolder(location.parent);

  return {
    assignment,
    location,
    filenames,
    writeSourceFull,
    hasMerged,
    gateOpen: isSaveGateOpen(assignment),
    paths: {
      primary: primary.path,
      overlay: assignment.assets.overlayPath,
      merged: assignment.assets.mergedPath,
      full: assignment.assets.fullPath,
      sourceOverlay: assignment.assets.sourceOverlayPath,
      oplog: opLog.path,
      folder: dir
    }
  };
}

/**
 * Default Foundry-backed ports for production Save.
 * @returns {AssignmentSavePorts}
 */
export function createAssignmentSavePorts() {
  return {
    promptAssetFolderName,
    resolveLocation: resolvePromptAssetLocation,
    getRememberedFolder: async () => game.settings.get(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER),
    defaultAssetFolder,
    ensureDir,
    browseFiles,
    uploadBlob,
    uploadDataUrl,
    uploadJson,
    hasSourceBackground,
    bakeAndEncodePromptCanvasMerged,
    bakeAndEncodeSourceSpaceAssets,
    decodeImageToRgba,
    fetchStagedBlob: defaultFetchStagedBlob,
    fallbackSlug: () => game.i18n.localize("DRAWING-PROMPTS.manager.saveDialog.defaultSlug"),
    rememberFolder: async parent => {
      await game.settings.set(MODULE_ID, SETTINGS.LAST_SAVE_FOLDER, parent);
    }
  };
}

/**
 * Build a fetch URL for a staged asset. Absolute URLs (e.g. Forge's Assets
 * Library) are used as-is; local paths are treated as root-relative.
 * @param {string} path Asset path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {string} Fetch URL.
 */
export function stagedFetchUrl(path, receiptTs) {
  const ts = `ts=${encodeURIComponent(String(receiptTs ?? Date.now()))}`;
  if ( /^https?:\/\//i.test(path) ) return `${path}${path.includes("?") ? "&" : "?"}${ts}`;
  return `/${encodeURI(normalizePath(path))}?${ts}`;
}

/**
 * @param {string} path Staged source path.
 * @param {number} receiptTs Receipt timestamp.
 * @returns {Promise<Blob>}
 */
async function defaultFetchStagedBlob(path, receiptTs) {
  try {
    const response = await fetch(stagedFetchUrl(path, receiptTs));
    if ( !response.ok ) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  } catch (err) {
    console.warn("drawing-prompts | staged submission file fetch failed", path, err);
    throw new Error(game.i18n.localize("DRAWING-PROMPTS.errors.stagedSubmissionUnavailable"));
  }
}

/**
 * @param {object} submission Submission.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @param {AssignmentSavePorts} ports Ports.
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}>}
 */
async function loadSubmissionOverlayRgba(submission, prompt, ports) {
  const { width, height } = resolveSubmissionOverlaySize(submission, prompt);
  if ( isStagedSubmission(submission) ) {
    const blob = await ports.fetchStagedBlob(submission.staged.overlayPath, submission.receiptTs);
    const objectUrl = URL.createObjectURL(blob);
    try {
      return await ports.decodeImageToRgba(objectUrl, width, height);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
  return ports.decodeImageToRgba(submission.overlay.dataUrl, width, height);
}

/**
 * @param {string} dir Target directory.
 * @param {object} filenames Resolved filenames.
 * @param {object} submission Submission.
 * @param {boolean} hasMerged Whether merged primary exists.
 * @param {Blob|null} rematerializedMergedBlob GM-baked merged when submission lacked merged.
 * @param {AssignmentSavePorts} ports Ports.
 * @returns {Promise<[{path: string}, {path: string}, {path: string}|undefined]>}
 */
async function uploadSubmissionAssets(dir, filenames, submission, hasMerged, rematerializedMergedBlob, ports) {
  if ( rematerializedMergedBlob && hasMerged ) {
    const uploads = [
      ports.uploadBlob(dir, filenames.primary, rematerializedMergedBlob),
      ports.uploadJson(dir, filenames.opLog, submission.opLog ?? {})
    ];
    if ( isStagedSubmission(submission) ) {
      uploads.push(uploadStagedPath(dir, filenames.overlay, submission.staged.overlayPath, submission.receiptTs, ports));
    } else {
      uploads.push(ports.uploadDataUrl(dir, filenames.overlay, submission.overlay?.dataUrl));
    }
    return Promise.all(uploads);
  }

  if ( isStagedSubmission(submission) ) {
    const primaryPath = hasMerged ? submission.staged.mergedPath : submission.staged.overlayPath;
    const uploads = [
      uploadStagedPath(dir, filenames.primary, primaryPath, submission.receiptTs, ports),
      ports.uploadJson(dir, filenames.opLog, submission.opLog ?? {})
    ];
    if ( hasMerged ) {
      uploads.push(uploadStagedPath(dir, filenames.overlay, submission.staged.overlayPath, submission.receiptTs, ports));
    }
    return Promise.all(uploads);
  }

  const primaryDataUrl = hasMerged ? submission.merged?.dataUrl : submission.overlay?.dataUrl;
  const uploads = [
    ports.uploadDataUrl(dir, filenames.primary, primaryDataUrl),
    ports.uploadJson(dir, filenames.opLog, submission.opLog ?? {})
  ];
  if ( hasMerged ) uploads.push(ports.uploadDataUrl(dir, filenames.overlay, submission.overlay?.dataUrl));
  return Promise.all(uploads);
}

/**
 * @param {object} options Options.
 * @param {string} options.dir Target directory.
 * @param {{sourceFull: string, sourceOverlay: string}} options.filenames Filenames.
 * @param {object} options.submission Submission.
 * @param {import("./prompt-models.mjs").DrawingPrompt} options.prompt Prompt.
 * @param {string} options.format Format.
 * @param {AssignmentSavePorts} options.ports Ports.
 * @returns {Promise<{full: {path: string}, sourceOverlay: {path: string}}>}
 */
async function uploadSourceFramingAssets({ dir, filenames, submission, prompt, format, ports }) {
  const overlay = await loadSubmissionOverlayRgba(submission, prompt, ports);
  const baked = await ports.bakeAndEncodeSourceSpaceAssets({ overlay, prompt, format });
  const [full, sourceOverlay] = await Promise.all([
    ports.uploadBlob(dir, filenames.sourceFull, baked.full.blob),
    ports.uploadBlob(dir, filenames.sourceOverlay, baked.sourceOverlay.blob)
  ]);
  return { full, sourceOverlay };
}

/**
 * @param {string} dir Dir.
 * @param {string} filename Filename.
 * @param {string} path Staged path.
 * @param {number} receiptTs Receipt.
 * @param {AssignmentSavePorts} ports Ports.
 * @returns {Promise<{path: string}>}
 */
async function uploadStagedPath(dir, filename, path, receiptTs, ports) {
  const blob = await ports.fetchStagedBlob(path, receiptTs);
  return ports.uploadBlob(dir, filename, blob);
}

/**
 * @param {object} submission Submission.
 * @returns {boolean}
 */
export function isStagedSubmission(submission) {
  return submission?.mode === "staged";
}

/**
 * @param {object} submission Submission.
 * @returns {boolean}
 */
export function hasMergedSubmission(submission) {
  return isStagedSubmission(submission)
    ? Boolean(submission.staged?.mergedPath)
    : Boolean(submission.merged?.dataUrl);
}

/**
 * @param {object} submission Submission.
 * @param {boolean} hasMerged Merged flag.
 * @returns {string}
 */
export function primarySubmissionFormat(submission, hasMerged) {
  if ( isStagedSubmission(submission) ) {
    return (hasMerged ? submission.formats?.merged : submission.formats?.overlay) ?? "webp";
  }
  return (hasMerged ? submission.merged?.format : submission.overlay?.format) ?? "webp";
}

/**
 * @param {object|null} submission Submission.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {number}
 */
export function submissionTileWidth(submission, prompt) {
  return Number(submission?.originalWidth ?? submission?.width ?? prompt.canvasWidth);
}

/**
 * @param {object|null} submission Submission.
 * @param {import("./prompt-models.mjs").DrawingPrompt} prompt Prompt.
 * @returns {number}
 */
export function submissionTileHeight(submission, prompt) {
  return Number(submission?.originalHeight ?? submission?.height ?? prompt.canvasHeight);
}

/**
 * @param {string} format Format id.
 * @returns {string}
 */
function extensionFor(format) {
  const raw = String(format ?? "webp").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if ( raw === "jpeg" ) return "jpg";
  return raw || "webp";
}

/**
 * @typedef {object} AssignmentSavePorts
 * @property {typeof promptAssetFolderName} promptAssetFolderName
 * @property {typeof resolvePromptAssetLocation} resolveLocation
 * @property {() => Promise<string>} getRememberedFolder
 * @property {() => string} defaultAssetFolder
 * @property {(dir: string) => Promise<void>} ensureDir
 * @property {(dir: string) => Promise<string[]>} browseFiles
 * @property {(dir: string, name: string, blob: Blob) => Promise<{path: string}>} uploadBlob
 * @property {(dir: string, name: string, dataUrl: string) => Promise<{path: string}>} uploadDataUrl
 * @property {(dir: string, name: string, data: object) => Promise<{path: string}>} uploadJson
 * @property {(prompt: object) => boolean} hasSourceBackground
 * @property {typeof bakeAndEncodePromptCanvasMerged} bakeAndEncodePromptCanvasMerged
 * @property {typeof bakeAndEncodeSourceSpaceAssets} bakeAndEncodeSourceSpaceAssets
 * @property {typeof decodeImageToRgba} decodeImageToRgba
 * @property {(path: string, receiptTs: number) => Promise<Blob>} fetchStagedBlob
 * @property {() => string} fallbackSlug
 * @property {(parent: string) => Promise<void>} rememberFolder
 */

/**
 * @typedef {object} AssignmentSaveResult
 * @property {import("./prompt-models.mjs").DrawingAssignment} assignment
 * @property {{parent: string, final: string}} location
 * @property {object} filenames
 * @property {boolean} writeSourceFull
 * @property {boolean} hasMerged
 * @property {boolean} gateOpen
 * @property {{
 *   primary: string,
 *   overlay: string|null,
 *   merged: string|null,
 *   full: string|null,
 *   sourceOverlay: string|null,
 *   oplog: string,
 *   folder: string
 * }} paths
 */
