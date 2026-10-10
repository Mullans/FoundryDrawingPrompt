# Orphaned-file cleanup acceptance

## Automated evidence

The Node suite covers durable intents and partial upload failures, isolated attempt filenames, protected exports and document references, authenticated account routing, exact nonrecursive Forge requests, provider failures, additive discovery, writer changes, stale results, and Save/deletion concurrency.

The local Foundry 14 retained-capture harness creates disposable player files, overlaps Close with Submit, deletes the Prompt on an unsupported provider, reloads the GM, opens the fallback window, removes only its exact fixture files through the test operator, and verifies Refresh removes the records. Run `node tools/e2e-retained-capture.mjs` with the development server running. Physical fixture removal is development tooling; the module itself has no local browser deletion API.

The native lifecycle passed on Foundry 14.364 at 2026-10-10 04:43 UTC. The earlier 120-second harness deadline was too short for its complete upload, deletion, reload, reconciliation, and cleanup sequence; the bounded harness now allows four minutes and reports the active step on timeout.

## Forge acceptance still required

First-party API evidence is in [Forge asset cleanup research](../research/forge-asset-cleanup.md). Mocked Forge tests and local Foundry runs do not establish live Forge credential scopes.

Use a disposable Prompt and module-created files in a Forge test world:

1. Submit from both a GM-owned and a player-owned library. Save two artwork versions and place artwork in a Scene, including a transform with an original texture retained for Revert.
2. Close and delete the Prompt. Verify each internal file is removed through its owning authenticated client, while saved versions, placed artwork, and Revert textures remain available.
3. Repeat with the owning player offline, then reconnect. Verify an unavailable fallback record persists and cleanup resumes when that owner is available.
4. Exercise denied access and failed verification. Verify Prompt deletion succeeds, the exact file remains listed with its current status, and Retry Cleanup uses existing credentials without asking for a key.
5. Manually remove a fallback file in its owning Assets Library. Verify Refresh removes only the entry whose absence is confirmed; wrong-account or permission errors retain entries.

Do not use production artwork for these checks. No live Forge acceptance has been recorded yet.
