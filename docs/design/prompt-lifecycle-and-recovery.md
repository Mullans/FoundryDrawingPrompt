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

- The player browser keeps the ongoing Recovery copy in local storage. It retains the unfinished draft and its undo/redo history.
- Do not send periodic full-quality backup copies to the GM. Quick GM previews remain reduced, transient review images and are never recovery material.
- A local Recovery copy takes precedence over any older copy held by the GM. Use an eligible GM-held Full submission only when the local Recovery copy is missing; do not replace newer local work with it.
- When editable history is missing, show a dialog with the exact text `History not found.` and an OK action. Restore an eligible full-quality image when one is available; otherwise open a blank drawing. A restored image without history is a flat starting image, not reconstructed undo/redo state.

## Ending and closing prompts

- Ending or closing a Prompt requests full drawings from its Recipients for retained recovery. Closing the Drawing Prompt Manager window does not end or close the Prompt and does not trigger that lifecycle transition.
- If full-drawing capture fails while closing the Prompt, offer exactly these choices:
  - Retry
  - Save available previews and close
  - Close without saving previews
- A Saved preview contains artwork only. It is clearly labeled and kept distinct from Recovery copies and Full submissions; it can never be used to recover a player's editable drawing.
- Reopening a Closed Prompt restores its remaining timer value in Paused state. The timer stays Paused until the GM chooses what happens next.

## Prompt library

- The prompt library is a separate surface. Opening a Prompt from it activates the existing editor singleton rather than creating another editor window.
- The library supports Archive, Restore, and Delete. Delete requires confirmation.
- Delete removes the Prompt and its associated module data, but does not remove exported files or scene Tiles or Tokens created from its artwork.
