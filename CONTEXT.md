# Drawing Prompts

A Foundry VTT module where the GM sends drawing prompts to players, watches them draw live, and turns submitted drawings into scene content.

## Language

**Prompt**:
A GM-authored drawing request, optionally sent to one or more players, with background, framing, dimensions, and timer configuration.
_Avoid_: Drawing request (alone)

**Assignment**:
One player's individual instance of a Prompt. Three targeted players means three Assignments.

**Prompt canvas**:
The drawing surface players use, at the exact width and height the GM set for the Prompt. All player strokes and the player-side background live in this pixel space.
_Avoid_: World, drawing world, player viewport (when meaning size)

**Submission**:
The drawing a player has submitted for an Assignment, stored in Prompt canvas coordinates. A resubmission replaces it and re-arms the Save gate. GM Source Framing review maps this submission into source image space for correct placement.

**Prompt Framing**:
The GM-authored axis-aligned region of the source image (crop, pan, zoom; may extend outside the source for zoom-out pad, with exterior empty so Canvas chrome shows through after Fit) that is fed into Fit mode to build the Framed background. Default is the full source image. Locked after the Prompt is first sent to players. Players receive only this framed region after Fit—not the full source—so full source data never reaches player clients.
_Avoid_: Crop (alone), zoom level (alone), drawing world camera

**Framed background**:
The player-side background image: the Prompt Framing region of the source, placed into the Prompt canvas by Fit mode. This, with optional Canvas chrome showing through empty areas, is what the player paints on.
_Avoid_: Full background, original image (on the player), framed source (prefer this term)

**Source Framing**:
GM-only review of the full source image with the Submission remapped into source image space. Mapping uses the bounding box of the full source relative to the Prompt canvas implied by Prompt Framing + Fit mode. Hidden/disabled when there is no source image.
_Avoid_: Original framing, full image view (alone), world view

**Framing View**:
Which review the GM is using for a Submission: Prompt canvas (as the player drew it) or Source Framing. Place and Transform use the matching pre-saved raster for the view currently selected. Live preview follows the same toggle with the drawing correctly placed in both. Toggle is GM-only.
_Avoid_: View mode, display mode

**Save**:
The GM action that writes Submission images for **both** Framing Views together to world storage under a name (one action, one save detection—not separate per-view save states). Prompt-canvas framing uses the chosen basename; Source Framing uses the same basename with a `_full` suffix before the extension, at the source image’s natural resolution. Required before any Place or Transform. Switching Framing View does not undo Save; refreshing assets always rewrites both views together.
_Avoid_: Save only, save this view

**Save gate**:
The rule that Place and Transform are disabled until the current Submission has been saved. Resubmission re-arms the gate. Toggling Framing View does not re-arm the gate. Actions that invalidate a Submission (for example reopen that forces a new drawing) invalidate every Framing View of that Submission.

**Place**:
The GM action that puts a saved drawing onto the scene, in one of four modes: Tile, New Actor, Copy Actor, Existing Actor. Each mode supports visible or hidden placement.

**Place mode — Tile**:
The saved drawing becomes a scene Tile. No actor involved.

**Place mode — New Actor**:
A blank minimal actor is created; the drawing becomes its art; a token is placed.

**Place mode — Copy Actor**:
An existing actor is cloned (default clone source is configurable in module settings); the drawing becomes the clone's art; a token is placed.
_Avoid_: Default actor

**Place mode — Existing Actor**:
A token is placed for an existing actor; the drawing overrides art on that token only. The actor is untouched.

**Transform**:
A temporary, revertible art override on canvas-selected tokens using a saved drawing. No stat changes. The token's original art is kept in a flag; Revert restores it. Re-applying keeps the original, not the intermediate.

**Revert**:
The token HUD action that restores a Transformed token's original art and clears the Transform flag.

## Prompt lifecycle

**Draft**:
A Prompt that exists and may be configured but has not been opened to players.

**Open**:
A Prompt that has been sent and still has work in flight (active Assignments or attention-needing Submissions). Multiple Prompts may be Open at once.

**Closed**:
A Prompt the GM has finished with for now; retained with its data, not deleted. Intended successor to Finish-as-deletion as the normal end of work.
_Avoid_: Finish (as deletion), completed-and-gone

