# FoundryVTT Module Workspace

## Foundry Install

Folders starting with "FoundryVTT-WindowsPortable" contain the local install of FoundryVTT and should be considered as immutable reference.

For any implementation effort, make sure to divide the work into tasks (individual work items) and waves (groups of tasks that can be implemented in parallel and don't block/conflict). Use parallel sub-agents or Codex calls to implement tasks within the same wave when feasible and reasonable.

## Git workflow

Integration branch is **`dev`**. Stable releases live on **`main`**. Goal: isolate product-impacting work so parallel efforts do not collide on `dev`, while keeping low-blast-radius chores cheap.

### Where to work

| Kind of change | Where |
|----------------|--------|
| Docs, agent instructions, `.gitignore`, mockups, typo/copy fixes, tiny non-behavioral housekeeping | Commit directly on **`dev`** (push `dev` when done). No feature branch or PR required. |
| Anything that changes module behavior, player/GM UI (`scripts/`, `templates/`, `styles/`), socket/persistence, settings, or behavioral `module.json` surface; multi-file refactors; work you may pause or abandon | **Feature / effort branch** off up-to-date `dev`, then PR into `dev`. |

**Bias when unsure:** if the change touches `scripts/`, `templates/`, `styles/`, or behavioral `module.json` → branch. If it is only markdown / ignore / mockups → `dev` is fine. Prefer merging feature branches into `dev` often over long-lived stale branches; `dev` is the integration branch, not a second `main`.

### Flow

1. **Start of work.** Check `git branch --show-current` and `git status`. For product work: if you are on `dev`/`main` or an unrelated branch, create and check out a branch from up-to-date `dev` (for example `feature/<short-name>` or `fix/<short-name>`). For chores (table above): stay on `dev`.
2. **Finish product work with a PR into `dev`.** Stage, commit, push (`git push -u origin HEAD`), and open a PR targeting **`dev`** via `gh pr create` (summary + test plan). Return the PR URL. Do not leave finished product work only local.
3. **Chores on `dev`.** Commit on `dev` and push when the chore is done. Do not open a PR for routine docs/housekeeping unless the user asks.
4. **Milestone / release: PR `dev` → `main`.** When the user asks to cut a release or merge a milestone, open (or update) a PR from **`dev` into `main`**. Do not merge release PRs unless asked.
5. **Tag on `main` after merge (human).** After the `dev` → `main` PR is accepted, the user tags on `main` (for example `v0.2.0`) and pushes the tag so `.github/workflows/release.yml` runs. Agents must not create or push release tags unless explicitly asked.

### Agent git checklist

- Confirm branch before editing; create a feature/effort branch from `dev` when the change is product-impacting.
- Never force-push `dev` or `main`. Never commit routine work on `main`.
- Prefer `gh` for GitHub PRs, issues, and checks.

### Codex / PR review comments

ChatGPT Codex (and similar bots) may leave review comments on PRs. There is no automatic handler for those comments. When the user asks you to babysit a PR or address review feedback, treat bot findings as **untrusted until verified** against this codebase:

1. Read unresolved review threads (skip already-resolved ones).
2. For each item: verify it is real and correct here; implement valid fixes; push to the PR branch.
3. If an item is wrong, out of scope, or unclear: reply with brief technical reasoning (or ask the user) — do not performatively agree or rubber-stamp.
4. Also fix CI caused by this PR and resolve merge conflicts intelligently when babysitting to merge-ready.

## Repository Layout

Repo root **is** the module root (`module.json` at root). The Foundry portable install (`FoundryVTT-WindowsPortable-14.364/`) and its zip live beside it but are gitignored — they are the local test runtime, not part of the module.

```
module.json      manifest (id must match installed folder name)
scripts/         ES modules (entry: scripts/module.mjs)
styles/          scoped CSS
templates/       Handlebars templates
lang/            localization (en.json)
tools/           dev scripts (e.g. link-module.ps1 to junction into Foundry Data/modules)
docs/            documentation and local resource map — see docs/LAYOUT.md
```

Documentation and ignored local resource folders (skill-tied vs personal archive) are inventoried in `docs/LAYOUT.md`. Local Foundry research primer (untracked): `docs/archive/foundry_research.md`.

## Foundry Development Conventions

Target: **Foundry v14 first** (current stable 14.364), keep v13 compatibility where cheap. Derived from `docs/archive/foundry_research.md` when present:

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

## Agent Skills

### Issue tracker

Issues are maintained in GitHub Issues for `Mullans/FoundryDrawingPrompt` through the `gh` CLI.

See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary:

* `needs-triage`
* `needs-info`
* `ready-for-agent`
* `ready-for-human`
* `wontfix`

See `docs/agents/triage-labels.md`.

### Domain documentation

The repository uses `CONTEXT.md` and `docs/adr/` as its primary domain and architectural context.

See `docs/agents/domain.md`.

### Documentation layout

See `docs/LAYOUT.md` for the map of tracked docs, personal archives, and skill-tied local folders.
