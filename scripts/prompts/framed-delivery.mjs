/**
 * Compatibility shim — Prompt Framing → Framed background delivery lives in
 * {@link ./framing-delivery.mjs}. Keep this path stable for existing imports.
 */
export {
  assertBackgroundUnlocked,
  computeDualSaveGeometry,
  defaultFramingForBackground,
  normalizeStoredFraming,
  prepareFramedBackgroundForSend,
  resolvePromptFraming,
  serializeBackgroundForPlayer,
  serializeFramedBackgroundForPreview
} from "./framing-delivery.mjs";
