# FoundryVTT Module Workspace

## Division of Labor (IMPORTANT)

Claude acts as **product manager / architect**: makes architecture and design decisions, writes specs, reviews output. **Codex implements.**

**Delegate ALL file operations and implementation steps to Codex** via `codex exec`. When delegating implementation, always provide:

- Exact file paths to create/modify
- Method signatures and intent for every function/class requested
- Relevant constraints (Foundry API surface, patterns to use/avoid — see conventions below)
- Acceptance criteria so output can be verified

After Codex runs, Claude reviews the changed files and verifies against the spec. Claude only writes files directly for: CLAUDE.md, specs/plans, and trivial one-line fixes where delegation costs more than it saves.

### Invoking Codex

Codex is installed via npm under fnm (scoop-persisted). Stable path:

```
C:\Users\Sean\scoop\persist\fnm\node-versions\v24.12.0\installation\codex.cmd
```

From the Bash tool:

```bash
CODEX="/c/Users/Sean/scoop/persist/fnm/node-versions/v24.12.0/installation/codex"
"$CODEX" exec --sandbox workspace-write -C "C:\Code\FoundryVTT" - < prompt.md
```

- Use `codex exec` (non-interactive) with `--sandbox workspace-write` (`--full-auto` is deprecated).
- Write long prompts to a scratchpad file and pass via stdin (`- < prompt.md`) to avoid quoting issues.
- **Codex runs as a separate sandbox user (`CodexSandboxOffline`). Never let Codex run `git init` or other git write operations** — the resulting `.git` is owned by the sandbox user and triggers "dubious ownership" errors for the real user. Claude handles all git operations directly.
- If the path breaks (fnm node upgrade), relocate with:
  `ls ~/scoop/persist/fnm/node-versions/*/installation/codex` and update this file.

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

No build step (plain ESM). Verify by launching the local Foundry portable, enabling the module in a test world, checking the console for the module's init/ready logs and for errors.

Automated UI verification: run the portable Foundry headless (`node App/resources/app/main.js --dataPath=<portable root> --port=30000 --world=test-world`) and drive GM + player clients with Playwright — always through real UI interaction (typing, clicking), never only the module API, which can mask form-binding bugs.

**Wedged-server rule:** a long-running headless test server can silently wedge — static file fetches hang (dynamic `import()` awaits forever with no rejection) and socket relays drop, which perfectly mimics impossible module bugs with symptoms that move between runs. Before deep-diving any shifting-symptom failure, kill and restart the test server and re-run the repro twice; only debug the module if the failure survives a fresh server. Prefer one fresh server per verification batch.
