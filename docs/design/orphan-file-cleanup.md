# Automatic cleanup of orphaned internal files

Approved 2026-10-09; replaces the manual-only cleanup proposal. API evidence is recorded in [Forge asset cleanup research](../research/forge-asset-cleanup.md).

## Product policy

- Delete attributable internal staging, pending-submission, and retained-capture files automatically once no live Prompt, Submission, capture, upload, or Save needs them.
- Preserve all intentionally saved artwork, including superseded saved versions. Preserve scene backgrounds/foregrounds, Tiles, Token and Actor artwork, prototype Tokens, and original textures retained for Revert.
- Use the Forge integration's existing authentication. No new API-key settings, setup, storage, fallback, or credential transfer.
- Delete one exact file at a time through Forge's `assets/delete` endpoint with `recursive: false`. Never delete directories recursively or sweep unrelated historical assets.
- Respect the owning Forge account. GM authority in Foundry does not supply write access to another Forge library. Route cleanup to the original file-owning player when their authenticated client is available.
- Preserve local Recovery copies until the existing lifecycle decides they can be cleared; server-file cleanup does not own browser drawing history.

## Durable boundary

Internal uploads reserve a registry record before creating a file, use unique attempt names, and record each provider-returned path independently. A completed upload remains protected until the adopting Submission/capture is persisted or the attempt definitively fails. Save obtains a durable usage lease before reading internal files. Registry mutations are serialized through the active GM and remote actions authenticate the transport initiator.

Prompt Delete requires its usual confirmation and close-first rule. Persist all attributable cleanup candidates before deleting the Prompt. Registry failure preserves the Prompt; journal deletion failure preserves its file references. Physical deletion runs after Prompt deletion and never blocks it once outstanding cleanup is durably recorded.

Every GM startup runs additive recovery against retained Prompts, even when registry records exist. Preserve original folders/accounts and existing fallback records. Scan only attributable directories and filenames, with at most two provider requests in flight. Unknown or unattributed historical files remain outside cleanup.

## Fallback list

The Prompt Library has a small GM-only Orphaned files button and unresolved-entry count. Its singleton world-shared window retains files that cannot be deleted, whose deletion fails, or whose deletion cannot be confirmed. Show original Prompt/player, filename, exact folder/account/path, orphaned date, and current reason/status. Include Copy Path/URL, Assets Library link, Refresh, and Retry Cleanup.

Opening the window and Refresh verify existence without requesting deletion. Retry Cleanup requests deletion explicitly. Automatic attempts also run when candidates first become eligible, at startup, and when a relevant owner reconnects; no continuous polling or rapid retry loops.

Only authoritative absence removes records. Wrong-account, permission, network, and malformed-listing results retain them as unable to verify. Successful deletion without reliable verification remains deletion unconfirmed. Unresolved entries never expire merely with age.

## Implementation and acceptance manifest

- Repository: `modules/drawing-prompts`, branch `codex/outstanding-review-fixes`, starting HEAD `ba5236bd5b4f81f998e8faf57d351f817fe78d3b`; existing PR #14 targets dev. Preserve user-owned `.gitignore`, `AGENTS.md`, `.ignore`.
- Wave 1: cleanup service/provider and registry protocol; Wave 2: upload/lifecycle/startup integration and fallback UI. At most two concurrent implementation agents. Root owns integration and Git operations.
- Tests: intent registration/partial failures, settlement, unique names, Save/reference races, exports/scene protection, durable-delete failures, active-GM failover, authenticated directions, account mismatches/offline owners, exact nonrecursive requests, unknown responses, startup recovery, and stale refreshes.
- Run focused tests, full Node suite, fresh local Foundry 14 smoke and cleanup lifecycle. Verify Forge separately with disposable module-created files; document unverified credential scopes honestly.
- One final Standards/Spec review pair, then targeted remediation. Update PR #14 and await both bots on the final head. Do not merge PR #14 or #10, bump versions, or tag releases.
