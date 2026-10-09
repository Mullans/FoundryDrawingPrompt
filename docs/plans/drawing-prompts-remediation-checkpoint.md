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
- Foundry runtime correction: after the user killed a competing background Foundry process, a fresh 14.364 server started, opened the `effects` database, and listened on port 30000; `/join` returned HTTP 200. The prior lock/database/port failure was therefore consistent with competing processes and was incorrectly treated as an unresolved environment blocker. `e2e-smoke.mjs` passed end-to-end. `e2e-delivery.mjs` passed its immediate, Retry, Continue, zero-receipt, and bulk-resend stages, then failed at its second deliberate GM reload with a 20-second browser-evaluation timeout; the harness reported fixture cleanup. The targeted saved-Draft reopen → edit → Send runtime scenario is still not verified. Do not claim the complete runtime gate passed.
- Commit `d263806` was pushed to PR #9. All six inline comments covering the five unique findings received evidence replies. One final integrated read-only review found no substantive issues; its minor explicit-null framing edge was tightened before the final 469-test unit run.

## Release PR #10 review remediation — 2026-10-09

Work started from `dev` at `a9a3d56` on `codex/pr10-greptile-remediation`. Existing local changes to AGENTS.md, .gitignore, and .ignore belong to the user and are excluded from this effort.

All 17 Greptile findings were verified at their persistence, recovery, and UI boundaries. The earlier stale-live-capture finding overlaps PR #11; offline capture selection is additionally corrected to choose the newest full-quality pending/retained/saved candidate.

- Security: validate retained-capture responses using assignment-scoped submission validation; allowlist cleanup paths again before file deletion; compare complete identities before closing a player app for cleanup.
- Recovery: persist Undo/Redo changes, preserve published history on pagehide, try GM fallback after a local-store read failure, collect orphan tiles atomically with generation references, and count retained canvas allocations in the session budget.
- Lifecycle/delivery: persist initial delivery and automatic timer-hold state, settle successful Retry/Continue once without overriding an explicit timer pause, reject fractional dimensions and Archived assignment reopen, and require the latest Draft state at the Send commit.
- Manager/review: share pending Draft Save and lock conflicting actions, display retained full captures and distinctly labeled Saved previews after cache loss, and prevent Saved previews from enabling placement.
- Verification: replace obsolete operation-log counts in the reliability harness and add real multi-tile browser pixel assertions. Those checks exposed and fixed initial multi-point line previews rendering only their final segment. Native comparisons require exact stable interior/exterior pixels; cancellation and Undo/Redo require exact foreground restoration, including curved translucent strokes over a PNG layer. Reload coverage waits for acknowledged durable artwork publication; navigation before asynchronous publication completes remains naturally vulnerable.

Final unit evidence: 499 tests passed, zero failed (`.artifacts/test-logs/20261009-215735-5244-node.log`). Foundry 14.364 history runtime passed (`20261009-215531-46044-node.log`), complete delivery runtime passed (`20261009-220426-39480-node.log`), and reliability passed (`20261009-220844-14728-node.log`). Delivery first reproduced a harness race after zero-receipt Back-to-setup on both original and fresh servers; bounded manager-idle/render/new-Draft preconditions fixed the harness without weakening receipt expectations. The complete passing run includes both actual GM reloads, Retry/Continue, bulk resend, and forged-receipt rejection.

Foundry 14.364 UI smoke passed through library, compose, send, draw, snapshot, submit, save, place, and close (`20261009-220957-35516-node.log`). The managed test server is stopped after verification.

The single final independent Standards/Spec pair is complete. Standards found no substantive issues. Spec found that an older retained full capture could override newer qualified saved artwork after reopen/resubmit/Save and cache loss. A red-first regression verified the mismatch; shared retained-capture freshness now makes the newer Save win in both review views while preserving equal/newer full capture eligibility. Final unit rerun: 501 passed, zero failed (`20261009-221348-26560-node.log`).

The affected preview reliability runtime passed again after that correction (`20261009-221349-25424-node.log`). Fixes return through a feature PR into dev with evidence replies on all 17 verified Greptile threads. Release PR #10 remains unmerged; Forge verification remains unavailable. The earlier targeted saved-Draft reopen/edit/Send runtime limitation is not superseded by these gates.

## Release concurrency follow-up — 2026-10-09

The user requested two additional release perspectives, then authorized fixes for both reproduced blockers. Work starts from dev `84c532c` on `codex/release-race-fixes`; user-owned AGENTS.md, .gitignore, and .ignore changes remain excluded.

- Lifecycle: Archive can read a Draft while Send's Open flag write is in flight, queue behind it, and overwrite the newly Open Prompt with Archived while retaining active Assignments. Each lifecycle save now validates its source lifecycle inside the existing persistence queue. Close additionally rejects non-Open Prompts before timer or capture side effects. Nine regressions exercise actual Send/Archive competition, stale reopen/restore transitions, and invalid Close calls. Focused service gate: 78 passed (`20261009-222857-25988-node.log`); red evidence `20261009-222811-24144-node.log`.
- Recovery: quota enforcement can evict another writer's active staging record and tiles, after which that writer publishes an unrestorable generation and reports success. The correction protects active save phases with a bounded lease and makes eviction and existing-record publication conditional within native IndexedDB transactions. Abandoned records remain reclaimable; an evicted writer must fail rather than recreate its generation. A native two-connection browser regression supplements deterministic adapter interleavings.
- Deferred: whole-store byte accounting/cleanup costs and Prompt Library summary/search optimization are outside this fix.

Recovery uses a 60-second lease renewed before tile batches and publication phases. Eviction checks current lease state atomically; publication replaces only an existing generation. Expired abandoned writers become reclaimable, and resumed evicted writers throw through the existing storage-failure warning/retry path. Conditional corrupt-history repair preserves active pins and cannot recreate an evicted record.

The post-read supersession guard also prevents older cleanup from pruning a newer generation that appears during an adapter read. Final focused store/coordinator gate: 23 passed (`20261009-223344-49360-node.log`), with red evidence for staging (`20261009-222951-23744-node.log`) and delayed-read supersession (`20261009-223336-2792-node.log`).

Final integrated gate: 518 unit tests passed (`20261009-223400-49408-node.log`). The complete history runtime, including the new native two-connection quota regression, passed (`20261009-223237-4084-node.log`). UI smoke passed through library, compose, send, draw, snapshot, submit, save, place, and close (`20261009-223400-42760-node.log`). The single final independent Standards/Spec pair found no substantive issues. The managed test server was stopped. Fixes return through a feature PR into dev; release PR #10 remains unmerged.

PR #13's automated Codex review caught a related false-warning regression: when a newer same-identity save finishes and removes an older in-flight generation, the older writer must return stale rather than warn about a storage failure. The minimal error handler now distinguishes genuine current-writer eviction from intentional supersession. Real store/coordinator regressions cover both primary and history preemption with no warning and newer pixels restored. Red evidence: `20261009-224016-5616-node.log`; focused 25-test green evidence: `20261009-224024-31972-node.log`; final full rerun: 520 passed, zero failed (`20261009-224051-19824-node.log`). This follow-up changes only that error classification; prior native quota and smoke evidence remains applicable.
