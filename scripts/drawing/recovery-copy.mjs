import { restoreEngineFromSubmission } from "./submission-restore.mjs";

const PREFIX = "drawing-prompts.recovery.v1";
const OP_TYPES = new Set(["stroke", "erase", "fill", "clear"]);

/**
 * Create the player-local Recovery copy module. Callers use only its four-method
 * interface; the storage adapter is selected here at the seam.
 * @param {object} [options] Dependencies.
 * @param {{getItem: Function, setItem: Function, removeItem: Function}} [options.storage] Storage adapter.
 * @param {Function} [options.now] Clock.
 * @param {Function} [options.warn] One-session warning callback.
 * @param {Function} [options.restoreSubmission] Full-submission restore implementation.
 * @returns {{saveRecoveryCopy: Function, resolveRecovery: Function, restoreResolvedRecovery: Function, clearRecoveryCopy: Function}}
 */
export function createRecoveryCopyModule({
  storage = browserStorageAdapter(),
  now = () => Date.now(),
  warn = defaultStorageWarning,
  restoreSubmission = restoreEngineFromSubmission
} = {}) {
  let storageWarned = false;
  const restoredBases = new Map();

  function storageFailure(error) {
    if ( storageWarned ) return;
    storageWarned = true;
    warn(error);
  }

  function saveRecoveryCopy(identity, opLog) {
    const normalizedIdentity = requireIdentity(identity);
    if ( !isOperationLog(opLog) ) throw new Error("Invalid Recovery copy operation log");
    const record = {
      schema: 1,
      ...normalizedIdentity,
      savedAt: now(),
      opLog: cloneJson(opLog),
      baseSubmission: cloneJson(restoredBases.get(storageKey(normalizedIdentity)) ?? null)
    };
    try {
      storage.setItem(storageKey(normalizedIdentity), JSON.stringify(record));
      return true;
    } catch (error) {
      storageFailure(error);
      return false;
    }
  }

  function resolveRecovery(identity, gmFallback) {
    const normalizedIdentity = requireIdentity(identity);
    const key = storageKey(normalizedIdentity);
    let serialized = null;
    try {
      serialized = storage.getItem(key);
    } catch (error) {
      storageFailure(error);
    }
    if ( serialized ) {
      try {
        const record = JSON.parse(serialized);
        if ( !isRecoveryRecord(record, normalizedIdentity) ) throw new Error("Invalid Recovery copy");
        const resolution = {
          kind: "local",
          opLog: cloneJson(record.opLog),
          historyMissing: false
        };
        if ( record.baseSubmission ) resolution.baseSubmission = cloneJson(record.baseSubmission);
        return resolution;
      } catch (_error) {
        try { storage.removeItem(key); } catch (error) { storageFailure(error); }
      }
    }

    const fallback = newestEligibleFallback(gmFallback, normalizedIdentity);
    if ( fallback ) {
      restoredBases.set(key, cloneJson(fallback));
      return { kind: "full-submission", submission: fallback, historyMissing: true };
    }
    return { kind: "blank", historyMissing: Boolean(identity?.existingAssignment) };
  }

  async function restoreResolvedRecovery(engine, resolution, prompt) {
    if ( resolution?.kind === "local" ) {
      if ( resolution.baseSubmission ) {
        const restored = await restoreSubmission(engine, resolution.baseSubmission, prompt);
        if ( !restored ) return false;
        engine.loadOpLogOverCurrentDrawing(cloneJson(resolution.opLog));
        return true;
      }
      engine.loadOpLog(cloneJson(resolution.opLog));
      return true;
    }
    if ( resolution?.kind === "full-submission" ) {
      return Boolean(await restoreSubmission(engine, resolution.submission, prompt));
    }
    return false;
  }

  function clearRecoveryCopy(identity) {
    const normalizedIdentity = requireIdentity(identity);
    try {
      storage.removeItem(storageKey(normalizedIdentity));
      return true;
    } catch (error) {
      storageFailure(error);
      return false;
    }
  }

  return { saveRecoveryCopy, resolveRecovery, restoreResolvedRecovery, clearRecoveryCopy };
}

