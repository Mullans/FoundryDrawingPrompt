import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_SOURCE, FIT_MODE, STATUS } from "../scripts/constants.mjs";
import {
  canPlaceFramingView,
  resolveFramingViewAssetPath
} from "../scripts/prompts/dual-save.mjs";
import { DrawingAssignment } from "../scripts/prompts/prompt-models.mjs";
import {
  saveAssignmentAssets,
  stagedFetchUrl
} from "../scripts/prompts/assignment-save.mjs";
import { FRAMING_VIEW } from "../scripts/constants.mjs";
import { isSaveGateOpen } from "../scripts/prompts/transitions.mjs";

/**
 * @param {object} [overrides]
 * @returns {{prompt: object, assignment: import("../scripts/prompts/prompt-models.mjs").DrawingAssignment, submission: object}}
 */
function sampleSaveContext(overrides = {}) {
  const assignment = new DrawingAssignment({
    id: "a1",
    promptId: "p1",
    userId: "u1",
    userName: "Ada",
    status: STATUS.SUBMITTED,
    submittedAt: 1_700_000_000_000,
    assets: {}
  });
  const prompt = {
    id: "p1",
    promptText: "Draw a griffin",
    promptName: "Griffin",
    canvasWidth: 64,
    canvasHeight: 64,
    assetFolderName: "2026-01-01-draw-a-griffin-p1",
    background: {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      naturalWidth: null,
      naturalHeight: null,
      fitMode: FIT_MODE.CENTER
    },
    ...overrides.prompt
  };
  const submission = {
    mode: "dataUrl",
    overlay: { dataUrl: "data:image/webp;base64,AAA", format: "webp" },
    merged: null,
    opLog: { version: 1, ops: [] },
    width: 64,
    height: 64,
    ...overrides.submission
  };
  return { prompt, assignment, submission };
}

/**
 * @param {{writeSource?: boolean, rematerialize?: boolean}} [options]
 * @returns {import("../scripts/prompts/assignment-save.mjs").AssignmentSavePorts}
 */
function mockPorts({ writeSource = false, rematerialize = false } = {}) {
  /** @type {Array<{role: string, name: string}>} */
  const uploads = [];
  return {
    uploads,
    promptAssetFolderName: args => `folder-${args.promptId}`,
    resolveLocation: () => ({ parent: "worlds/test/drawings", final: "worlds/test/drawings/prompt" }),
    getRememberedFolder: async () => "worlds/test/drawings",
    defaultAssetFolder: () => "worlds/test/drawings",
    ensureDir: async () => {},
    browseFiles: async () => [],
    uploadBlob: async (dir, name) => {
      uploads.push({ role: "blob", name, dir });
      return { path: `${dir}/${name}` };
    },
    uploadDataUrl: async (dir, name) => {
      uploads.push({ role: "dataUrl", name, dir });
      return { path: `${dir}/${name}` };
    },
    uploadJson: async (dir, name) => {
      uploads.push({ role: "json", name, dir });
      return { path: `${dir}/${name}` };
    },
    hasSourceBackground: prompt => {
      if ( typeof writeSource === "function" ) return writeSource(prompt);
      return writeSource || Boolean(prompt?.background?.path && prompt?.background?.naturalWidth);
    },
    bakeAndEncodePromptCanvasMerged: async () => {
      if ( !rematerialize ) return null;
      return { blob: new Blob(["merged"]), format: "webp", width: 64, height: 64 };
    },
    bakeAndEncodeSourceSpaceAssets: async () => ({
      full: { blob: new Blob(["full"]), format: "webp", width: 128, height: 128 },
      sourceOverlay: { blob: new Blob(["src-ov"]), format: "webp", width: 128, height: 128 }
    }),
    decodeImageToRgba: async (_src, width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4)
    }),
    fetchStagedBlob: async () => new Blob(["staged"]),
    fallbackSlug: () => "drawing",
    rememberFolder: async () => {}
  };
}

test("saveAssignmentAssets opens one Save gate and writes Prompt-canvas files without source", async () => {
  const { prompt, assignment, submission } = sampleSaveContext();
  const ports = mockPorts({ writeSource: false });

  const result = await saveAssignmentAssets({
    prompt,
    assignment,
    submission,
    name: "Griffin",
    ports
  });

  assert.equal(result.writeSourceFull, false);
  assert.equal(result.hasMerged, false);
  assert.equal(result.gateOpen, true);
  assert.equal(assignment.savedSubmissionTs, 1_700_000_000_000);
  assert.equal(isSaveGateOpen(assignment), true);
  assert.equal(result.paths.full, null);
  assert.equal(result.paths.sourceOverlay, null);
  assert.ok(result.paths.primary.endsWith(".webp"));
  assert.equal(result.paths.oplog, null);
  assert.ok(!ports.uploads.some(upload => upload.role === "json"));
  assert.ok(!ports.uploads.some(u => u.name.includes("_full")));
  assert.ok(!ports.uploads.some(u => u.name.includes("_source")));
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.PROMPT_CANVAS), true);
  assert.equal(resolveFramingViewAssetPath(assignment, FRAMING_VIEW.PROMPT_CANVAS), result.paths.primary);
});

