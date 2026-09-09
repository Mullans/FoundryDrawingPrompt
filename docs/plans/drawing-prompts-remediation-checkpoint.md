# Drawing Prompts remediation checkpoint — 2026-09-09

Resume in `C:\Code\FoundryHub\modules\drawing-prompts\.worktrees\drawing-prompts-remediation` on `codex/drawing-prompts-remediation`. The branch preserves the walkthrough foundation from `39578f1`; do not restart from `dev`.

## Completed checkpoints

- `cc2dfde` + `cc64775`: lifecycle/recovery design, glossary, and ADR-0006. Independent Standards and Spec re-reviews passed.
- `c170a68` + `517a9c0`: authoring and initial-delivery UX, timer gating, modal warnings, localization, and close/dismiss safeguards. Before the latest WIP, focused delivery tests passed 30/30 and the aggregate unit suite passed.
- PRs #6 and #7 were rechecked as open/clean against `dev`. Port 30000 was not listening. No remediation PR, runtime verification, or Linear writes were completed.

## Current uncommitted WIP — preserve it

`git status` currently shows modifications to:

- `scripts/apps/drawing-prompt-manager.mjs`
- `tests/manager-delivery.test.mjs`

The interrupted agent was addressing the final delivery review findings:

1. If manager A closes during Send and manager B opens before persistence finishes, B must adopt the completed prompt; A must never render again.
2. Opening an unresolved persisted prompt must render and then show the appropriate Retry/Continue or Retry/Back modal exactly once.
3. The remaining duplicate-Send test must use deferred barriers, not 5 ms polling/sleeps.

The agent hit the Codex usage limit before reporting or committing. Treat these edits as unfinished and unverified: inspect the full diff, complete the TDD cycle, run focused tests repeatedly plus `rtk proxy node --test tests/`, then run fresh independent Standards and Spec reviews for the full delivery range `cc64775..HEAD`.

## Remaining implementation

After the delivery gate passes: implement player-local editable recovery and browser-restart coverage; retained Closed/Archived prompt lifecycle, close-time full capture/fallbacks, and the separate library using the registered editor singleton; rendered Tile-bounds/cursor alignment regression; full Foundry verification; Linear reconciliation; then push and open a PR to `dev`. Do not merge, release, tag, or mark Linear issues Done.
