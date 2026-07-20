/**
 * Return a canonical, JSON-serializable timer state.
 * @param {object} state Timer state.
 * @returns {{timerStatus: "none"|"running"|"paused", deadlineAt: number|null, remainingMs: number|null}}
 */
export function normalizeTimerState(state = {}) {
  if ( state.timerStatus === "paused" ) {
    const remainingMs = Number(state.remainingMs);
    if ( state.remainingMs != null && Number.isFinite(remainingMs) ) {
      return { timerStatus: "paused", deadlineAt: null, remainingMs };
    }
  }

  if ( ["running", "expired"].includes(state.timerStatus) ) {
    const deadlineAt = Number(state.deadlineAt);
    if ( state.deadlineAt != null && Number.isFinite(deadlineAt) ) {
      return { timerStatus: "running", deadlineAt, remainingMs: null };
    }
  }

  if ( state.timerStatus == null ) {
    const deadlineAt = Number(state.deadlineAt);
    if ( state.deadlineAt != null && Number.isFinite(deadlineAt) ) {
      return { timerStatus: "running", deadlineAt, remainingMs: null };
    }
  }

  return { timerStatus: "none", deadlineAt: null, remainingMs: null };
}

/**
 * Freeze a running timer wherever it stands, including in overtime.
 * @param {object} state Timer state.
 * @param {number} now Current epoch milliseconds.
 * @returns {{timerStatus: string, deadlineAt: number|null, remainingMs: number|null}}
 */
export function pauseTimer(state, now) {
  const timer = normalizeTimerState(state);
  const currentTime = Number(now);
  if ( timer.timerStatus !== "running" || !Number.isFinite(currentTime) ) return timer;
  const remainingMs = timer.deadlineAt - currentTime;
  if ( !Number.isFinite(remainingMs) ) return timer;
  return {
    timerStatus: "paused",
    deadlineAt: null,
    remainingMs
  };
}

/**
 * Resume a paused timer without counting paused time.
 * @param {object} state Timer state.
 * @param {number} now Current epoch milliseconds.
 * @returns {{timerStatus: string, deadlineAt: number|null, remainingMs: number|null}}
 */
export function resumeTimer(state, now) {
  const timer = normalizeTimerState(state);
  const currentTime = Number(now);
  if ( timer.timerStatus !== "paused" || !Number.isFinite(currentTime) ) return timer;
  const deadlineAt = currentTime + timer.remainingMs;
  if ( !Number.isFinite(deadlineAt) ) return timer;
  return {
    timerStatus: "running",
    deadlineAt,
    remainingMs: null
  };
}

/**
 * Shift the existing running deadline or paused remaining time.
 * @param {object} state Timer state.
 * @param {number} deltaMs Signed adjustment in milliseconds.
 * @param {number} now Current epoch milliseconds, accepted for transition-call consistency.
 * @returns {{timerStatus: string, deadlineAt: number|null, remainingMs: number|null}}
 */
export function adjustTimer(state, deltaMs, now) {
  const timer = normalizeTimerState(state);
  const delta = Number(deltaMs);
  if ( !Number.isFinite(delta) ) return timer;
  if ( timer.timerStatus === "running" ) {
    const deadlineAt = timer.deadlineAt + delta;
    return Number.isFinite(deadlineAt) ? { ...timer, deadlineAt } : timer;
  }
  if ( timer.timerStatus === "paused" ) {
    const remainingMs = timer.remainingMs + delta;
    return Number.isFinite(remainingMs) ? { ...timer, remainingMs } : timer;
  }
  return timer;
}

/**
 * Restart a timer from its original duration.
 * @param {object} state Timer state.
 * @param {number} timerSeconds Original timer duration in seconds.
 * @param {number} now Current epoch milliseconds.
 * @returns {{timerStatus: "running", deadlineAt: number, remainingMs: null}}
 */
export function resetTimer(state, timerSeconds, now) {
  const durationSeconds = Number(timerSeconds);
  const currentTime = Number(now);
  if ( !Number.isFinite(durationSeconds) || durationSeconds < 0 || !Number.isFinite(currentTime) ) {
    return { timerStatus: "none", deadlineAt: null, remainingMs: null };
  }
  const deadlineAt = currentTime + (durationSeconds * 1000);
  if ( !Number.isFinite(deadlineAt) ) return { timerStatus: "none", deadlineAt: null, remainingMs: null };
  return {
    timerStatus: "running",
    deadlineAt,
    remainingMs: null
  };
}

/**
 * Remove timing from a prompt.
 * @param {object} state Timer state.
 * @returns {{timerStatus: "none", deadlineAt: null, remainingMs: null}}
 */
export function stopTimer(state) {
  return { timerStatus: "none", deadlineAt: null, remainingMs: null };
}

/**
 * Test whether a running timer is strictly past its deadline.
 * @param {object} state Timer state.
 * @param {number} now Current epoch milliseconds.
 * @returns {boolean}
 */
export function isTimerExpired(state, now) {
  const timer = normalizeTimerState(state);
  const currentTime = Number(now);
  return Number.isFinite(currentTime) && timer.timerStatus === "running" && currentTime > timer.deadlineAt;
}

/**
 * Judge submission lateness once against the timer state at event time.
 * @param {object} state Timer state.
 * @param {number} now Submission epoch milliseconds.
 * @returns {{late: boolean, overtimeMs: number|null}}
 */
export function evaluateSubmissionTiming(state, now) {
  const timer = normalizeTimerState(state);
  const currentTime = Number(now);
  if ( !Number.isFinite(currentTime) || timer.timerStatus !== "running" || currentTime <= timer.deadlineAt ) {
    return { late: false, overtimeMs: null };
  }
  const overtimeMs = currentTime - timer.deadlineAt;
  if ( !Number.isFinite(overtimeMs) ) return { late: true, overtimeMs: null };
  return { late: true, overtimeMs };
}
