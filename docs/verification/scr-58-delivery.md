# SCR-58 delivery verification

Issue: [SCR-58](https://linear.app/scratchprojects/issue/SCR-58). Effort: [SCR-62](https://linear.app/scratchprojects/issue/SCR-62).

## Behavior under review

Send renders feedback and disables duplicate sends before Journal storage and background preparation. The GM waits up to ten seconds for automatic authenticated receipts; dispatch or window-render completion alone does not establish receipt. The public API's `awaitDeliveries: false` returns after preparation while receipt tracking continues. The default and explicit `true` await bounded receipt resolution.

Failed or unconfirmed invitations show player names and Retry/Continue. Retry preserves invitation identity. Continue withdraws only unconfirmed invitations; late contact cannot revive them. Reinvitation uses a new assignment. With zero recipients, the manager retains setup and supports Retry until Continue discards the empty attempt. Successful membership survives disconnect and drawing-state changes. New invitations require online non-GM users and inherit the prompt deadline.

Intentional resend after cancellation advances an invitation generation. Old OPEN, cancellation and receipt messages cannot override that newer attempt. A delayed duplicate OPEN cannot cancel an already submitted drawing. The existing `drawing-prompts.assignmentSent` hook remains available alongside delivery updates and timing hooks.

## Automated verification

- `node --test tests/`: repository suite, including real lifecycle/persistence/transport seam tests and manager Send/Continue action tests.
- `node tools/e2e-delivery.mjs`: real GM and temporary player clients; held storage and player rendering, timeout, Retry, Continue, late receipt, zero-success setup retention, disconnected membership, offline invitation rejection and socketlib initiator identity. The harness restores instrumentation and removes only its own prompts/users.
- `node tools/e2e-smoke.mjs`: existing UI/layout, draw, snapshot, staged submission, save, placement and finish regression.

The original nonblocking regression was reproduced with unresolved OPEN at the real `createAndSendPrompt` seam. The UI regression was reproduced with stalled Journal creation: no Sending render before storage and duplicate creation possible. These are local reproductions, not evidence of the cause of the reported Forge delay.

## Timing evidence

The `drawing-prompts.deliveryTiming` hook reports elapsed milliseconds for `storage-create`, `storage-save`, `framing`, total `preparation`, synchronous `dispatch`, receipt wait, and OPEN round trip (`client-open`). Player-side `client-render` measures window opening on the player's clock. Durations are distinct measurements; do not sum the overlapping preparation and round-trip totals.

The delivery e2e prints measurements. Its deliberate storage and rendering holds are fault injection, not performance benchmarks. No Forge session was available for measurement.

## Human sign-off still required

1. In Foundry, inspect Sending, successful receipt feedback, named failure warning and Retry/Continue at your usual manager size. Confirm the setup-retention wording and behavior feel right.
2. Cancel then Resend a received drawing without refreshing the player. Confirm it reopens; submit, then verify stale delivery does not disturb the submitted state.
3. On Forge, compare the timing stages for a normal prompt and a representative framed background, including a slow/unavailable player. Record which stage actually accounts for the reported delay.
4. Review the PR before integrating this delivery foundation into `dev`. Unit/e2e evidence does not itself authorize Linear Done transitions.

Recovery implementation remains gated by SCR-65's separate user architecture discussion. Live previews are reduced-quality images, not durable full-quality checkpoints.
