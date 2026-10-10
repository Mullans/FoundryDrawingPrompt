# Forge asset cleanup feasibility

Research date: 2026-10-09. No authenticated deletion requests were made and no assets were changed.

## Decision

Automatic cleanup is technically feasible through Forge's asset API. Pursue that path first; use the orphaned-file list only when a file cannot be deleted because the capability, credentials, permissions, or service are unavailable. Do not describe file deletion as impossible on Forge merely because Foundry FilePicker has no delete method.

The evidence is a current first-party deletion implementation, documented permission semantics, and Forge's explicit statement that its REST API is intended for external use. This is sufficient documentation to design a Forge adapter. It does not establish a versioned compatibility guarantee or prove that every automatic in-game credential can delete assets.

## Evidence

| Question | Finding | Primary source |
| --- | --- | --- |
| Does core Foundry expose file deletion? | The v14 FilePicker reference has no file-delete method. This establishes a core API limitation, not a Forge limitation. | [Foundry v14 FilePicker](https://foundryvtt.com/api/v14/classes/foundry.applications.apps.FilePicker.html) |
| Does Forge have an asset-delete API? | Its official announcement explicitly introduced API deletion. The current website implementation still calls `assets/delete`. | [Forge announcement](https://forums.forge-vtt.com/t/server-update-changelog/3635/28), [current website source](https://forge-vtt.com/dist/forgevtt.js?v=26.09.25) |
| Is external API use intended? | Forge's founder states that the REST API is intended for external access and that requests are not restricted to the Forge origin by CORS. | [January 2025 developer explanation](https://forums.forge-vtt.com/t/how-to-share-access-to-your-assets-library/1403/5) |
| Which permission permits deletion? | Read-only shared folders cannot be deleted from; write access permits deletion. The current website distinguishes `read-assets` and `write-assets`. | [Forge sharing documentation](https://forums.forge-vtt.com/t/how-to-share-access-to-your-assets-library/1403), [current website source](https://forge-vtt.com/dist/forgevtt.js?v=26.09.25) |
| Can the integration send the request? | `ForgeAPI.call(endpoint, body, options)` supports JSON, defaults to POST with a body, and sends an Access-Key. It supports an explicit key or the integration's configured/automatic credentials. | [Immutable ForgeAPI source](https://github.com/ForgeVTT/fvtt-module-forge-vtt/blob/b5e643ab6b9c73912ee852c92c29d01e37058846/src/ForgeAPI.mjs) |
| Is a shared/account-specific credential relevant? | Forge's website deletion method passes the selected library's API key. Its FilePicker adapter preserves the account in an absolute asset URL when browsing. | [Website source](https://forge-vtt.com/dist/forgevtt.js?v=26.09.25), [immutable FilePicker adapter](https://github.com/ForgeVTT/fvtt-module-forge-vtt/blob/b5e643ab6b9c73912ee852c92c29d01e37058846/src/utils/ForgeVTTFilePickerCore.mjs) |

## Current request contract

Forge's website implements single-file deletion as:

```js
Utils.api("assets/delete", {
  path: relativeAssetPath,
  recursive: false
}, {
  apiKey: selectedLibraryKey
});
```

The website request helper sends a POST to `/api/assets/delete`; the payload is JSON. The website treats a truthy `response.success` as successful and otherwise displays `response.error`. The Foundry integration's generic request helper can express the same request shape; this is an implementation inference from the two first-party clients, not a tested hosted-module call.

Use one exact file path with `recursive: false`. The website's folder and multi-file deletion methods use `recursive: true`; they are not appropriate defaults for selective internal-file cleanup.

The current public website bundle has UTF-8 SHA-256 `3ea2440546ec95feb4117a56c756a4d3b064090ac1fc178c7c706f30aceb2f54`. Its public [source map](https://forge-vtt.com/dist/forgevtt.js.map) contains the original `client/assets.js` implementation. Bundle/source-map behavior is current first-party evidence, not a promise that a private website class should be imported by this module. The adapter should use the Forge integration's exposed request helper.

## Authentication and account boundary

- A Foundry GM role does not itself grant access to every player's Forge Assets Library. Player-side staging uploads and GM-side pending uploads can belong to different accounts.
- Preserve the uploaded URL's account identity. Never strip the account prefix and send the remaining path against whichever account happens to be logged in.
- An explicitly authorized, correctly scoped write key provides a documented permission route. Existing configured integration credentials may also suffice; do not require a new key without checking the actual capability.
- Current `ForgeAPI.getAPIKey()` uses the configured valid client key or falls back to the automatic `ForgeVTT-AccessKey` cookie. The public client does not prove the server accepts every automatic cookie-key scope for asset deletion.
- Forge's [custom API guidance](https://forums.forge-vtt.com/t/how-to-control-your-games-using-custom-api-requests-and-reset-your-worlds-periodically/5982) discusses Foundry-origin restrictions and explicit API keys in the context of world deletion. Do not extrapolate that passage into a proven ban on asset deletion.
- Do not persist credentials in the world file registry, send them in ordinary assignment payloads, or include them in logs. Keep credential handling at the provider/client boundary.

## Implementation consequences

The approved implementation uses only credentials already supplied by the Forge integration. It adds no API-key configuration or fallback; denied access remains in the orphaned-file list. References to explicit keys above describe the evidence, not a proposed module feature.

1. Replace the current assumption that `FilePicker.delete` is the available deletion interface with a Forge-specific cleanup adapter using the verified request shape.
2. Attempt automatic deletion only for exact, attributable internal files that have no protected live/export/scene references and whose library identity matches the available credential context.
3. Persist cleanup candidates before deleting the Prompt so a denied, interrupted, or partially successful cleanup never loses file references. Successful deletions disappear from tracking; unsuccessful or unsupported files remain in the fallback list. Prompt deletion remains allowed after durable registration.
4. Keep the accepted additive startup backfill for retained Prompts. It should recover attributable records even if a registry already exists, without crawling unrelated historical assets.
5. Preserve exported artwork and scene content. Do not recursively delete directories.
6. Verify the hosted integration with a disposable module-created file during implementation: account routing, response success/error handling, post-delete authoritative listing, denied/read-only access, and network failure. Default in-game credentials require this runtime check; the documentation already establishes the explicit write-authorized API route.
7. Use the fallback list for denied access, unavailable credentials/provider, unsupported non-Forge hosting, or failed requests. Distinguish "unable to delete" from "confirmed deleted"; do not treat request completion alone as success.

## Boundaries of this result

Established: Forge has a current single-file deletion API, external API access is intended, and write permissions permit deletion. Consequently, automatic cleanup should be the preferred implementation.

Unverified: successful execution from this module in a live Forge world, automatic credential scopes for deletion, server-side response/idempotency details beyond the website's handling, and cross-account deletion without a matching write-enabled credential. These are implementation acceptance checks, not evidence that automatic cleanup is unavailable.

This research supersedes the earlier plan's categorical prohibition on physical deletion. No product code, release version, or PR merge was changed by this investigation.
