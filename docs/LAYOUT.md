# Documentation and local resources

Codebase layout lives in `README.md`. This file maps **documentation and resource folders**: which are tracked, which are skill-owned, and which are personal organization.

## Tracked docs

- `AGENTS.md`: shared agent instructions for this repo.
- `CLAUDE.md`: Claude-specific orchestration (Codex delegation, skill pointers).
- `CONTEXT.md`: domain vocabulary (ubiquitous language).
- `README.md`: module product docs and codebase-oriented layout.
- `docs/LAYOUT.md`: this map of documentation and local resource folders.
- `docs/agents/`: tracked agent how-to docs (domain, issue tracker, triage labels).
- `docs/adr/`: architectural decision records when present (created by domain-modeling workflows).
- `docs/design/`: short product/display design notes tied to active slices (not personal archive). Grilled UI/layout decisions that implementers must follow belong here (with an ADR when the decision is hard to reverse / surprising).
- `mockups/`: tracked HTML UI mockups used as visual references.
- `tools/forge-probe.md`: tracked Forge path-probe snippets for console debugging.

## Personal organization (untracked)

- `docs/archive/`: untracked personal archive for generated or research docs kept for later.
- `ignore__*`: catch-all prefix for ad-hoc local dumps that should stay out of git.

## Skill-tied local trees (untracked)

- `docs/superpowers/plans/`: untracked; used by the Superpowers `writing-plans` skill to store plan files.
- `docs/superpowers/specs/`: untracked; used by the Superpowers `brainstorming` skill to store design specs.
- `.planning/`: untracked; GSD skill tree (`ROADMAP.md`, `STATE.md`, phases, research).
- `.worktrees/`: untracked; Superpowers preferred project-local git worktree root.
- `.superpowers/`: untracked; Superpowers runtime state (for example SDD progress).
- `.cursor/`: untracked; Cursor IDE plans and project UI state.
- `.design-sync/`: untracked; Claude Design durable sync config, notes, and owned previews.
- `.ds-sync/`: untracked; Claude Design staged converter scripts and isolated npm deps.
- `ds-bundle/`: untracked; Claude Design generated bundle output.
- `design-system/`: untracked; hand-authored Foundry house-style package (`foundry-ds`) synced via Claude Design.
- `.claude/`, `.agents/`: untracked; local agent and skill tooling state.
- `skills-lock.json`: untracked; Claude skills lockfile (pinned skill hashes).