/** Create the test adapter over a Map without changing the production interface. */
export function createMapStorageAdapter(map = new Map()) {
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
}

function browserStorageAdapter() {
  return {
    getItem: key => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
    removeItem: key => globalThis.localStorage?.removeItem(key)
  };
}

function defaultStorageWarning(error) {
  console.warn("drawing-prompts | could not persist local Recovery copy", error);
  globalThis.ui?.notifications?.warn?.(
    globalThis.game?.i18n?.localize?.("DRAWING-PROMPTS.player.warnings.recoveryStorage")
      ?? "Drawing recovery could not be saved in this browser."
  );
}

function storageKey(identity) {
  return `${PREFIX}.${identity.worldId}.${identity.userId}.${identity.assignmentId}`;
}

function requireIdentity(identity) {
  const normalized = {
    worldId: requiredText(identity?.worldId),
    userId: requiredText(identity?.userId),
    assignmentId: requiredText(identity?.assignmentId),
    promptId: requiredText(identity?.promptId),
    width: positiveInteger(identity?.width),
    height: positiveInteger(identity?.height)
  };
  if ( Object.values(normalized).some(value => value === null) ) throw new Error("Invalid Recovery copy identity");
  return normalized;
}

function requiredText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && !/[.\s]/.test(text) ? text : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isRecoveryRecord(record, identity) {
  return record?.schema === 1
    && Number.isFinite(record.savedAt)
    && ["worldId", "userId", "assignmentId", "promptId", "width", "height"]
      .every(field => record[field] === identity[field])
    && isOperationLog(record.opLog)
    && (record.baseSubmission == null || isEligibleFallback(record.baseSubmission, identity));
}

function isOperationLog(log) {
  return Array.isArray(log?.ops)
    && Number.isInteger(log.pointer)
    && log.pointer >= 0
    && log.pointer <= log.ops.length
    && log.ops.every(isOperation);
}

function isOperation(op) {
  if ( !isPlainObject(op) || !OP_TYPES.has(op.type) || typeof op.id !== "string" || !op.id || !Number.isFinite(op.ts) ) return false;
  if ( op.type === "clear" ) return true;
  if ( op.type === "stroke" || op.type === "erase" ) {
    if ( !Number.isFinite(op.size) || op.size <= 0 || !Array.isArray(op.points) || !op.points.length || !op.points.every(isPoint) ) return false;
    if ( op.type === "stroke" && (typeof op.color !== "string" || !Number.isFinite(op.opacity)) ) return false;
    return true;
  }
  return isPoint(op.seed) && typeof op.color === "string" && Number.isFinite(op.tolerance);
}

function isPoint(point) {
  return isPlainObject(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function newestEligibleFallback(value, identity) {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  return candidates
    .filter(candidate => isEligibleFallback(candidate, identity))
    .sort((a, b) => Number(b.receiptTs ?? b.submittedAt ?? 0) - Number(a.receiptTs ?? a.submittedAt ?? 0))[0] ?? null;
}

function isEligibleFallback(candidate, identity) {
  return candidate?.recoveryKind === "full-submission"
    && candidate.assignmentId === identity.assignmentId
    && Number(candidate.width) === identity.width
    && Number(candidate.height) === identity.height
    && hasUsableOverlay(candidate);
}

function hasUsableOverlay(candidate) {
  return Boolean(candidate.overlay?.dataUrl || candidate.staged?.overlayPath);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const defaultModule = createRecoveryCopyModule();
export const saveRecoveryCopy = defaultModule.saveRecoveryCopy;
export const resolveRecovery = defaultModule.resolveRecovery;
export const restoreResolvedRecovery = defaultModule.restoreResolvedRecovery;
export const clearRecoveryCopy = defaultModule.clearRecoveryCopy;
