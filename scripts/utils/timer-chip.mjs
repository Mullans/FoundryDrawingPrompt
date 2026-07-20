/**
 * Format milliseconds as mm:ss.
 * @param {number} ms Milliseconds.
 * @returns {string}
 */
export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Format the GM review timer countdown chip.
 * @param {number|null|undefined} deadlineAt Epoch milliseconds for the prompt deadline.
 * @param {number} now Current epoch milliseconds.
 * @param {{left?: string, over?: string}} [labels] Localized labels.
 * @returns {{text: string, overtime: boolean}}
 */
export function formatTimerChip(deadlineAt, now, labels = {}) {
  const deadline = Number(deadlineAt);
  if ( !Number.isFinite(deadline) || deadline <= 0 ) return { text: "", overtime: false };
  return formatRemaining(deadline - Number(now), labels);
}

/**
 * Format a signed remaining-time value with left/over labels.
 * @param {number} remaining Milliseconds remaining (negative = overtime).
 * @param {{left?: string, over?: string}} [labels] Localized labels.
 * @returns {{text: string, overtime: boolean}}
 */
function formatRemaining(remaining, labels = {}) {
  const leftLabel = labels.left ?? "left";
  const overLabel = labels.over ?? "over";
  if ( remaining >= 0 ) return { text: `${formatClock(remaining)} ${leftLabel}`, overtime: false };
  return { text: `+${formatClock(Math.abs(remaining))} ${overLabel}`, overtime: true };
}

/**
 * Format a canonical prompt timer state for display.
 * @param {{timerStatus?: string, deadlineAt?: number|null, remainingMs?: number|null}} state Timer state.
 * @param {number} now Current epoch milliseconds.
 * @param {{left?: string, over?: string}} [labels] Localized labels.
 * @returns {{text: string, overtime: boolean}}
 */
export function formatTimerState(state, now, labels = {}) {
  if ( state?.timerStatus === "running" ) return formatTimerChip(state.deadlineAt, now, labels);
  if ( state?.timerStatus !== "paused" || !Number.isFinite(Number(state.remainingMs)) ) {
    return { text: "", overtime: false };
  }
  return formatRemaining(Number(state.remainingMs), labels);
}

/**
 * Format a timer adjustment button label.
 * @param {number} seconds Adjustment magnitude in seconds.
 * @param {number} direction Positive to extend, negative to reduce.
 * @returns {string}
 */
export function formatTimerAdjustment(seconds, direction) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  const duration = [minutes ? `${minutes}m` : "", remainder || !minutes ? `${remainder}s` : ""].filter(Boolean).join(" ");
  return `${direction < 0 ? "−" : "+"}${duration}`;
}
