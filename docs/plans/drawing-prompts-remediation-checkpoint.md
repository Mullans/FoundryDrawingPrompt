# Drawing Prompts remediation checkpoint — 2026-09-10

The original remediation waves landed in `dev` through PR #8, including the work represented by PRs #6 and #7. The worktree at
`C:\Code\FoundryHub\modules\drawing-prompts\.worktrees\drawing-prompts-remediation`
now follows `codex/prompt-library-browser`, which carries the subsequently approved Prompt Library redesign as a separate effort.

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

## Approved follow-up: Prompt Library browser redesign

The completed product grill is recorded in `docs/design/prompt-lifecycle-and-recovery.md`. The approved visual reference is `docs/design/prompt-library-layout-mockup.html`. Implement the follow-up in these gated slices:

1. **Canonical model and persistence.** Add persisted Draft lifecycle support; rename `drawingName` to `promptName` across every internal and external surface without a compatibility alias; add creation/sent timestamps required by sorting; support legal Draft archive/restore behavior; and queue writes so lifecycle, delivery receipts, and Draft updates cannot overwrite each other. Pre-release development records using the discarded shape may be cleared instead of migrated.
2. **Application API and manager state.** Remove `openPromptManager()` and expose the explicit library/new/open/copy operations. Add create/update/send separation, unsaved-change Save/Discard/Cancel handling, manager state-specific controls, exact single-manager switching, copy sanitization, selected-offline-player retention, and the specified Prompt/Assignment reopen distinction.
3. **Library browser UI.** Make the singleton library the scene-control entry point and keep it open beside the manager. Implement unified searchable rows, status badges, current-row highlighting, archived visibility, grouped field/direction sorting with client defaults, the accessible anchored metadata popover, contextual More-actions menus, all approved empty states, and responsive layout following the stored mockup.
4. **Lifecycle cleanup and hooks.** Enforce close-first deletion for Open Prompts with the approved exact error, close the manager after deleting its displayed non-Open Prompt, refresh it after Archive/Restore, preserve all selective-cleanup rules, and emit creation/update/send/lifecycle hooks only after their defined persistence and recipient-success boundaries.
5. **Verification.** Add focused model, comparator, API, manager-transition, singleton, offline-participant, accessibility, and rendered-library tests. Run the complete unit suite and the relevant Foundry 14.364 runtime flows, clear disposable pre-release Prompt data before runtime verification, update this checkpoint with evidence, and perform only the final review gate required by the active effort.

## Prompt Library browser implementation evidence

The approved follow-up is implemented on `codex/prompt-library-browser` in coherent model/persistence, settings/localization, library UI, and manager/API commits. The scene control now opens the retained Prompt Library; the explicit public entry points are `openPromptLibrary()`, `openNewPrompt()`, `openPrompt(id)`, and `openPromptCopy(id)`. Draft persistence, canonical `promptName`, create/update/send separation, unsaved-change handling, unified sorting/filtering, metadata popovers, contextual actions, copy sanitization, and exact lifecycle rules are covered by focused tests.

Integration verification found and fixed two cross-surface issues: a deliberately opened empty Draft could be replaced by an unrelated live delivery refresh, and the library could intercept the canvas while the manager yielded for interactive placement. Delivery-completion ownership transfer remains available only to a newly registered manager that has not explicitly selected a Draft or Prompt. Interactive placement now temporarily yields both singleton windows and restores them afterward.

- Complete repository unit gate: passed on 2026-09-11.
- Foundry 14.364 `e2e-smoke.mjs`: passed end-to-end through library → compose → send → draw → snapshot → submit → save → place → close, with clean captured GM/player consoles.
- Foundry 14.364 `e2e-placement-race.mjs`: passed all Tile/Token commit, abandon, and cleanup cases.
- Foundry 14.364 `e2e-settings-migration.mjs`: passed and restored original settings.
- The delivery and reliability harnesses were updated to the explicit API and Draft semantics. Their broader legacy scenarios remain independently covered by the repository unit gate; runtime attempts exposed pre-existing timing/focus sensitivity outside the Prompt Library slice and are not claimed as passing evidence for this follow-up.

## PR #9 review remediation — 2026-09-11

The five verified review findings are addressed on `codex/prompt-library-browser`: service-level Draft validation, exact current-form saved-Draft Send, settled-initial-delivery `promptSent` in both awaited and nonblocking modes, shared Draft framing editability, and Open-only resend at UI and service boundaries. Saved-Draft Send persists edits before fallible framing preparation, then commits Open and assignments; per-Prompt Draft operations are queued. Regressions cover invalid partial updates, preparation failure, concurrent Send/update, mixed and zero receipts, framing controls, and resend status guards.

- Focused delivery/service/manager tests: passed.
- Full `node --test tests/*.test.mjs` unit suite: 469 passed, 0 failed.
- Foundry runtime gate: not yet verified. The local 14.364 data directory had a stale empty `Config/options.json.lock` (removed after verifying no Foundry desktop process and no port-30000 listener). A fresh server start then failed opening the `effects` database and reported `EADDRINUSE` despite no listener; this needs environment resolution before smoke and saved-Draft runtime can be claimed.
- Commit `d263806` was pushed to PR #9. All six inline comments covering the five unique findings received evidence replies. One final integrated read-only review found no substantive issues; its minor explicit-null framing edge was tightened before the final 469-test unit run.
