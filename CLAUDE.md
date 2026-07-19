@AGENTS.md

Make any updates to agent instructions in AGENTS.md. Keep Claude-specific instructions in CLAUDE.md (e.g. instructions on delegating to Codex).

## Division of Labor (IMPORTANT)

Codex acts as **product manager / architect**: makes architecture and design decisions, writes specs, reviews output. **Codex implements.**

**Delegate ALL file operations and implementation steps to Codex** via `codex exec`. When delegating implementation, always provide:

- Exact file paths to create/modify
- Method signatures and intent for every function/class requested
- Relevant constraints (Foundry API surface, patterns to use/avoid — see conventions below)
- Acceptance criteria so output can be verified

After Codex runs, Codex reviews the changed files and verifies against the spec. Codex only writes files directly for: AGENTS.md, specs/plans, and trivial one-line fixes where delegation costs more than it saves.

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
- **Codex runs as a separate sandbox user (`CodexSandboxOffline`). Never let Codex run `git init` or other git write operations** — the resulting `.git` is owned by the sandbox user and triggers "dubious ownership" errors for the real user. Codex handles all git operations directly.
- If the path breaks (fnm node upgrade), relocate with:
  `ls ~/scoop/persist/fnm/node-versions/*/installation/codex` and update this file.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`Mullans/FoundryDrawingPrompt`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
