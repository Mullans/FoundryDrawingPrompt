# SCR-65 recovery architecture discussion

Status: investigation notes for user review; no recovery architecture approved or implemented.

[SCR-65](https://linear.app/scratchprojects/issue/SCR-65) requires a user discussion before recovery (SCR-66) and shared drawing (SCR-68) implementation. The confirmed collaboration product design remains intact; this review concerns durability and recovery mechanics.

## What the current implementation preserves

- A temporary disconnect in the same player page retains the drawing engine and operation log in memory. Disconnect does not itself mark an assignment abandoned.
- `module.mjs` handles `userConnected` by asking the owning GM to redeliver active assignments. `redeliverAssignmentsForUser` sends prompt metadata; it does not restore unsent marks after a full player refresh.
- A full player refresh loses the in-memory client assignment map and engine. There is no durable checkpoint for unsent drawing work.
- GM prompt/assignment state lives in Journal flags. Pending submissions use memory, sessionStorage, staged paths and persisted fallback data. Explicit reopen can restore pending data or saved overlay/operation-log assets.
- Live preview is reduced to a 512-pixel longest edge, quality 0.5 and throttled updates. Its overlay can be omitted under the wire budget. Seeing a preview does not establish availability of full-quality recovery data.
- Submission sends to the GM and then changes local state; it lacks a durable submission-acceptance receipt. A lost/rejected submission and a reconnect race are diagnostic leads, not reproduced causes of the reported incident. SCR-58 adds invitation receipts, not submission receipts.

Implementation references: `scripts/module.mjs`, `scripts/prompts/prompt-lifecycle.mjs`, `scripts/prompts/pending-submission.mjs`, `scripts/prompts/client-store.mjs`, `scripts/apps/player-drawing-app.mjs`.

## Options to discuss

| Option | Recovery coverage | Cost / limitation |
|---|---|---|
| Player-local durable checkpoints | Same-device browser refresh recovery | Cannot alone supply GM recovery while the player is unavailable; storage loss remains a risk. |
| GM-persisted full-quality checkpoints | GM can recover and save a received checkpoint after player loss; survives GM refresh once persisted | Requires authenticated version receipts, upload/socket limits, capture cadence and retention decisions. |
| Hybrid local checkpoints plus GM persistence | Local refresh recovery plus durable GM access to acknowledged checkpoints | Adds revision reconciliation and retention complexity. |

The hybrid option is the recommended discussion starting point because it addresses both player refresh and GM saving when a player is unavailable. It is not an implementation decision.

## Decisions needed from the user

1. Must recovery survive only reconnect/refresh on the same browser, or also both browsers restarting and a player changing devices?
2. How much recent unsaved work may be lost between checkpoints? Agree a target before choosing capture cadence and bandwidth trade-offs.
3. Must a recovered player retain editable operation history, or is full-resolution raster restoration sufficient when complete history is unavailable?
4. Agree checkpoint revision/acknowledgement semantics and marked preview-only fallback, including what the GM sees when the newest full-quality save is unavailable.

The reported reconnect submission failure still needs a concrete reproduction that distinguishes temporary disconnect, full player refresh, GM refresh, and submission during disconnection. No diagnosis of abandonment or Forge-specific root cause has been established.
