# Prompt lifecycle, delivery, and recovery

Approved product rules for prompt setup, initial delivery, drawing recovery, closing, and library management. Recovery storage rationale is recorded in [ADR-0006](../adr/0006-local-first-recovery-boundary.md).

## Prompt setup and initial delivery

- Show the drawing name above the optional prompt text. A drawing name is sufficient; blank prompt text does not prevent sending or drawing.
- Use these exact plain-language delivery strings:
  - `Sending...`
  - `No response from:`
  - `Continue to start the drawing without these players.`
  - `Not enough players to start the drawing.`
- Successful Recipients wait until every initial Invitation is resolved before drawing begins. A configured timer also waits; delivery time does not consume drawing time.
- When no initial Invitation succeeds, Continue is disabled. Retry and Back to setup remain available. Back to setup preserves the GM's current prompt configuration.
- Delivery warnings are separate modal dialogs. They may overlap the manager or other delivery dialogs and must not replace the manager's current surface.

## Ongoing drawing recovery

- A live editing session keeps foreground state and bounded Undo/Redo in memory when its window closes. Closed sessions use a 128 MiB player-local LRU cache; reopening the exact world/GM/player/Prompt/Assignment/dimensions identity reattaches that session.
- Completed brush, erase, line, Fill, and Clear actions use immutable 128×128 foreground tile versions. One completed action is one Undo step. At most 25 actions, including Redo, are retained; pixel and metadata budgets may expire older actions sooner without changing visible artwork.
- Undo and Redo install saved pixels by swapping one directional version reference per changed integer-addressed tile. They do not replay drawing commands or use rolling full-canvas checkpoints. The sparse current map omits transparent tiles, and one shared transparent sentinel makes Clear undoable without transparent after-image buffers.
- IndexedDB Recovery stores stable immutable tile versions separately from generations. Consecutive saves write only missing versions; artwork and optional history reference the same records. Artwork publishes first, missing or invalid history cannot prevent artwork restoration, and a reload must not discard valid saved history merely because it is a reload.
- Do not send periodic full-quality backup copies to the GM. Quick GM previews remain reduced, transient review images and are never recovery material.
- A local Recovery copy takes precedence over every GM-held capture. Use a GM-held fallback only when the local Recovery copy is missing.
- A GM-held capture is eligible as fallback only when it belongs to the same Assignment and contains usable full-quality Submission image data. Use the newest available capture that meets both conditions. Quick GM previews and Saved previews are never eligible.
- When editable history is missing, show a dialog with the exact text `History not found.` and an OK action. Restore the eligible fallback when one is available; otherwise open a blank drawing. A restored image without history is a flat starting image, not reconstructed undo/redo state.
- Recovery identity includes world, owning GM, player, Prompt, Assignment, and exact dimensions. Storage failures never interrupt drawing, produce at most one warning per page session, and retry on a later idle save. Permanent Prompt deletion clears matching retained sessions and local generations.

## Closing and reopening a Prompt

- Closing a Prompt requests full drawings from its Recipients for retained recovery. Closing the Drawing Prompt Manager window does not close the Prompt or make it Closed.
- If full-drawing capture fails while Closing a Prompt, offer exactly these choices:
  - Retry
  - Save available previews and close
  - Close without saving previews
- A Saved preview contains artwork only. It is clearly labeled and kept distinct from Recovery copies and Full submissions; it can never be used to recover a player's editable drawing.
- Reopening a Closed Prompt restores its remaining timer value in Paused state. The timer stays Paused until the GM chooses what happens next.

## Prompt library

- The prompt library is a separate surface. Opening a Prompt from it activates the existing registered editor singleton rather than creating another editor window.
- The library supports Archive, Restore, and Delete. Delete requires confirmation.
- Delete removes the Prompt and its associated module data, but does not remove exported files or scene Tiles or Tokens created from its artwork.
