# Reliability foundations work in progress

Branch: `codex/scr-62-reliability-foundations`, based on `dev` commit `de1e61f`.

This branch is independent of the SCR-58 delivery PR. Implementation and full unit coverage are complete. Independent Standards and Spec reviews of `de1e61f...9537436` found no actionable defects. The full repository suite and Foundry smoke flow pass. Independent review of the final runtime harness changes found no defects.

| Issue | Current snapshot | Remaining work |
|---|---|---|
| SCR-57 | Captured scene/stage and first-click commit boundary; 19 focused tests cover Tile/New Actor/Copy Actor persistence, delayed creation, rejection, duplicate clicks, pre-click cancellation and asynchronous preparation scene changes. | `e2e-placement-race.mjs` passed twice consecutively on Foundry v14: Tile/New Actor both race orders, original-scene document and exact persisted record, Actor retention, manager restoration, and rejected-create Actor cleanup. Human sign-off remains. |
| SCR-59 | Valid requested overlay survives oversized composite+overlay payload; wholly invalid snapshots are skipped. | Foundry v14 `e2e-reliability.mjs` passes successive oversized red/blue overlay transport and Full Framing rendered-pixel assertions. Human sign-off remains. |
| SCR-60 | Keyboard events handled on the owning application root before Foundry's window handler; drawing interaction establishes focus, editing/native controls are preserved, focus loss clears Space/pan. | Two real concurrent apps pass tool selection, Enter/Escape draft isolation, outside/text focus and Space handling. The final runtime run also holds Space across focus exit/return without keyup and verifies a normal stroke, unchanged sibling drawing and no pan. Human sign-off remains. |
| SCR-61 | Explicit world storage choice preserved; inherited defaults migrate idempotently; unavailable storage defers. Five focused tests pass, including original overwrite reproduction. | `e2e-settings-migration.mjs` passes actual v14 storage choice/default/idempotence and restores original values/absence. Historical overwritten preferences cannot be reconstructed. Human sign-off remains. |

An initial placement harness run collided with its own previous Token at the next click location. A fresh server reproduced that fixture problem; removing each case's created documents by exact ID after its assertions fixed the harness. No product change was needed for the collision. Final runs captured no page/console errors and restored the original scene after cleaning only their own fixtures.

Final focus/overlay run `ReliabilityE2E-1788813981243` passed on 2026-09-07 with no page/console errors and fixture cleanup completed. The existing issues remain open for human review. Do not mark issues Done without explicit closure authorization.

The main checkout remains on `codex/scr-58-prompt-delivery`. Runtime verification temporarily links this worktree into the portable Foundry module directory, then restores the main checkout. Always verify the current junction before running a branch-specific test.
