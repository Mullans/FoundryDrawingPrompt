# FoundryVTT Module Workspace

## Foundry Install

Folders starting with "FoundryVTT-WindowsPortable" contain the local install of FoundryVTT and should be considered as immutable reference.

For any implementation effort, make sure to divide the work into tasks (individual work items) and waves (groups of tasks that can be implemented in parallel and don't block/conflict). Use parallel sub-agents or Codex calls to implement tasks within the same wave when feasible and reasonable.

## Repository Layout

Repo root **is** the module root (`module.json` at root). The Foundry portable install (`FoundryVTT-WindowsPortable-14.364/`) and its zip live beside it but are gitignored — they are the local test runtime, not part of the module.

```
module.json      manifest (id must match installed folder name)
scripts/         ES modules (entry: scripts/module.mjs)
styles/          scoped CSS
templates/       Handlebars templates
lang/            localization (en.json)
tools/           dev scripts (e.g. link-module.ps1 to junction into Foundry Data/modules)
foundry_research.md   deep-research primer on Foundry module development — read before architectural work
```

## Foundry Development Conventions

Target: **Foundry v14 first** (current stable 14.364), keep v13 compatibility where cheap. Derived from `foundry_research.md`:

- **ES modules only** (`esmodules` in manifest), never legacy `scripts`.
- **Hooks-first**: prefer public hooks (`init`, `ready`, `getSceneControlButtons`), registered settings, document APIs, and applications. Never monkey-patch core; if a patch is truly unavoidable, use libWrapper.
- **UI = ApplicationV2 / DialogV2** with HandlebarsApplicationMixin. Simple forms → DialogV2; tools/canvases → custom ApplicationV2. No DOM hacks.
- **Targeted client communication**: native `User#query` (`CONFIG.queries`) on v13+, or socketlib if ecosystem compatibility matters. Payloads/results must be JSON-serializable. Validate the initiator is a GM in every remote handler.
- **Permissions**: resolve users from actor ownership via `testUserPermission`, not raw ownership levels.
- **Persistence**: namespaced document flags for module data.
- **Public API** on `game.modules.get(id).api`; fire custom hooks for lifecycle moments.
- **CSS**: scoped/layered, keep out of Foundry's global styles.
- SemVer, version as string in manifest, localize from the start.
- Dev iteration: `CONFIG.debug.hooks = true` reveals hook firing.

## Verification

No build step (plain ESM). Use this lifecycle for each verification batch:

1. Set `$foundryRoot = (Resolve-Path '.\FoundryVTT-WindowsPortable-14.364').Path`, then run `.\tools\link-module.ps1 -FoundryDataPath $foundryRoot`.
2. Start a fresh background server and retain its PID: `$foundryProcess = Start-Process node -ArgumentList @("$foundryRoot\App\resources\app\main.js", "--dataPath=$foundryRoot", "--port=30000", "--world=test-world", "--noupdate", "--hotReload") -WindowStyle Hidden -PassThru`. Poll `http://localhost:30000/join` for HTTP 200 instead of using a fixed sleep. If port 30000 belongs to an unknown process, inspect/report it; never kill it blindly.
3. Run `node --test tests/`. For Foundry-facing or UI changes, also run `node tools/e2e-smoke.mjs` and check GM/player browser consoles for errors. UI automation must type and click through the real UI, not call only the module API.
4. Always clean up in a `finally` block: `if ($foundryProcess -and -not $foundryProcess.HasExited) { Stop-Process -Id $foundryProcess.Id }`. Stop only the PID started for the current batch.

**Wedged-server rule:** a long-running headless test server can silently wedge — static file fetches hang (dynamic `import()` awaits forever with no rejection) and socket relays drop, which perfectly mimics impossible module bugs with symptoms that move between runs. Before deep-diving any shifting-symptom failure, kill and restart the test server and re-run the repro twice; only debug the module if the failure survives a fresh server. Prefer one fresh server per verification batch.
