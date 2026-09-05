# Socket trust boundary: remote input is untrusted, validation fails closed

Everything arriving over a socket is untrusted input. **Sender identity comes from `socketdata`** (`getSocketInitiatorId(this)`), never from an argument in the payload — a caller-supplied `userId` is a claim, not an identity. GM-side lifecycle handlers (`assignmentOpened`, `drawingSnapshot`, `drawingSubmitted`, `drawingRejected`, `playerWindowClosed`) therefore authorize against the initiator, mirroring the player-side `assertPromptGmMatchesInitiator` check. The wire `userId` is still passed in and compared to the initiator as defense in depth: a disagreement means the payload is forged or malformed, which is worth rejecting distinctly from a caller who targeted an assignment that is not theirs.

Corollary: **validation contexts fail closed.** Missing, null, or unresolvable inputs — an absent initiator, an unknown assignment, a staged path that cannot be resolved — are rejections, not permissive defaults. A failed authorization is logged via `console.debug` and dropped, never allowed to escape as an unhandled rejection.

The two socket directions are asymmetric and must stay so. `PLAYER_GM_INITIATED_CALLS` in `scripts/socket.mjs` is the **GM→player** list (`executeAsUser`), wrapped with an assert that the initiator is a GM. The five lifecycle calls above are **player→GM** (`executeForUsers([gmUserId], …)`) and are authorized per-handler instead.

Alternative rejected: trust the wire `userId` because socketlib routed the call — routing proves delivery, not origin. Any client can emit any registered call with any arguments; only `socketdata` is set by the transport.

Alternative rejected: add the player→GM calls to `PLAYER_GM_INITIATED_CALLS` so one wrapper covers everything. That set asserts a GM initiator, so it would make the owning GM reject every genuine player submission, snapshot, and open notification. The trust rule is per-direction, not global.

Alternative rejected: authorize on the initiator alone and drop the wire `userId` parameter. Keeping both preserves a cheap forged-payload signal and lets the two failure modes be distinguished in logs.

Alternative rejected: localize the socket-auth errors. `scripts/prompts/socket-auth.mjs` is pure and import-free so it is unit-testable without Foundry globals; it throws localization keys, and callers that surface a message localize at the edge.

Source: SCR-53 (High, authorization) plus the sibling staged-path fail-closed fix; supersedes the ad-hoc `gm-socket-sender-spoofing.md` finding note, now folded in here.
