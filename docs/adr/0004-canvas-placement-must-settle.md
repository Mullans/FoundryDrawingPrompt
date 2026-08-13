# Interactive canvas placement must always settle

`placeWithLayerPreview` owns the whole lifetime of an interactive Place: its promise **must always settle**, and it resolves `null` for every outcome that is not a deliberate left-click commit. Left-click commits; Escape, `canvasTearDown`, and `activateCanvasLayer` for any layer other than the one being placed on all resolve `null`. Those two hooks are registered *after* `layer.activate()` (which fires `activateCanvasLayer` synchronously, so an earlier registration would abort the placement at birth) and the handler additionally ignores its own layer; the existing `finish` latch unregisters both alongside the PIXI and keydown listeners. `syncPreviewToCursor` and the pointerdown handler bail to `finish(null)` on a destroyed preview.

Without an abort path, `PlaceablesLayer#_deactivate` destroys the preview while our listeners survive, so the next click anywhere on canvas silently creates a Tile or Token the GM never asked for—against whatever scene is current, not the one the caller captured—and the manager window, restored in a `finally` gated on this promise, stays hidden forever.

Alternative rejected: bail inside `withCanvasYield`'s `finally`—it would race the placement promise and collide with the manager's preview arbitration. Settling is the placement's own responsibility; the manager's `finally` is only the restore path.

Alternative rejected: extracting a pure "settle latch" helper to make the abort testable—this is Foundry lifecycle wiring, and the extracted piece would just re-implement a promise while leaving the hook registration (the part that actually breaks) untested. Tests stub `canvas`/`Hooks`/`foundry` and drive the real function instead.

Alternative rejected: rely on the destroyed-preview guards alone, without hooks—the promise would then settle only if the GM happened to move the mouse or click again, leaving the manager hidden indefinitely in the common case.

Source: SCR-50 (Urgent). `activateCanvasLayer` fire order verified in `client/canvas/layers/base/interaction-layer.mjs:94`; `Hooks.off` unregistering a `once` registration by function identity verified in `client/helpers/hooks.mjs:81`.
