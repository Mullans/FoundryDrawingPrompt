import { BG_SOURCE, FIT_MODE } from "../constants.mjs";
import {
  bakeFramedBackgroundCanvas,
  defaultFramingForBackground,
  encodeFramedBackground,
  playerBackgroundPayload
} from "../drawing/framed-background.mjs";
import { loadBackgroundImage } from "../foundry/background-source-service.mjs";
import { ensureDir, stagingDir, uploadBlob } from "./asset-service.mjs";

/**
 * Resolve the effective Prompt Framing for a prompt.
 * @param {DrawingPrompt} prompt Prompt.
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function resolvePromptFraming(prompt) {
  const background = prompt.background ?? {};
  if ( background.framing && typeof background.framing === "object" ) return normalizeFramingRect(background.framing);
  return defaultFramingForBackground(background);
}

/**
 * Serialize the player-safe background for wire payloads.
 * @param {DrawingPrompt} prompt Prompt.
 * @returns {{sourceType: string, path: string|null, fitMode: string, preFramed: true, naturalWidth: number|null, naturalHeight: number|null}}
 */
export function serializeBackgroundForPlayer(prompt) {
  return playerBackgroundPayload(prompt);
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
 * Bake and upload the Framed background for player delivery, mutating the prompt in place.
 * @param {DrawingPrompt} prompt Prompt to prepare.
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
 * @param {{x?: number, y?: number, width?: number, height?: number}|null} framing
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
function normalizeFramingRect(framing) {
  if ( !framing || typeof framing !== "object" ) return null;
  return {
    x: Number(framing.x) || 0,
    y: Number(framing.y) || 0,
    width: Number(framing.width) || 0,
    height: Number(framing.height) || 0
  };
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
