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

  const remaining = deadline - Number(now);
  const leftLabel = labels.left ?? "left";
  const overLabel = labels.over ?? "over";
  if ( remaining >= 0 ) return { text: `${formatClock(remaining)} ${leftLabel}`, overtime: false };
  return { text: `+${formatClock(Math.abs(remaining))} ${overLabel}`, overtime: true };
}
