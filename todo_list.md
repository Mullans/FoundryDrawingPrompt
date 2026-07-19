# Future Items

Decisions resolved 2026-07-19 (grilling session). Each item below is aligned and ready for detailed planning/implementation. Vocabulary per `CONTEXT.md`.

## 1. Save gate + GM action row

- Rename "Save only" → "Save". Right-facing arrow between Save and the placement actions.
- GM action row becomes: `[Save] → [Place…] [Apply Transform]`.
- **Real gate**: Place… and Apply Transform are disabled until the current Submission has been saved. A resubmission (after GM reopen) re-arms the gate — disabled again until the new Submission is saved.
- Old saved files are never deleted; a re-save writes a new file (collision counter).

## 2. Unified Place dialog (replaces Place Tile / Place Hidden buttons)

"Place…" opens one dialog with four radio mode cards (selected card highlighted, its inputs enabled, others greyed; one commit row):

1. **Tile** — saved drawing becomes a scene Tile. No actor. (Existing behavior, relocated here.)
2. **New Actor** — create blank minimal actor, drawing becomes its art, place token.
3. **Copy Actor** — clone an existing actor (dropdown of world actors, prefilled from module-settings default clone source), drawing becomes clone's art, place token.
4. **Existing Actor** — place token for chosen actor (dropdown); drawing overrides art on that token only (`texture.src`), actor untouched.

- Commit buttons in dialog: **[Place] [Place Hidden]** — hidden works uniformly for tiles and tokens.
- Name field prefilled with drawing name; hidden/irrelevant inputs per mode.
- Settings submenu (small DialogV2): pick default clone-source actor (stores UUID, searchable dropdown of world actors). Blank = New Actor fallback behavior unaffected.
- World actors only in v1; compendium/drag-drop later if needed.
- Note: supersedes module_plan.md's "Use Tiles only / do not create tokens or Actors" scope guard — update spec when implementing.

## 3. Apply Transform

- Button in GM action row (behind save gate). Applies saved drawing as temporary art override on **canvas-selected tokens**.
- None selected → `ui.notifications.warn`, no dialog. Multi-select → confirmation "Apply to N tokens?".
- Original `texture.src` stored in module flag on token. Re-applying over a transformed token keeps the *original* art in the flag, never intermediate.
- **Revert** via token HUD button (visible only on transformed tokens): restores original, clears flag.
- No stat changes ever.

## 4. Manager layout width

- Content fills window width. Form column (prompt text, name, dimensions, timer, player list) keeps stable readable width; preview column flex-grows to absorb extra width (bigger previews).
- Window `min-width` floor so layout can't crush. No max-width cap.

## 5. Player canvas aspect ratio

- Canvas bitmap resolution fixed at prompt dimensions, always — never re-rasterized on resize.
- Display: CSS contain-fit inside drawing area, aspect ratio locked, letterbox gaps neutral background.
- Check current code during implementation: determine whether today's bug is display-only stretch or actual bitmap resizing.

## 6. Save dialog vs Folder Browser stacking

- Save-drawing dialog must be a normal non-modal window: remove modal/always-on-top behavior so the FilePicker/Folder Browser can be raised and interacted with while the save dialog is open. Diagnose exact flag at implementation.

## 7. Forge-compatible paths + submission validation (merged with old item 11)

Root cause of the "submitted drawing payload was invalid and ignored" Forge bug: staged-submission path allowlist does strict prefix match (`wire-validation.mjs` `isAllowedStagedPath`) against local-style roots (`worlds/...`), but Forge `FilePicker.upload` returns full assets-library URLs (`https://assets.forge-vtt.com/...`) — prefix never matches.

- Build one **Forge-aware path provider** used by *both* upload code and validation. Detection: `typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge`.
- Forge roots: assets-root `drawing-prompts/{world.id}/{promptId}/` (world.id segment prevents cross-world collision in the shared assets library). Local/self-hosted: unchanged `worlds/{world.id}/drawing-prompts/{promptId}/`.
- Allowlist stays strict — compares against provider roots; no loosening.
- Improve rejection logging: say which check failed (path vs shape).
- Pre-implementation probe: console snippet run on Forge (player login) to capture exact `FilePicker.upload` return path format. Full Forge verification batched at the end (requires published release — slow).

## 8. Human-useful asset names

- Prompt folder: `{YYYY-MM-DD}-{slug of prompt text, ~40 chars}-{4-char id}/`.
- Drawing file: `{slug of drawing name}-{slug of player name}.webp`; overlay export shares basename + `-overlay`.
- Collisions (e.g. re-save after resubmission): `-2`, `-3` counters; old files kept.
- Slug rules: lowercase, spaces→dashes, strip path-hostile characters.

## 9–10. WYSIWYG preview + default dimensions

- Prompt-manager preview pane aspect ratio always equals current width/height field values, updating live on input. Background rendered with the prompt's fit mode exactly as the player canvas will composite it. Preview scales to fit pane, letterboxed, never stretched.
- Module settings `defaultCanvasWidth` / `defaultCanvasHeight`, world-scoped, initial 512×512, validated against dimension cap. Manager opens pre-filled from settings.

## 11. GM timer control (old item 12)

Canonical timer state owned by GM, stored on prompt, broadcast to assigned players on every change; player views render received state (late-joiner/reopen requests current state).

- State: `{ status: running | paused | expired | none, deadlineAt, remainingMs }`.
- Controls in GM manager (live after send): **Pause / Resume**, two **extend** buttons, two **reduce** buttons, **Reset** (back to original duration, running), **Stop** (remove timer, untimed).
- All four extend/reduce button values configurable in module settings (reduce defaults mirror extend values).
- Extension/reduction semantics: `deadlineAt ± delta` — behaves as if the original timer were that much longer/shorter. Elapsed/overtime displays fall out naturally. Only **Reset** restarts the timer.
- **Lateness judged at event time, never retroactively**: `late = submitTs > deadlineAt` at the moment of submission; `overtimeMs = submitTs - deadlineAt`; recorded once, immutable. Later deadline moves never relabel past submissions. Forgiveness path = reopen → resubmit → judged against new deadline.
- **Pause** freezes the clock wherever it stands (including negative remaining / overtime). Resume: `deadlineAt = now + frozenRemaining`. Paused time never counts toward lateness.
- Expiry never locks submission ("expired but still submittable" stays).
