# Reliability foundations work in progress

Branch: `codex/scr-62-reliability-foundations`, based on `dev` commit `de1e61f`.

This branch is independent of the reviewed SCR-58 delivery PR. Implementation agents stopped with a usage-limit error on 2026-09-07. The working snapshot passes `node --test tests/`, but the package is not ready to integrate: implementation/coverage below remains unfinished, required twin reviews and runtime verification are outstanding.

| Issue | Current snapshot | Remaining work |
|---|---|---|
| SCR-57 | Placement keeps the captured scene/stage; the first click enters a commit state and waits for document creation before returning. Added a failing-then-passing delayed-create/layer-switch regression. | Finish Token and caller integration coverage, including temporary Actor retention/cleanup, create rejection, duplicate clicks, pre-click cancellation and scene changes during preparation. Review implementation and verify runtime Tile/Token state and placement records. |
| SCR-59 | Snapshot selection helper keeps an individually valid requested overlay when the pair exceeds the wire budget; wholly invalid snapshots are skipped. Added helper tests. | Review wiring and prove successive oversized snapshots update Full Framing in Foundry. |
| SCR-60 | Issue/implementation planning only; no focus-scoping implementation yet. | Scope shortcuts to their owning drawing window, preserve text-input/Foundry bindings and Space cleanup, and verify two concurrent drawing apps. |
| SCR-61 | Migration checks explicit world storage via `getItem` before changing inherited Fit Width. Explicit preferences survive; unavailable storage defers migration. Five focused tests pass, including red reproduction of the original overwrite. | Twin review and runtime compatibility confirmation. Already-overwritten historical settings cannot be reconstructed by this fix. |

Next steps: finish the missing implementation and coverage, run independent Standards and Spec reviewers against the branch baseline, remediate findings, run the full suite and real Foundry verification, then update the existing Linear issues with evidence. Do not mark issues Done without the repository's explicit closure authorization.

The main checkout remains on `codex/scr-58-prompt-delivery`; the portable Foundry module junction still points to that main checkout. Before runtime verification here, explicitly arrange the test checkout/junction and restore it afterward. Do not assume the worktree is the running module.
