import { BG_SOURCE, FIT_MODE, INTERNAL } from "../constants.mjs";
import { normalizeStoredFraming } from "../drawing/prompt-framing.mjs";

/** Normalize and validate a complete editable Prompt configuration. */
export function validateDraft(draft, { forSend = false } = {}) {
  const promptName = String(draft?.promptName ?? "").trim();
  if ( !promptName ) throw new Error("DRAWING-PROMPTS.manager.validation.promptName");
  const canvasWidth = Number(draft.canvasWidth ?? 512);
  const canvasHeight = Number(draft.canvasHeight ?? 512);
  if ( ![canvasWidth, canvasHeight].every(value => Number.isFinite(value) && value >= 1 && value <= INTERNAL.MAX_CANVAS_DIM) ) {
    throw new Error("DRAWING-PROMPTS.manager.validation.dimensions");
  }
  const timerSeconds = Number(draft.timerSeconds ?? 0);
  if ( !Number.isInteger(timerSeconds) || timerSeconds < 0 ) throw new Error("DRAWING-PROMPTS.manager.validation.timerSeconds");
  const rawBackground = draft.background ?? { sourceType: BG_SOURCE.BLANK };
  if ( !rawBackground || typeof rawBackground !== "object" || Array.isArray(rawBackground)
    || !Object.values(BG_SOURCE).includes(rawBackground.sourceType ?? BG_SOURCE.BLANK)
    || !Object.values(FIT_MODE).includes(rawBackground.fitMode ?? FIT_MODE.FIT_CANVAS) ) {
    throw new Error("DRAWING-PROMPTS.background.errors.noSource");
  }
  const background = { ...rawBackground, sourceType: rawBackground.sourceType ?? BG_SOURCE.BLANK,
    fitMode: rawBackground.fitMode ?? FIT_MODE.FIT_CANVAS };
  if ( background.sourceType !== BG_SOURCE.BLANK && (typeof background.path !== "string" || !background.path.trim()) ) {
    throw new Error("DRAWING-PROMPTS.background.errors.noSource");
  }
  if ( background.framing != null ) {
    if ( typeof background.framing !== "object" || Array.isArray(background.framing)
      || !["x", "y", "width", "height"].every(key => background.framing[key] != null
        && background.framing[key] !== "" && Number.isFinite(Number(background.framing[key]))) ) {
      throw new Error("DRAWING-PROMPTS.background.errors.noSource");
    }
    const framing = normalizeStoredFraming(background.framing);
    if ( !framing || ![framing.x, framing.y, framing.width, framing.height].every(Number.isFinite)
      || framing.width <= 0 || framing.height <= 0 ) throw new Error("DRAWING-PROMPTS.background.errors.noSource");
    background.framing = framing;
  }
  const rawUsers = draft.selectedUserIds ?? [];
  if ( !Array.isArray(rawUsers) || rawUsers.some(id => typeof id !== "string" || !id.trim()) ) {
    throw new Error("DRAWING-PROMPTS.errors.onlineRecipientsRequired");
  }
  const selectedUserIds = [...new Set(rawUsers)];
  if ( forSend && (!selectedUserIds.length || selectedUserIds.some(id => !game.users.get(id) || game.users.get(id)?.isGM)) ) {
    throw new Error("DRAWING-PROMPTS.errors.onlineRecipientsRequired");
  }
  return { promptName, promptText: String(draft.promptText ?? ""), canvasWidth, canvasHeight,
    background, timerSeconds: timerSeconds || null, selectedUserIds };
}
