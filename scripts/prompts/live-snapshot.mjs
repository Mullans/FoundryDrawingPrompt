import { isValidSnapshotPayload } from "./wire-validation.mjs";

/**
 * Select current preview bytes for the requested Framing View, within one wire budget.
 * Returns null when neither representation is valid; callers retain the previous frame.
 * @param {{composite: string, overlay?: string, overlayRequested?: boolean}} options Images and view requirement.
 * @returns {{composite?: string, overlay?: string}|null} Valid wire payload.
 */
export function selectLiveSnapshotPayload({ composite, overlay, overlayRequested = false }) {
  if ( overlayRequested ) {
    const pair = { composite, overlay };
    if ( isValidSnapshotPayload(pair) ) return pair;
    if ( isValidSnapshotPayload({ overlay }) ) return { overlay };
  }
  return isValidSnapshotPayload({ composite }) ? { composite } : null;
}
