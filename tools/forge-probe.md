# Forge upload-path probe

These probes confirm the assumptions that Forge returns an HTTPS Assets Library URL with one account prefix, and that the provider roots below it are world-specific.

Player browser console:

```js
(async () => { const { stagingDir } = await import("/modules/drawing-prompts/scripts/prompts/asset-service.mjs"); const blob = await new Promise(resolve => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2; canvas.getContext("2d").fillRect(0, 0, 1, 1); canvas.toBlob(resolve, "image/png"); }); const file = new File([blob], "forge-probe-overlay.png", { type: "image/png" }); const result = await (FilePicker.implementation ?? FilePicker).upload("data", stagingDir(), file, {}, { notify: false }); console.log("exact Forge upload result/path", result, result?.path); })();
```

GM browser console:

```js
(async () => { const { createPathProvider } = await import("/modules/drawing-prompts/scripts/foundry/path-provider.mjs"); const forge = Boolean(globalThis.ForgeVTT?.usingTheForge); const worldId = game.world.id; const provider = createPathProvider({ forge, worldId, settingValue: game.settings.get("drawing-prompts", "assetFolder") }); console.log({ usingTheForge: globalThis.ForgeVTT?.usingTheForge, worldId, base: provider.base, staging: provider.staging(), pending: provider.pending("PROBE-ASSIGNMENT"), prompt: provider.promptAssets("PROBE-PROMPT") }); })();
```
