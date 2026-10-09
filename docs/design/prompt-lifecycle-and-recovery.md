# Prompt lifecycle, delivery, and recovery

Approved product rules for prompt setup, initial delivery, drawing recovery, closing, and library management. Recovery storage rationale is recorded in [ADR-0006](../adr/0006-local-first-recovery-boundary.md).

## Prompt setup and initial delivery

- Show the Prompt name above the optional prompt text. A Prompt name is sufficient; blank prompt text does not prevent sending or drawing. Use `promptName` consistently in models, persistence, hooks, wire payloads, and UI; the pre-release `drawingName` field is removed rather than retained as an alias.
- Use these exact plain-language delivery strings:
  - `Sending...`
  - `No response from:`
  - `Continue to start the drawing without these players.`
  - `Not enough players to start the drawing.`
- Successful Recipients wait until every initial Invitation is resolved before drawing begins. A configured timer also waits; delivery time does not consume drawing time.
- When no initial Invitation succeeds, Continue is disabled. Retry and Back to setup remain available. Back to setup preserves the GM's current prompt configuration.
- Back to setup after zero successful Recipients restores the persisted Prompt to Draft, removes the failed initial Assignments, and retains its configuration and selected-player list. A Prompt that was unsaved before Send remains as the Draft created by Send's auto-save.
- Delivery warnings are separate modal dialogs. They may overlap the manager or other delivery dialogs and must not replace the manager's current surface.

## Ongoing drawing recovery

- A live editing session keeps foreground state and bounded Undo/Redo in memory when its window closes. Closed sessions use a 128 MiB player-local LRU cache; reopening the exact world/GM/player/Prompt/Assignment/dimensions identity reattaches that session.
- Completed brush, erase, line, Fill, and Clear actions use immutable 128×128 foreground tile versions. One completed action is one Undo step. At most 25 actions, including Redo, are retained; pixel and metadata budgets may expire older actions sooner without changing visible artwork.
- Undo and Redo install saved pixels by swapping one directional version reference per changed integer-addressed tile. They do not replay drawing commands or use rolling full-canvas checkpoints. The sparse current map omits transparent tiles, and one shared transparent sentinel makes Clear undoable without transparent after-image buffers.
- IndexedDB Recovery stores stable immutable tile versions separately from generations. Consecutive saves write only missing versions; artwork and optional history reference the same records. Artwork publishes first, newer edits preempt stale optional-history work, failed staging releases its pins, missing or invalid history cannot prevent artwork restoration, and a reload must not discard valid saved history merely because it is a reload.
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
- Reopening the Prompt by itself does not reopen player windows. Reopening any individual Assignment from a Closed Prompt first reopens the Prompt, then reopens that Assignment; the GM does not need a separate Prompt-level action first.
- Opening a Prompt to players, initially sending it, and reopening an individual Assignment are distinct operations. `openPromptToPlayers(id)` changes only Prompt lifecycle; Send creates and delivers initial Assignments; `reopenAssignment(id)` opens a Closed owning Prompt when necessary and then reopens only that player's Assignment.
- Manager lifecycle controls follow Prompt state: Draft exposes Save and Send; Open exposes Close Prompt; Closed exposes Open to Players; Archived is read-only and must be Restored from the library before lifecycle changes.

## Prompt library

