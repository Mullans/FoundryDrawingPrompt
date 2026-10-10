# Orphaned-file cleanup acceptance

## Automated evidence

The Node suite covers durable intents and partial upload failures, isolated attempt filenames, protected exports and document references, authenticated account routing, exact nonrecursive Forge requests, provider failures, additive discovery, writer changes, stale results, and Save/deletion concurrency.

The local Foundry 14 retained-capture harness creates disposable player files, overlaps Close with Submit, deletes the Prompt on an unsupported provider, reloads the GM, opens the fallback window, removes only its exact fixture files through the test operator, and verifies Refresh removes the records. Run `node tools/e2e-retained-capture.mjs` with the development server running. Physical fixture removal is development tooling; the module itself has no local browser deletion API.

The native lifecycle passed on Foundry 14.364 at 2026-10-10 04:43 UTC. The earlier 120-second harness deadline was too short for its complete upload, deletion, reload, reconciliation, and cleanup sequence; the bounded harness now allows four minutes and reports the active step on timeout.

Final integration evidence after bot remediation: 605 Node tests passed (`20261010-144007-40348-node.log`); the full drawing/manager smoke passed (`20261010-142517-63724-node.log`), and deletion/reload/manual Refresh passed (`20261010-142859-55812-node.log`). Logs live under the development-only `.artifacts/test-logs/` folder.

## Final paired review

The single Standards/Spec pair compared the implementation with starting commit `ba5236b`.

| Axis | Verified finding | Resolution |
| --- | --- | --- |
| Standards | A stale session snapshot could remove a newly acquired Save lease. | Preserve leases absent from the starting snapshot; add the paused-RPC regression. |
| Standards | Persisted English failure diagnostics appeared directly in the UI. | Render localized status/operation reasons; keep diagnostics in the registry. |
| Spec | A disconnected client could still have an upload or Save in flight. | Preserve uncertain intents and leases across disconnects and replacement sessions; test late completion. |
| Spec | Failed capture adoption left completed uploads protected indefinitely. | Settle completed paths in `finally`, preserving any successfully persisted references; test failed Journal persistence. |

Both axes' findings were fixed and validated locally without another broad review pair. A small shared helper for repeated exported-path selection remains a deferred optimization. The cohesive cleanup service does not need splitting solely because of its length.

## PR bot review remediation

Codex and Greptile reviewed pushed commit `0df733b`. Three findings were verified:

| Reviewer | Finding | Resolution |
| --- | --- | --- |
| Codex | A player could grow unresolved upload reservations indefinitely or report an unverifiable session. | Validate session identity through the authenticated client and bound outstanding reservations per Assignment and player, including older sessions. Preserve exact replay at the limit. |
| Greptile | Cleanup persistence latency could mark an on-time submission late. | Capture receipt time at handler entry and retain it for submission time, receipt time, and overtime. Test arrivals immediately before and after the deadline while tracking writes advance the clock. |
| Greptile | Failed folder discovery remained hidden after Prompt deletion. | Display unfinished folder checks separately from known files; Refresh retries discovery without deleting assets. |

Codex's follow-up on `817485f` identified three further edge cases: shared overlay/merged attempt tracking on partial registration failure, release failure masking an already committed Save/Submission, and incorrect owner attribution when the configured base contains a `pending` segment. Targeted regressions cover preserving the other in-flight image, returning the committed result while leaving a durable lease for reconciliation, and using exact validated staging/pending roots for discovery ownership.

## Forge acceptance still required

First-party API evidence is in [Forge asset cleanup research](../research/forge-asset-cleanup.md). Mocked Forge tests and local Foundry runs do not establish live Forge credential scopes.

Use a disposable Prompt and module-created files in a Forge test world:

1. Submit from both a GM-owned and a player-owned library. Save two artwork versions and place artwork in a Scene, including a transform with an original texture retained for Revert.
2. Close and delete the Prompt. Verify each internal file is removed through its owning authenticated client, while saved versions, placed artwork, and Revert textures remain available.
3. Repeat with the owning player offline, then reconnect. Verify an unavailable fallback record persists and cleanup resumes when that owner is available.
4. Exercise denied access and failed verification. Verify Prompt deletion succeeds, the exact file remains listed with its current status, and Retry Cleanup uses existing credentials without asking for a key.
5. Manually remove a fallback file in its owning Assets Library. Verify Refresh removes only the entry whose absence is confirmed; wrong-account or permission errors retain entries.

Do not use production artwork for these checks. No live Forge acceptance has been recorded yet.