**Archived**:
A Prompt hidden from the default list to reduce clutter; recoverable by restoring. Stronger declutter than Closed, weaker than Delete.

**Delete**:
Permanently remove a Prompt and its associated data after explicit confirmation. Not recoverable.

## Drawing surface

**Canvas plate**:
The on-screen rectangle that represents the Prompt canvas at its true aspect ratio (GM width × height). It is the only surface that is “the drawing” for tools and export; Framed background and ink live on the plate. Distinct from any surrounding UI window or navigation padding.
_Avoid_: Viewport (alone), drawing area (when meaning the outer window)

**Display stage**:
The larger interactable region around a Canvas plate used for Player navigation (pan/zoom) and padding when the plate is letterboxed. Not Submission coordinate space.
_Avoid_: Background (when meaning stage), window (alone)

**Canvas chrome**:
The client-local plain fill (white, black, or transparency checkerboard) behind plate content. On the **player** workstation it fills the **Display stage** (including chrome outside the plate after letterboxing) so pan/zoom padding is still chrome under-layer—not Framed background and not part of the Submission. On **GM compose framing** and **static GM review** plates it exists only on the Canvas plate. Editing aid; not exported. Client setting; default checkerboard. No GM lock.
_Avoid_: Background color (when meaning chrome), canvas background (ambiguous with source image)

**Plate border**:
A thin, client-only accent edge around a Canvas plate so the Prompt canvas bounds stay visible against Chrome or panel void. Not part of exported rasters.
_Avoid_: Picture frame, window border

**Player navigation**:
Ephemeral pan and zoom of the Canvas plate within the Display stage (open and navigation-reset fit the plate fully inside the stage; letterbox as needed). Does not change Prompt Framing, Fit mode, or what was delivered as Framed background. Drawing tools map only to plate pixels; stage exterior is navigation-only for pan/zoom gestures.
_Avoid_: Prompt Framing (for temporary zoom)

## Background

**Fit mode**:
How the Prompt Framing region (not necessarily the full source image) is scaled and placed into the Prompt canvas. Locked with Prompt Framing after the Prompt is first sent to players.

**Fit mode — Center**:
Places the framed region at its natural size, centered on the Prompt canvas. The only fit mode that does not scale.

**Fit mode — Fit width**:
Scales the framed region so its width matches the Prompt canvas width, preserving aspect ratio, then centers it.

**Fit mode — Fit height**:
Scales the framed region so its height matches the Prompt canvas height, preserving aspect ratio, then centers it.

**Fit mode — Fit canvas**:
Scales the framed region by the minimum factor that fits it entirely inside the Prompt canvas, preserving aspect ratio, then centers it. Behaves like Fit width when the region is relatively wider, and like Fit height when it is relatively taller.

**Fit mode — Stretch**:
Scales the framed region to exactly fill the Prompt canvas, ignoring aspect ratio. The only Fit mode that may non-uniformly distort source pixels.

**Fit mode — Placed**:
Delivers the manually authored Prompt Framing crop window so it fills the Prompt canvas. The crop window’s aspect is locked to the Prompt canvas width×height, so fill is isotropic (source aspect is preserved). Only Stretch may use a non-canvas-aspect ROI that produces distortion. Pan or zoom in the framing editor sets Fit mode to Placed and locks/repairs crop aspect (from Stretch, re-seeds a canvas-aspect window that contains the current framing, like a Fit Canvas start). Choosing any other Fit mode resets framing to the full source. Framing reset restores full-source framing and leaves Fit mode unchanged (Placed may remain Placed with a full-source rect; re-pan re-locks aspect). Locked with Prompt Framing after Send.

## Timer

**Deadline**:
The single canonical moment a Prompt's timer runs out, owned by the GM and reflected in every player view. Extensions and reductions move the Deadline; only Reset restarts the timer.

**Late**:
A Submission made after the Deadline in effect at the moment of submission. Judged once at event time, never retroactively recomputed when the Deadline later moves.

**Overtime**:
How far past the Deadline a Late submission occurred.

**Paused**:
Timer state where the clock is frozen wherever it stands (including in overtime). Paused time never counts toward Lateness.
