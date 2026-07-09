# Drawing Prompts

Drawing Prompts is a Foundry VTT module for private, per-player drawing requests during play. A GM sends a prompt to selected players, watches live snapshot previews, receives submitted images, saves the result to world data, and can place the merged drawing as a visible or hidden Scene Tile.

## Requirements

- Foundry VTT v13 or v14.
- The `socketlib` module installed and enabled in the world.

## Installation

From this repository, create a junction into your Foundry data `Data/modules` folder:

```powershell
.\tools\link-module.ps1 -FoundryDataPath "C:\Code\FoundryVTT\FoundryVTT-WindowsPortable-14.364"
```

Then start Foundry, open your world, enable `socketlib`, and enable `Drawing Prompts`.

## GM Usage

1. Open the Drawing Prompts control from the scene controls.
2. In setup mode, select one or more non-GM users.
3. Enter prompt text, an optional drawing name, canvas size, timer, and optional locked background.
4. Send the prompt. Each selected player receives an independent drawing assignment, and the manager switches to review mode.
5. In review mode, use the summary bar to confirm the prompt, drawing name, dimensions, timer, and background. Timed prompts show both the configured duration and a live GM-side countdown or overtime readout.
6. Click player rows to switch the preview. Live preview updates arrive as throttled bitmap snapshots.
7. Use row actions to resend, cancel, reopen, or force-show a player's drawing window.
8. After submission, choose Save, Place, or Place Hidden. Placement actions save first and require a non-empty name. Finish the prompt to return to setup mode with the previous draft retained.

## Player Usage

Players receive a non-blocking drawing window. They can brush, erase, fill, sample colors, use the eyedropper, undo, redo, clear, submit, reject, close, and reopen active prompts from the Drawing Prompts control. Closing the window does not cancel the assignment.

## Settings

| Setting | Purpose |
| --- | --- |
| Default canvas width | Initial logical drawing width. |
| Default canvas height | Initial logical drawing height. |
| Default timer seconds | Initial prompt timer; `0` means no timer. |
| Default background fit | Center, fit width, fit height, or stretch. |
| Export format | Preferred saved image format, WebP or PNG. |
| WebP quality | WebP encoder quality for exports. |
| Default drawing permissions | V1 supports GM-only saved drawing metadata. |
| Asset folder | Optional data-source folder; blank uses `worlds/{world.id}/drawing-prompts`. |
| Auto-open player window | Opens the drawing app when a prompt arrives. |
| Notify player | Shows a notification when a prompt arrives. |
| Live GM preview | Allows throttled player snapshot streaming to the prompt-owning GM. |

## Public API

The module registers `game.modules.get("drawing-prompts").api` with:

- `createPrompt(options)`
- `openPromptManager()`
- `getPrompt(promptId)`
- `getAssignment(assignmentId)`
- `saveAssignment(assignmentId, { name })`
- `placeAssignmentAsTile(assignmentId, { hidden, name })`
- `reopenAssignment(assignmentId, userId)`
- `cancelAssignment(assignmentId, userId?)`

## Hooks

The module fires:

- `drawing-prompts.promptCreated`
- `drawing-prompts.assignmentSent`
- `drawing-prompts.assignmentOpened`
- `drawing-prompts.assignmentUpdated`
- `drawing-prompts.assignmentSubmitted`
- `drawing-prompts.assignmentRejected`
- `drawing-prompts.assignmentCancelled`
- `drawing-prompts.assignmentReopened`
- `drawing-prompts.assignmentSaved`
- `drawing-prompts.assignmentPlaced`

## Known Limitations

Privacy is soft. Foundry world documents and user-data files are available to determined clients, so this module hides drawings in normal UI but does not provide cryptographic access control.

Pending submissions are held in GM client memory until saved. If the GM reloads after a player submits but before saving, the submitted image payload is lost; reopen the assignment so the player can resubmit.

Player-side reloads lose unsaved strokes because V1 has no local crash/reload recovery for in-progress drawings.

## Development

There is no build step. The module uses plain ESM `.mjs` files loaded directly by Foundry.

Run tests with:

```powershell
node --test tests/
```

Useful layout:

- `scripts/module.mjs` registers settings, sockets, API, and scene controls.
- `scripts/apps/` contains ApplicationV2 UI classes.
- `scripts/drawing/` contains the canvas engine, tools, and export helpers.
- `scripts/prompts/` contains prompt models, persistence, assets, client store, and service logic.
- `scripts/foundry/` contains Foundry integration helpers.
- `templates/`, `styles/`, and `lang/` contain UI templates, scoped CSS, and localization.
