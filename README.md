# Drawing Prompts

Drawing Prompts is a Foundry VTT module for private, per-player drawing requests during play. A GM sends a prompt to selected players, watches live snapshot previews, receives submitted images, saves the result to world data, and can place the merged drawing as a visible or hidden Scene Tile.

## Requirements

- Foundry VTT v13 or v14.
- The `socketlib` module installed and enabled in the world.

## Installation

Install from the release manifest URL:

```text
https://github.com/Mullans/FoundryDrawingPrompt/releases/latest/download/module.json
```

Paste that URL into Foundry's Install Module dialog. On The Forge, use the same URL in the Bazaar custom-manifest field.

For the manual or Forge Import Wizard route, build the release archive locally and upload `dist/module.zip`:

```powershell
.\tools\build-release.ps1
```

Install `socketlib` separately before enabling Drawing Prompts. On The Forge, use the Bazaar one-click install; in standard Foundry, install it from the official module listing. Drawing Prompts requires Foundry VTT v13 or newer and is verified on Foundry VTT v14.364.

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

## Submission Transport

Drawing submissions use two transport lanes. Players with the core `Upload New Files` permission (`FILES_UPLOAD`) stage full-resolution overlay and merged images directly into the configured asset folder under `staging`, then only the staged paths and operation log cross the socket. Players without that permission use the socket fallback lane; the module may reduce image quality or resolution to stay under Foundry socket-size limits.

Staged filenames are deterministic per assignment, such as `{assignmentId}-overlay.webp` and `{assignmentId}-merged.webp`, so resubmitting overwrites that player's prior staged files. Foundry does not expose a client-side delete API, so abandoned staged files can remain, but they are bounded to one overlay and one merged file per assignment id.

## Settings

| Setting | Purpose |
| --- | --- |
| Default canvas width | Initial logical drawing width. |
| Default canvas height | Initial logical drawing height. |
| Default timer seconds | Initial prompt timer; `0` means no timer. |
| Default background fit | Center, fit width, fit height, or stretch. |
| Export format | Preferred saved image format, WebP or PNG. |
| WebP quality | WebP encoder quality for exports. |
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

Pending socket-lane submissions are cached in the GM's current browser session until saved, so they survive a GM reload in the same session. They are still lost after logout, browser close, or browser storage eviction; reopen the assignment so the player can resubmit. Staged-lane submissions also cache their small path payload in the GM session, and the images are server files, so they can usually still be saved after logout as long as the staged files remain on the server.

Player-side reloads lose unsaved strokes because V1 has no local crash/reload recovery for in-progress drawings.

## Development

There is no build step. The module uses plain ESM `.mjs` files loaded directly by Foundry.

For local development from this repository, create a junction into your Foundry data `Data/modules` folder:

```powershell
.\tools\link-module.ps1 -FoundryDataPath "C:\Code\FoundryVTT\FoundryVTT-WindowsPortable-14.364"
```

Then start Foundry, open your world, enable `socketlib`, and enable `Drawing Prompts`.

Run tests with:

```powershell
node --test tests/
```

Optional E2E smoke coverage is available when a local Foundry server is already running on port 30000:

```powershell
node .\FoundryVTT-WindowsPortable-14.364\App\resources\app\main.js --dataPath="C:\Code\FoundryVTT\FoundryVTT-WindowsPortable-14.364" --port=30000 --world=test-world
npm i playwright
node tools\e2e-smoke.mjs
```

The smoke script expects users named `Gamemaster` and `Player2`, joins through `/join`, drives the real GM/player UI, and exits non-zero on any failed step.

Useful layout:

- `scripts/module.mjs` registers settings, sockets, API, and scene controls.
- `scripts/apps/` contains ApplicationV2 UI classes.
- `scripts/drawing/` contains the canvas engine, tools, and export helpers.
- `scripts/prompts/` contains prompt models, persistence, assets, client store, and service logic.
- `scripts/foundry/` contains Foundry integration helpers.
- `templates/`, `styles/`, and `lang/` contain UI templates, scoped CSS, and localization.
