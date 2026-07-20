# Drawing Prompts

A Foundry VTT module where the GM sends drawing prompts to players, watches them draw live, and turns submitted drawings into scene content.

## Language

**Prompt**:
A GM-authored drawing request sent to one or more players, with optional background, dimensions, and timer.

**Assignment**:
One player's individual instance of a Prompt. Three targeted players means three Assignments.

**Submission**:
The drawing a player has submitted for an Assignment. A resubmission replaces it and resets the save gate.

**Save**:
The GM action that writes a Submission's image to world storage under a name. Required before any Place or Transform.
_Avoid_: Save only

**Save gate**:
The rule that Place and Transform are disabled until the current Submission has been saved. Resubmission re-arms the gate.

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

## Background

**Fit mode**:
How a Prompt's background image is scaled and placed on the drawing canvas.

**Fit mode — Center**:
Places the background at its natural size, centered. The only fit mode that does not scale.

**Fit mode — Fit width**:
Scales the background (up or down) so its width matches the canvas width, preserving aspect ratio, then centers it.

**Fit mode — Fit height**:
Scales the background (up or down) so its height matches the canvas height, preserving aspect ratio, then centers it.

**Fit mode — Fit canvas**:
Scales the background (up or down) by the minimum factor that fits the entire image inside the canvas, preserving aspect ratio, then centers it. Behaves like Fit width when the image is relatively wider, and like Fit height when it is relatively taller.

**Fit mode — Stretch**:
Scales the background to exactly fill the canvas, ignoring aspect ratio.

## Timer

**Deadline**:
The single canonical moment a Prompt's timer runs out, owned by the GM and reflected in every player view. Extensions and reductions move the Deadline; only Reset restarts the timer.

**Late**:
A Submission made after the Deadline in effect at the moment of submission. Judged once at event time, never retroactively recomputed when the Deadline later moves.

**Overtime**:
How far past the Deadline a Late submission occurred.

**Paused**:
Timer state where the clock is frozen wherever it stands (including in overtime). Paused time never counts toward Lateness.
