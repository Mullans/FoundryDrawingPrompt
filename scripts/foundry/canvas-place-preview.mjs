/**
 * Native-style canvas placement preview helpers.
 * Foundry PlaceablesLayer exposes `_createPreview` for drag-under-cursor creation
 * (same mechanism tiles/tokens use when a creation tool is active).
 */

/**
 * Resolve pixel footprint for centering a placeable preview under the cursor.
 * Tokens store width/height in grid units; prefer PlaceableObject `w`/`h` or TokenDocument#getSize.
 * @param {object|null|undefined} preview Placeable preview object.
 * @param {object|null|undefined} createData Original create data (tile pixel sizes).
 * @returns {{width: number, height: number}}
 */
export function previewPixelSize(preview, createData = null) {
  const fromObjectW = Number(preview?.w);
  const fromObjectH = Number(preview?.h);
  if ( Number.isFinite(fromObjectW) && fromObjectW > 0 && Number.isFinite(fromObjectH) && fromObjectH > 0 ) {
    return { width: fromObjectW, height: fromObjectH };
  }
  const getSize = preview?.document?.getSize;
  if ( typeof getSize === "function" ) {
    const size = getSize.call(preview.document);
    const width = Number(size?.width);
    const height = Number(size?.height);
    if ( Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ) {
      return { width, height };
    }
  }
  const width = Number(preview?.document?.width ?? createData?.width ?? 0);
  const height = Number(preview?.document?.height ?? createData?.height ?? 0);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    height: Number.isFinite(height) && height > 0 ? height : 0
  };
}

/**
 * Top-left scene position so the placeable's pixel center sits on `pos`.
 * @param {{x: number, y: number}} pos Cursor/scene point.
 * @param {{width: number, height: number}} size Pixel footprint.
 * @returns {{x: number, y: number}}
 */
export function topLeftCenteredOn(pos, size) {
  const width = Number(size?.width) || 0;
  const height = Number(size?.height) || 0;
  return {
    x: Math.round(Number(pos?.x) - (width > 0 ? width / 2 : 0)),
    y: Math.round(Number(pos?.y) - (height > 0 ? height / 2 : 0))
  };
}

/**
 * Hide an ApplicationV2 window completely for canvas work (stronger than minimize).
 * Uses display:none so no translucent residual paint remains in the old window rect.
 * @param {{element?: HTMLElement|null, rendered?: boolean}|null|undefined} app
 * @returns {{didHide: boolean, previousDisplay: string, previousVisibility: string, previousPointerEvents: string, previousAriaHidden: string|null}}
 */
export function hideApplicationForCanvasYield(app) {
  const el = app?.element;
  if ( !app?.rendered || !el ) {
    return {
      didHide: false,
      previousDisplay: "",
      previousVisibility: "",
      previousPointerEvents: "",
      previousAriaHidden: null
    };
  }
  const previousDisplay = el.style.display;
  const previousVisibility = el.style.visibility;
  const previousPointerEvents = el.style.pointerEvents;
  const previousAriaHidden = el.getAttribute("aria-hidden");
  el.classList.add("dp-canvas-yield-hidden");
  el.style.display = "none";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.setAttribute("aria-hidden", "true");
  return {
    didHide: true,
    previousDisplay,
    previousVisibility,
    previousPointerEvents,
    previousAriaHidden
  };
}

/**
 * Restore visibility after {@link hideApplicationForCanvasYield}.
 * @param {{element?: HTMLElement|null}|null|undefined} app
 * @param {{didHide?: boolean, previousDisplay?: string, previousVisibility?: string, previousPointerEvents?: string, previousAriaHidden?: string|null}} state
 * @returns {void}
 */
export function restoreApplicationAfterCanvasYield(app, state = {}) {
  if ( !state.didHide || !app?.element ) return;
  const el = app.element;
  el.classList.remove("dp-canvas-yield-hidden");
  el.style.display = state.previousDisplay ?? "";
  el.style.visibility = state.previousVisibility ?? "";
  el.style.pointerEvents = state.previousPointerEvents ?? "";
  if ( state.previousAriaHidden == null ) el.removeAttribute("aria-hidden");
  else el.setAttribute("aria-hidden", state.previousAriaHidden);
}

/**
 * Place a Tile or Token via Foundry's layer preview under the cursor.
 * Left-click commits; Escape cancels and resolves null (caller restores UI).
 * @param {object} options Options.
 * @param {"tiles"|"tokens"} options.layerName Canvas layer key.
 * @param {object} options.createData Embedded document create data.
 * @returns {Promise<object|null>} Created document, or null if canceled.
 */
export async function placeWithLayerPreview({ layerName, createData } = {}) {
  const layer = canvas?.[layerName];
  if ( !layer || typeof layer._createPreview !== "function" ) {
    throw new Error("Canvas placement preview is unavailable.");
  }
  layer.activate();
  const preview = await layer._createPreview(foundry.utils.deepClone(createData), { renderSheet: false });
  if ( !preview?.document ) return null;

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if ( settled ) return;
      settled = true;
      canvas.stage?.off("pointermove", onMove);
      canvas.stage?.off("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      try {
        layer.clearPreviewContainer?.();
      } catch ( _err ) {
        // Best effort cleanup.
      }
      resolve(result);
    };

    const syncPreviewToCursor = () => {
      const pos = canvas.mousePosition;
      if ( !pos ) return;
      const size = previewPixelSize(preview, createData);
      const { x, y } = topLeftCenteredOn(pos, size);
      preview.document.updateSource?.({ x, y });
      preview.document.x = x;
      preview.document.y = y;
      if ( "x" in preview ) preview.x = x;
      if ( "y" in preview ) preview.y = y;
      preview.refresh?.();
    };

    const onMove = () => syncPreviewToCursor();
    const onKeyDown = event => {
      if ( event.key !== "Escape" && event.code !== "Escape" ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    };
    const onPointerDown = event => {
      if ( event.button !== 0 ) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      void (async () => {
        try {
          const documentName = layer.constructor.documentName;
          const data = preview.document.toObject();
          delete data._id;
          const [created] = await canvas.scene.createEmbeddedDocuments(documentName, [data]);
          finish(created ?? null);
        } catch ( err ) {
          console.warn("drawing-prompts | canvas place preview failed", err);
          finish(null);
        }
      })();
    };

    canvas.stage.on("pointermove", onMove);
    canvas.stage.on("pointerdown", onPointerDown);
    // Capture on both window and document so Foundry's dismiss handler cannot eat Escape first.
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    syncPreviewToCursor();
  });
}
