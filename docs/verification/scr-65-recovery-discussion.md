# SCR-65 recovery architecture discussion

Status: recovery architecture approved; implementation has not started. See [Prompt lifecycle, delivery, and recovery](../design/prompt-lifecycle-and-recovery.md) and [ADR-0006](../adr/0006-local-first-recovery-boundary.md).

[SCR-65](https://linear.app/scratchprojects/issue/SCR-65) captured the investigation that preceded approval of recovery work (SCR-66) and shared drawing work (SCR-68). The confirmed collaboration product design remains intact; this review concerned durability and recovery mechanics.

## What the current implementation preserves

- A temporary disconnect in the same player page retains the drawing engine and operation log in memory. Disconnect does not itself mark an assignment abandoned.
- `module.mjs` handles `userConnected` by asking the owning GM to redeliver active assignments. `redeliverAssignmentsForUser` sends prompt metadata; it does not restore unsent marks after a full player refresh.
- A full player refresh loses the in-memory client assignment map and engine. There is no durable checkpoint for unsent drawing work.
- GM prompt/assignment state lives in Journal flags. Pending submissions use memory, sessionStorage, staged paths and persisted fallback data. Explicit reopen can restore pending data or saved overlay/operation-log assets.
- Live preview is reduced to a 512-pixel longest edge, quality 0.5 and throttled updates. Its overlay can be omitted under the wire budget. Seeing a preview does not establish availability of full-quality recovery data.
- Submission sends to the GM and then changes local state; it lacks a durable submission-acceptance receipt. A lost/rejected submission and a reconnect race are diagnostic leads, not reproduced causes of the reported incident. SCR-58 adds invitation receipts, not submission receipts.

Implementation references: `scripts/module.mjs`, `scripts/prompts/prompt-lifecycle.mjs`, `scripts/prompts/pending-submission.mjs`, `scripts/prompts/client-store.mjs`, `scripts/apps/player-drawing-app.mjs`.

## Options considered before approval

| Option | Recovery coverage | Cost / limitation |
|---|---|---|
| Player-local durable checkpoints | Same-device browser refresh recovery | Cannot alone supply GM recovery while the player is unavailable; storage loss remains a risk. |
| GM-persisted full-quality checkpoints | GM can recover and save a received checkpoint after player loss; survives GM refresh once persisted | Requires authenticated version receipts, upload/socket limits, capture cadence and retention decisions. |
| Hybrid local checkpoints plus GM persistence | Local refresh recovery plus durable GM access to acknowledged checkpoints | Adds revision reconciliation and retention complexity. |

The hybrid option was the original discussion recommendation because it addressed both player refresh and GM saving while a player was unavailable. It was not selected: ongoing recovery is local-first, without periodic full-quality GM checkpoints. The GM's eligible Full submission is fallback only when the local Recovery copy is missing, and quick GM previews are never recovery sources.

## Approved decisions

1. The player browser stores the ongoing Recovery copy locally. There is no periodic full-quality GM backup, so cleared browser storage or a device change can lose work not otherwise captured.
2. The Recovery copy preserves unfinished drafts and undo/redo history. Local work wins over older GM-held data.
3. An eligible GM-held Full submission is fallback only when no local Recovery copy exists. If history is unavailable, show `History not found.` with OK and restore an eligible full-quality image when available, otherwise a blank drawing.
4. Quick GM previews are reduced review artifacts, never recovery. Closing a Prompt requests full drawings; a failed capture may retain clearly distinct artwork-only Saved previews, which are also never recovery.

The prior investigation did not establish a diagnosis of abandonment or a Forge-specific root cause for the reported reconnect submission failure. That remains a useful historical fact, not an open architecture decision.
