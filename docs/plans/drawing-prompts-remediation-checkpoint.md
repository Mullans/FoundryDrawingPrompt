# Drawing Prompts remediation checkpoint — 2026-09-10

Work is complete on `codex/drawing-prompts-remediation` in
`C:\Code\FoundryHub\modules\drawing-prompts\.worktrees\drawing-prompts-remediation`.
The branch absorbs the work represented by PRs #6 and #7 and is ready to be proposed to `dev`.

## Landed checkpoints

- `99e8b19`: serialized/coalesced manager delivery refresh, warning-state deduplication, and manager ownership transfer.
- `6838922`: deep player-local Recovery module, schema validation, autosave/flush, local-first restoration, and GM flat fallback.
- `c0661ec`: retained Prompt lifecycle, close-time captures, Prompt Library, deletion tombstones, public API, and lifecycle hooks.
- `07bc176`: real Foundry Tile preview/cursor/created-bounds alignment and delivery-dialog lifecycle cleanup.
- `875a36b`, `8a67a81`, `94ced8b`: recovery-cleanup authorization, transactional deletion ordering, degraded-base replay, retained-capture failure handling, and library singleton release.
- Subsequent delivery-harness commits align runtime coverage with the modal Retry/Continue/Back workflow and deliberate GM reload semantics.

## Verification evidence

- Full unit suite: 424 tests passed after the final production changes.
- Delivery-focused gate: three consecutive passes before Wave 2; final unit coverage includes close/reopen ownership transfer, refresh coalescing, dialog deduplication, and generation reset.
- Foundry 14.364 runtime:
  - `e2e-smoke.mjs`: passed, including live rendered preview center and created Tile bounds.
  - `e2e-placement-race.mjs`: passed twice consecutively.
  - `e2e-reliability.mjs`: passed.
  - `e2e-settings-migration.mjs`: passed.
  - `e2e-delivery.mjs`: all functional cases passed. The deliberate hard GM reload produces two classified socketlib transport-disconnect diagnostics; no unexpected module/browser errors remain.
- The lifecycle/delivery final reviews found no unresolved defects after their verified fixes. The later bounded-history review pair is recorded in its follow-up evidence below.

## Evidence still requiring a human or unavailable integration

- Human walkthrough sign-off remains required for Recovery reload, Close/reopen, Archive/Restore/Delete, singleton windows, and rendered cursor alignment. Agents must not claim human completion.
- Lifecycle/library walkthroughs remain human-only. Recovery through a real player-page reload is now covered by the dedicated history runtime harness.
- Linear reconciliation remains pending because no Linear integration was available in this session. Move issues to human review with this commit/runtime evidence; do not mark them Done.
- Forge timing remains explicitly unverified.
- Do not merge, release, tag, target `main`, bump the release version, close older PRs, or mark Linear work Done without authorization.

## Follow-up: bounded pixel history and IndexedDB Recovery

The earlier operation-log/checkpoint recovery design has been superseded on this branch. The player engine now retains at most 25 pixel-tile actions, uses one directional reference per changed tile with direct pixel Undo/Redo, keeps exact-identity sessions across window close/reopen, and publishes artwork-first local IndexedDB generations with optional coherent history. Stable writer-scoped versions are shared across consecutive generations and written only when missing. New submissions, retained captures, and saved GM assets do not carry or write the local history.

- Full unit suite: 446 tests passed.
- Foundry 14.364 `e2e-smoke.mjs`: passed with clean GM/player consoles and fixture cleanup.
- Foundry 14.364 `e2e-history-runtime.mjs`: passed at 2048² and 4096², including IndexedDB history recovery across a real player-page reload. Recorded maxima were 1.6 ms pointer-up history work, 0.2 ms next-stroke notification, and 11.4 ms gesture-render work; retained 4096² pixel bytes were 67,174,400.
- The final review pair identified and the follow-up fixed interrupted artwork-staging cleanup, optional-history preemption, duplicated tile geometry, and stale engine lifecycle fields. Focused tests now cover both primary-batch failure and a newer edit interrupting optional history while retaining published artwork.
- Manual testing exposed a live-refresh race: the newest completed action could remain behind the Recovery debounce or an older optional-history save. Completed actions now begin artwork-only publication immediately while coherent history remains debounced; focused tests cover immediate publication and publication while an older save is unresolved. The real rapid-reload assertion is included in `e2e-history-runtime.mjs`.

The human and Forge limitations above remain unchanged.
