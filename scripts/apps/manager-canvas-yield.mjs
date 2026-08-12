/**
 * Pure helpers for temporarily collapsing the GM Drawing Prompt Manager during
 * Place / Transform so the canvas is unobstructed, then restoring it.
 */

/**
 * Whether the manager should be minimized for a Place/Transform canvas yield.
 * Skips when already minimized (user chose that), not rendered, or not minimizable.
 * @param {{rendered?: boolean, minimized?: boolean, hasFrame?: boolean, minimizable?: boolean}|null|undefined} app
 * @returns {boolean}
 */
export function shouldMinimizeManagerForCanvasYield(app) {
  if ( !app ) return false;
  if ( !app.rendered ) return false;
  if ( app.minimized ) return false;
  if ( app.hasFrame === false ) return false;
  if ( app.minimizable === false ) return false;
  return true;
}

/**
 * Whether maximize should run after a canvas yield we started.
 * @param {{didMinimize?: boolean, rendered?: boolean, minimized?: boolean}} [state]
 * @returns {boolean}
 */
export function shouldRestoreManagerAfterCanvasYield({ didMinimize = false, rendered = false, minimized = false } = {}) {
  return Boolean(didMinimize && rendered && minimized);
}

/**
 * Wait until an ApplicationV2 instance emits `close` (or is already closed).
 * @param {{rendered?: boolean, addEventListener?: Function}|null|undefined} app
 * @returns {Promise<void>}
 */
export function waitForApplicationClose(app) {
  if ( !app?.rendered ) return Promise.resolve();
  if ( typeof app.addEventListener !== "function" ) return Promise.resolve();
  return new Promise(resolve => {
    app.addEventListener("close", () => resolve(), { once: true });
  });
}
