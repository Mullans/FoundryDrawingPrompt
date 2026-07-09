/**
 * Create a leading-and-trailing throttle.
 * @param {Function} callback Callback to invoke.
 * @param {object} options Options.
 * @param {number} options.intervalMs Throttle interval in milliseconds.
 * @param {() => number} [options.now] Clock function.
 * @param {Function} [options.setTimeout] Timer function.
 * @param {Function} [options.clearTimeout] Timer clear function.
 * @returns {Function & {cancel: Function, flush: Function}} Throttled function.
 */
export function createLeadingTrailingThrottle(callback, {
  intervalMs,
  now = () => Date.now(),
  setTimeout = globalThis.setTimeout.bind(globalThis),
  clearTimeout = globalThis.clearTimeout.bind(globalThis)
} = {}) {
  const interval = Math.max(0, Number(intervalMs) || 0);
  let lastRun = null;
  let timer = null;
  let trailingArgs = null;

  const run = args => {
    lastRun = now();
    trailingArgs = null;
    callback(...args);
  };

  const schedule = () => {
    if ( timer || !trailingArgs ) return;
    const elapsed = lastRun === null ? interval : now() - lastRun;
    const delay = Math.max(0, interval - elapsed);
    timer = setTimeout(() => {
      timer = null;
      if ( trailingArgs ) run(trailingArgs);
    }, delay);
  };

  const throttled = (...args) => {
    if ( lastRun === null || now() - lastRun >= interval ) {
      if ( timer ) {
        clearTimeout(timer);
        timer = null;
      }
      run(args);
      return;
    }
    trailingArgs = args;
    schedule();
  };

  throttled.cancel = () => {
    if ( timer ) clearTimeout(timer);
    timer = null;
    trailingArgs = null;
  };

  throttled.flush = () => {
    if ( !trailingArgs ) return;
    if ( timer ) clearTimeout(timer);
    timer = null;
    run(trailingArgs);
  };

  return throttled;
}