test("saveAssignmentAssets writes _full and _source via the same path when source exists", async () => {
  const { prompt, assignment, submission } = sampleSaveContext({
    prompt: {
      background: {
        sourceType: BG_SOURCE.FILE,
        path: "maps/dungeon.webp",
        naturalWidth: 128,
        naturalHeight: 128,
        fitMode: FIT_MODE.STRETCH,
        framing: { x: 0, y: 0, width: 128, height: 128 }
      }
    }
  });
  const ports = mockPorts({ writeSource: true });

  const result = await saveAssignmentAssets({
    prompt,
    assignment,
    submission,
    name: "Griffin",
    ports
  });

  assert.equal(result.writeSourceFull, true);
  assert.equal(result.gateOpen, true);
  assert.ok(String(result.paths.full).includes("_full.webp"));
  assert.ok(String(result.paths.sourceOverlay).includes("_source.webp"));
  assert.ok(ports.uploads.some(u => u.name.includes("_full")));
  assert.ok(ports.uploads.some(u => u.name.includes("_source")));
  // One gate for Place on either Framing View paths
  assert.equal(isSaveGateOpen(assignment), true);
  assert.equal(canPlaceFramingView(assignment, FRAMING_VIEW.FULL), true);
  assert.equal(resolveFramingViewAssetPath(assignment, FRAMING_VIEW.FULL), result.paths.full);
});

test("saveAssignmentAssets rematerializes merged and uploads dual files on one path", async () => {
  const { prompt, assignment, submission } = sampleSaveContext({
    prompt: {
      background: {
        sourceType: BG_SOURCE.FILE,
        path: "maps/dungeon.webp",
        framedPath: "framed/prompt.webp",
        naturalWidth: 128,
        naturalHeight: 128,
        fitMode: FIT_MODE.FIT_CANVAS
      }
    },
    submission: {
      overlay: { dataUrl: "data:image/webp;base64,AAA", format: "webp" },
      merged: null
    }
  });
  const ports = mockPorts({ writeSource: true, rematerialize: true });

  const result = await saveAssignmentAssets({
    prompt,
    assignment,
    submission,
    name: "Griffin Ada",
    ports
  });

  assert.equal(result.hasMerged, true);
  assert.ok(result.paths.merged);
  assert.ok(result.paths.overlay);
  assert.notEqual(result.paths.merged, result.paths.overlay);
  assert.ok(result.paths.full);
  assert.equal(result.gateOpen, true);
});

test("re-Save refreshes both Framing View paths and keeps a single gate stamp", async () => {
  const { prompt, assignment, submission } = sampleSaveContext({
    prompt: {
      background: {
        sourceType: BG_SOURCE.FILE,
        path: "maps/dungeon.webp",
        naturalWidth: 128,
        naturalHeight: 128,
        fitMode: FIT_MODE.CENTER
      }
    }
  });
  const ports = mockPorts({ writeSource: true });

  const first = await saveAssignmentAssets({
    prompt,
    assignment,
    submission,
    name: "Griffin",
    ports
  });
  const firstTs = assignment.savedSubmissionTs;

  // Second save with collision empty list still refreshes paths + gate.
  const second = await saveAssignmentAssets({
    prompt,
    assignment,
    submission: {
      ...submission,
      overlay: { dataUrl: "data:image/webp;base64,BBB", format: "webp" }
    },
    name: "Griffin",
    ports
  });

  assert.equal(assignment.savedSubmissionTs, firstTs);
  assert.equal(second.gateOpen, true);
  assert.ok(second.paths.full);
  assert.ok(second.paths.primary);
  assert.equal(first.writeSourceFull, second.writeSourceFull);
});

test("stagedFetchUrl still roots local paths and preserves Forge absolute URLs", () => {
  assert.equal(
    stagedFetchUrl("worlds/test-world/drawing-prompts/staging/a1-overlay.webp", 999),
    "/worlds/test-world/drawing-prompts/staging/a1-overlay.webp?ts=999"
  );
  const forgeUrl = "https://assets.forge-vtt.com/abc123/drawing-prompts/world/staging/a1-overlay.webp";
  assert.equal(stagedFetchUrl(forgeUrl, 999), `${forgeUrl}?ts=999`);
  const forged = "https://assets.forge-vtt.com/abc123/staging/a1-overlay.webp?v=2";
  assert.equal(stagedFetchUrl(forged, 999), `${forged}&ts=999`);
});
