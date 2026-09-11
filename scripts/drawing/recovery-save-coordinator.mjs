/**
 * Coordinate artwork-first Recovery publication independently from optional history.
 * A completed action starts an IndexedDB artwork transaction immediately; only the
 * larger history attachment is debounced.
 */
export function createRecoverySaveCoordinator({
  store,
  historyDelayMs = 1000,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancel = handle => globalThis.clearTimeout(handle),
  warn = error => console.warn("drawing-prompts | could not persist local Recovery generation", error)
} = {}) {
  if ( typeof store?.save !== "function" ) throw new Error("A Recovery store is required");
  const pending = new Set();
  let timer = null;
  let latestIdentity = null;
  let latestSnapshot = null;

  const start = (identity, snapshot, artworkOnly) => {
    const task = Promise.resolve(store.save(identity, snapshot, { artworkOnly }))
      .catch(warn)
      .finally(() => pending.delete(task));
    pending.add(task);
    return task;
  };
  const cancelTimer = () => {
    if ( timer === null ) return;
    cancel(timer);
    timer = null;
  };
  const scheduleHistory = () => {
    cancelTimer();
    timer = schedule(() => {
      timer = null;
      if ( latestIdentity && latestSnapshot ) start(latestIdentity, latestSnapshot, false);
    }, historyDelayMs);
  };

  return {
    changed(identity, snapshot) {
      latestIdentity = identity;
      latestSnapshot = snapshot;
      start(identity, snapshot, true);
      scheduleHistory();
    },
    flush(identity = latestIdentity, snapshot = latestSnapshot) {
      cancelTimer();
      if ( !identity || !snapshot ) return null;
      latestIdentity = identity;
      latestSnapshot = snapshot;
      return start(identity, snapshot, false);
    },
    pagehide(identity = latestIdentity) {
      if ( !identity || !latestSnapshot ) return null;
      return start(identity, latestSnapshot, true);
    },
    destroy() { cancelTimer(); },
    async settled() {
      while ( pending.size ) await Promise.allSettled([...pending]);
    }
  };
}
