import { BG_SOURCE, FIT_MODE } from "../constants.mjs";
import {
  bakeFramedBackgroundCanvas,
  defaultFramingForBackground,
  encodeFramedBackground
} from "../drawing/framed-background.mjs";
import {
  computeFramingGeometry,
  normalizeStoredFraming
} from "../drawing/prompt-framing.mjs";
import { loadBackgroundImage } from "../foundry/background-source-service.mjs";
import { ensureDir, stagingDir, uploadBlob } from "./asset-service.mjs";

export { defaultFramingForBackground, normalizeStoredFraming };

/**
 * Resolve the effective Prompt Framing for a prompt.
 * @param {{background?: object}} prompt Prompt.
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function resolvePromptFraming(prompt) {
  const background = prompt.background ?? {};
  if ( background.framing && typeof background.framing === "object" ) {
    return normalizeStoredFraming(background.framing);
  }
  return defaultFramingForBackground(background);
}

/**
 * Player-safe background for wire payloads.
 * Full source paths and source natural dimensions never leave the GM client.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} prompt Prompt.
 * @returns {{sourceType: string, path: string|null, fitMode: string, preFramed: true, naturalWidth: number|null, naturalHeight: number|null}}
 */
export function serializeBackgroundForPlayer(prompt) {
  const framedPath = prompt.background?.framedPath ?? null;
  if ( !framedPath ) {
    return {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      fitMode: FIT_MODE.STRETCH,
      preFramed: true,
      naturalWidth: null,
      naturalHeight: null
    };
  }
  return {
    sourceType: BG_SOURCE.FILE,
    path: framedPath,
    fitMode: FIT_MODE.STRETCH,
    preFramed: true,
    naturalWidth: prompt.canvasWidth,
    naturalHeight: prompt.canvasHeight
  };
}

/**
 * Reject locked Prompt Framing or Fit mode mutations after first send.
 * @param {object} changes Proposed background changes.
 * @param {object} current Current background state.
 * @param {{sentAt?: number|null}} promptState Prompt lock state.
 * @returns {void}
 */
export function assertBackgroundUnlocked(changes, current, promptState = {}) {
  if ( !promptState.sentAt ) return;
  if ( "fitMode" in changes && changes.fitMode !== current.fitMode ) {
    throw new Error("Background fit mode is locked after the prompt is sent.");
  }
  if ( "framing" in changes && !framingRectsEqual(changes.framing, current.framing) ) {
    throw new Error("Prompt Framing is locked after the prompt is sent.");
  }
}

/**
 * Framing geometry for send / dual Save / review remapping into Full Framing plate space.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} prompt Prompt.
 * @returns {ReturnType<typeof computeFramingGeometry>}
 */
export function computeDualSaveGeometry(prompt) {
  const background = prompt?.background ?? {};
  return computeFramingGeometry({
    sourceWidth: background.naturalWidth,
    sourceHeight: background.naturalHeight,
    framing: resolvePromptFraming(prompt),
    fitMode: background.fitMode,
    canvasWidth: prompt.canvasWidth,
    canvasHeight: prompt.canvasHeight
  });
}

/**
 * Build a player-style Framed background for GM Show Preview (ephemeral, no world upload).
 * Matches post-Send product identity: framed + Fit baked into canvas-sized raster with STRETCH.
 * @param {{background?: object, canvasWidth?: number, canvasHeight?: number}} draft Draft or prompt-like object.
 * @returns {Promise<{sourceType: string, path: string|null, fitMode: string, preFramed: true, naturalWidth: number|null, naturalHeight: number|null}>}
 */
export async function serializeFramedBackgroundForPreview(draft) {
  const canvasWidth = Math.max(1, Math.round(Number(draft?.canvasWidth) || 1));
  const canvasHeight = Math.max(1, Math.round(Number(draft?.canvasHeight) || 1));
  const background = draft?.background ?? {};
  const sourcePath = background.path ?? null;
  const sourceType = background.sourceType ?? BG_SOURCE.BLANK;

  if ( !sourcePath || sourceType === BG_SOURCE.BLANK ) {
    return {
      sourceType: BG_SOURCE.BLANK,
      path: null,
      fitMode: FIT_MODE.STRETCH,
      preFramed: true,
      naturalWidth: null,
      naturalHeight: null
    };
  }

  const loaded = await loadBackgroundImage(sourcePath);
  const framing = (background.framing && typeof background.framing === "object")
    ? normalizeStoredFraming(background.framing)
    : defaultFramingForBackground({
      ...background,
      naturalWidth: loaded.naturalWidth,
      naturalHeight: loaded.naturalHeight
    });

  const canvas = bakeFramedBackgroundCanvas({
    img: loaded.img,
    naturalWidth: loaded.naturalWidth,
    naturalHeight: loaded.naturalHeight,
    framing,
    fitMode: background.fitMode,
    canvasWidth,
    canvasHeight
  });
  // Data URL is GM-only and ephemeral (preview app); not the player Send path.
  // Same encoder as Send: WebP with the PNG fallback, so previews stay cheap.
  const { dataUrl: path } = await encodeFramedBackground(canvas);
  return {
    sourceType: BG_SOURCE.FILE,
    path,
    fitMode: FIT_MODE.STRETCH,
    preFramed: true,
    naturalWidth: canvasWidth,
    naturalHeight: canvasHeight
  };
}

/**
 * Bake and upload the Framed background for player delivery, mutating the prompt in place.
 * @param {{id: string, background?: object, canvasWidth?: number, canvasHeight?: number}} prompt Prompt to prepare.
 * @returns {Promise<void>}
 */
export async function prepareFramedBackgroundForSend(prompt) {
  const background = prompt.background ?? {};
  const sourcePath = background.path ?? null;
  const sourceType = background.sourceType ?? BG_SOURCE.BLANK;

  if ( !sourcePath || sourceType === BG_SOURCE.BLANK ) {
    background.framing = null;
    background.framedPath = null;
    return;
  }

  background.framing = resolvePromptFraming(prompt);
  const loaded = await loadBackgroundImage(sourcePath);
  background.naturalWidth = loaded.naturalWidth;
  background.naturalHeight = loaded.naturalHeight;
  background.framing = background.framing ?? defaultFramingForBackground(background);

  const canvas = bakeFramedBackgroundCanvas({
    img: loaded.img,
    naturalWidth: loaded.naturalWidth,
    naturalHeight: loaded.naturalHeight,
    framing: background.framing,
    fitMode: background.fitMode,
    canvasWidth: prompt.canvasWidth,
    canvasHeight: prompt.canvasHeight
  });
  const encoded = await encodeFramedBackground(canvas);
  const dir = stagingDir();
  await ensureDir(dir);
  const filename = `${prompt.id}-framed.${encoded.format === "png" ? "png" : "webp"}`;
  const uploaded = await uploadBlob(dir, filename, encoded.blob);
  background.framedPath = uploaded.path;
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number}|null} a
 * @param {{x?: number, y?: number, width?: number, height?: number}|null} b
 * @returns {boolean}
 */
function framingRectsEqual(a, b) {
  if ( a == null && b == null ) return true;
  if ( a == null || b == null ) return false;
  return Number(a.x) === Number(b.x)
    && Number(a.y) === Number(b.y)
    && Number(a.width) === Number(b.width)
    && Number(a.height) === Number(b.height);
}