- The Prompt Library is the GM's primary module entry point. The Foundry scene-control button opens it rather than opening a fresh Prompt Manager.
- The library is a separate browser surface and stays open when it activates the registered Prompt Manager singleton. Opening a Prompt for inspection does not change its lifecycle or remove it from the library.
- Only one Prompt Manager exists at a time. Opening another Prompt switches that manager after resolving unsaved Draft changes; multiple live Prompts never create parallel manager subscriptions.
- The row currently displayed in the Prompt Manager uses the existing selected-row accent without changing its lifecycle indicator or renaming its `Open` action.
- The public opening interface is `openPromptLibrary()`, `openNewPrompt()`, `openPrompt(id)`, and `openPromptCopy(id)`. The pre-release `openPromptManager()` interface is removed rather than retained as a deprecated alias.
- A saved Draft retains its configuration and selected players but has no Assignments. A new or copied prompt is not added to the library until Save or Send; Send auto-saves it.
- `openNewPrompt()` opens an empty unsaved Draft; it creates no library record. `createPrompt(draft)` persists a new Draft, and `updatePrompt(id, draft)` saves an existing Draft. `sendPrompt(draftOrId)` persists when needed, transitions Draft to Open, creates Assignments, and performs initial delivery. Only Draft Prompts may be updated through the Draft-saving operations.
- `createdAt` is assigned when Save or Send first persists a Prompt. Unsaved editing time is not counted, and Open Copy never inherits the source Prompt's creation timestamp.
- After successful persistence, `promptCreated` reports a newly persisted Draft and `promptUpdated` reports a saved existing Draft. `promptSent` fires only after initial delivery establishes at least one Recipient; sending an unsaved Prompt therefore emits `promptCreated` first and emits `promptSent` only upon successful delivery. Failed stages and zero-recipient attempts do not emit their corresponding hooks.
- Persisted player selections do not change delivery policy. Offline selected players remain visible, selected, and muted when a Prompt is inspected; attempting to Send them follows the existing offline-recipient warning flow exactly as a newly composed Prompt does.
- The library supports Open Copy, Archive, Restore, and Delete. Draft and Closed Prompts may be Archived; Open Prompts must be Closed first. Open Copy excludes selected players, Assignments, and player drawings. Delete requires confirmation, and an Open Prompt must be Closed from the Prompt Manager before deletion.
- Deleting the Draft, Closed, or Archived Prompt currently displayed in the manager closes that manager and returns focus to the library. An Open Prompt is never deleted; the attempt shows `Cannot delete an open prompt. Please close from the Prompt Manager and try again.`
- Archiving or Restoring the Prompt currently displayed in the manager leaves the manager open, refreshes it immediately into the new read-only state, and retains the library's selected-row highlight.
- Open Copy keeps the exact Prompt name and opens an unsaved editable copy; the GM may rename it before Save or Send. Duplicate Prompt names are valid.
- Each library row keeps only the Prompt name, lifecycle status, contextual actions, and an information icon visible. The status badge sits immediately after the Prompt name in the left-aligned identity cluster. The bare information icon occupies a stable narrow utility column immediately before the action group rather than appearing as a bordered action button. Activating it opens an accessible anchored popover containing the full Prompt name, Prompt text, localized created date/time, localized closed date/time or `Not closed`, and status.
- Row actions use a deliberate hierarchy: `Open` is the visually primary action, `Open Copy` is secondary, and infrequent or destructive actions move into a `More actions` menu. Draft and Closed menus contain Archive and Delete; Open contains Delete, which still produces the close-first error; Archived contains Restore and Delete. The action remains named `Open` even though the lifecycle badge may also read Open.
- Status uses a text badge: Draft is blue, Open is green, Closed is neutral gray, and Archived is muted gray with the entire row additionally dimmed. Color reinforces rather than replaces the status text.
- An empty Prompt text value is shown as `No prompt text.` in the information popover.
- A compact, window-local, case-insensitive search filters Prompt name and Prompt text. It combines with the Archived visibility toggle and never reveals hidden Archived Prompts by itself.
- The library provides a compact, visually grouped Sort field selector for Status, Name, Date created, and Date closed plus its direction selector. The active selection is window-local; a client-scoped module setting supplies the default when a new library window opens.
- Default sort field and default sort direction are separate client-scoped module settings. Direction labels follow the selected field: newest/oldest for dates, A–Z/Z–A for Prompt name, and explicit forward/reverse lifecycle order for Status.
- Factory defaults are Date created and Newest first. Runtime selections do not overwrite the configured defaults.
- Status sorting orders Open, Draft, Closed, then Archived; reverse is the exact inverse. Archived Prompts are hidden by default, appear inline when the eye-icon visibility control is enabled, and use the same muted treatment as offline players.
- Within Status groups, forward order uses the relevant timestamp newest-first (`sentAt` for Open, `createdAt` for Draft, and `closedAt` for Closed/Archived), then Prompt name and ID. Reverse inverts the complete comparator, including within-group order.
- Archived visibility uses a strong eye/eye-slash icon, a concise visible state label, a tooltip, and an accessible Show/Hide label. It exposes its state through `aria-pressed`; hidden remains the default for each new library window.
- Date-closed sorting treats an Open Prompt as temporally newer than every recorded close date and always places never-used Drafts last. Newest-first therefore orders Open, dated rows newest-to-oldest, then Draft; oldest-first orders dated rows oldest-to-newest, then Open, then Draft.
- When Archived Prompts are visible, Name and date sorts include them normally; only Status sorting positions them by lifecycle order.
- Module configuration labels sort direction generically as Ascending or Descending without an explanatory hint. The library's live direction control uses field-aware wording such as Newest first, A–Z, or Open first.
- The Prompt Manager's current row uses a restrained tinted background and left accent; avoid stacking a high-contrast full outline with the same selection cue. Archived rows mute their identity treatment, while available actions—especially Restore—retain usable contrast.
- Empty results distinguish `No prompts have been saved.`, `No prompts match your search.`, and `Matching archived prompts are hidden.` The hidden-match state includes a direct `Show archived` action.
- The pre-release `drawingName` persistence shape receives no compatibility migration. Development Prompt records using it are disposable and must be cleared before final verification.
- Delete removes the Prompt and its associated module data, but does not remove exported files or scene Tiles or Tokens created from its artwork.
