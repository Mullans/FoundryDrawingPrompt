import { BG_SOURCE, FIT_MODE, INTERNAL, MODULE_ID, SETTINGS } from "../constants.mjs";

/**
 * Return the first controlled Token texture path.
 * @returns {string|null}
 */
export function getControlledTokenImage() {
  return canvas?.tokens?.controlled?.[0]?.document?.texture?.src || null;
}

/**
 * Return the first controlled Tile texture path.
 * @returns {string|null}
 */
export function getControlledTileImage() {
  return canvas?.tiles?.controlled?.[0]?.document?.texture?.src || null;
}

/**
 * Return the active Scene background image path.
 * @returns {string|null}
 */
export function getSceneBackgroundImage() {
  return canvas?.scene?.background?.src || null;
}

/**
 * Open Foundry's FilePicker for an image path.
 * @returns {Promise<string|null>}
 */
export async function browseForImage() {
  const Picker = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
  return new Promise(resolve => {
    let settled = false;
    const picker = new Picker({
      type: "image",
      callback: path => {
        settled = true;
        resolve(path || null);
      }
    });
    const originalClose = picker.close.bind(picker);
    picker.close = async options => {
      if ( !settled ) resolve(null);
      return originalClose(options);
    };
    picker.render({ force: true });
  });
}

/**
 * Load and taint-check a background image.
 * @param {string} path Image path.
 * @returns {Promise<{path: string, img: HTMLImageElement, naturalWidth: number, naturalHeight: number}>}
 */
export async function loadBackgroundImage(path) {
  const img = new Image();
  img.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", () => {
      const err = new Error("Background image load failed.");
      err.code = "load-failed";
      reject(err);
    }, { once: true });
    img.src = path;
  });

  const canvasEl = document.createElement("canvas");
  canvasEl.width = 1;
  canvasEl.height = 1;
  const context = canvasEl.getContext("2d");
  try {
    context.drawImage(img, 0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
  } catch (_err) {
    const err = new Error("Background image tainted the canvas.");
    err.code = "tainted";
    throw err;
  }

  return {
    path,
    img,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight
  };
}

/**
 * Resolve logical canvas dimensions from requested and background dimensions.
 * @param {number|string|null} requestedW Requested width.
 * @param {number|string|null} requestedH Requested height.
 * @param {number|null} bgNaturalW Background natural width.
 * @param {number|null} bgNaturalH Background natural height.
 * @returns {{width: number, height: number}}
 */
export function resolveCanvasSize(requestedW, requestedH, bgNaturalW, bgNaturalH) {
  const requestedWidth = Number(requestedW);
  const requestedHeight = Number(requestedH);
  const bgWidth = Number(bgNaturalW);
  const bgHeight = Number(bgNaturalH);

  if ( requestedWidth > 0 && requestedHeight > 0 ) {
    return {
      width: clamp(Math.round(requestedWidth), 1, INTERNAL.MAX_CANVAS_DIM),
      height: clamp(Math.round(requestedHeight), 1, INTERNAL.MAX_CANVAS_DIM)
    };
  }

  if ( bgWidth > 0 && bgHeight > 0 ) return clampAspect(bgWidth, bgHeight);

  return {
    width: settingDefault(SETTINGS.DEFAULT_CANVAS_WIDTH, 1024),
    height: settingDefault(SETTINGS.DEFAULT_CANVAS_HEIGHT, 768)
  };
}

/**
 * Build a blank background descriptor.
 * @returns {{sourceType: string, path: null, fitMode: string, naturalWidth: null, naturalHeight: null}}
 */
export function blankBackground() {
  return {
    sourceType: BG_SOURCE.BLANK,
    path: null,
    fitMode: settingDefault(SETTINGS.DEFAULT_FIT_MODE, FIT_MODE.FIT_WIDTH),
    naturalWidth: null,
    naturalHeight: null,
    framing: null,
    framedPath: null
  };
}

/**
 * Clamp dimensions to the internal cap while preserving aspect ratio.
 * @param {number} width Width.
 * @param {number} height Height.
 * @returns {{width: number, height: number}}
 */
function clampAspect(width, height) {
  const scale = Math.min(1, INTERNAL.MAX_CANVAS_DIM / width, INTERNAL.MAX_CANVAS_DIM / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/**
 * Read a module setting with a fallback.
 * @param {string} key Setting key.
 * @param {*} fallback Fallback value.
 * @returns {*}
 */
function settingDefault(key, fallback) {
  const value = globalThis.game?.settings?.get?.(MODULE_ID, key);
  if ( value === null || value === undefined || value === "" ) return fallback;
  return value;
}

/**
 * Clamp a number.
 * @param {number} value Value.
 * @param {number} min Minimum.
 * @param {number} max Maximum.
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
