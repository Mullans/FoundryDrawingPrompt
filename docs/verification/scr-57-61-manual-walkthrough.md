# Delivery and reliability manual walkthrough

## Local setup

- Open **http://localhost:30000/join**. World: **test-world**, Foundry **14.364**.
- Local branch: `codex/scr-57-61-manual-walkthrough`, combining PR #6 (`bd00597`) and PR #7 (`e78102e`). Neither PR is merged into `dev` by this setup.
- Use separate browser profiles: **Gamemaster** in one, **Player2** in another. These test accounts use blank join passwords. Two tabs in the same profile share a login and are insufficient.
- For partial delivery, use a third independent profile as **Player3**. The basic walkthrough works with Player2 alone.
- Refresh any already-open Foundry pages. Enable Drawing Prompts and socketlib; Drawing Prompts settings should have Live GM preview and Auto-open player window enabled.
- Open Drawing Prompts from Token controls' palette button. If needed, the GM console shortcut is `game.modules.get("drawing-prompts").api.openPromptManager()`.

Allow approximately 20–30 minutes. Tick observations, not assumptions. Each failure report should name the section, action, expected/actual result and affected client; include a screenshot and console error if present.

Prepared on 2026-09-07: combined unit suite and UI smoke passed; the join page returns HTTP 200. Drawing Prompts and socketlib are enabled, live preview and auto-open are on, and **Goblin Village** is the ready scene. Automated test prompts/users and the final smoke Tile have been cleaned up. The server is deliberately left running for this walkthrough.

## 1. Send and ordinary lifecycle — SCR-58

- [ ] As GM, create a prompt named `Walkthrough A`, with text, dimensions **640 × 360**, timer **0**, and only the online Player2 selected.
- [ ] Set a background using `icons/svg/mystery-man.svg` (a bundled image) or your own image. Fit canvas should leave visible framing space with this aspect ratio.
- [ ] Click Send. Sending feedback appears promptly and a second Send cannot create another prompt. On localhost this state may be brief.
- [ ] Player2 receives a window automatically. GM sees successful receipt without any player acceptance click.
- [ ] Draw a recognizable mark. GM preview updates for the correct player.
- [ ] GM Cancel, then Resend: the same player window reopens without refreshing the player page.
- [ ] Leave this prompt open for the next section. A brief player disconnect/reconnect must not remove its established recipient membership. **Do not refresh a player page containing valuable unsent marks**: full drawing recovery is not part of these changes.

## 2. Two drawing windows and focus — SCR-60

- [ ] Keep A open on the player. In the GM console, run the following to put the existing manager back into compose mode without ending A; change the name/text to `Walkthrough B` and send to Player2 again:

```js
{
  const { DrawingPromptManager } = await import("/modules/drawing-prompts/scripts/apps/drawing-prompt-manager.mjs");
  const manager = await DrawingPromptManager.open();
  manager.activePrompt = null;
  manager.selectedAssignmentId = null;
  await manager.render({ force: true });
}
```

- [ ] Player2 now has two drawing windows. Click A's canvas, press **E**, then **B**: only A changes tools. Repeat on B.
- [ ] In each window select **L** and click two points to start a line draft. Focus A and press **Enter**: only A commits. Focus B and press **Escape**: only B cancels.
- [ ] Type tool letters into an input field and use keys outside the drawing windows: no background drawing window changes tools or commits a draft.
- [ ] Hold **Space** over a focused drawing and drag: it pans. Release Space: ordinary drawing resumes.
- [ ] Hold Space, click outside the drawing, then return while still holding Space. Drag: it draws normally rather than retaining a stuck pan state. Release Space afterward.

## 3. Live framing — SCR-59

- [ ] Select Player2 in the GM manager and switch to **Full Framing**. Add several visibly different marks in the player window. Each change appears in the proper framed location.
- [ ] Switch between Prompt Canvas and Full Framing while drawing. The latest marks remain visible; the preview should not become permanently stale or blank.
- [ ] Inspect this at your usual window size and with a representative background. Report clipping, unexpected scaling or unreadable feedback.

The exact oversized-payload boundary is already covered by the automated rendered-pixel test. Ordinary manual drawing may not exceed that budget; this visual spot-check alone does not prove the size-limit case.

## 4. Submit, save and placement — SCR-57

- [ ] Submit a drawing, then GM Save it. Confirm the saved preview matches the drawing.
- [ ] Open Place, choose Tile, then cancel with **Escape before clicking the board**. Manager returns and no Tile appears.
- [ ] Repeat Place and switch from Tile controls to Token controls before clicking. Manager returns; a later ordinary board click must not create a stray Tile.
- [ ] Place a Tile on an **empty part of the board**. Manager hides while placing, then returns. Exactly one Tile appears.
- [ ] Repeat using **New Actor / Token**, giving it a recognizable walkthrough name. Exactly one Token and its Actor remain usable afterward.
- [ ] If practical, switch layers just after the placement click. A committed creation should finish and return the manager rather than leaving an untracked object. Do not require yourself to hit a millisecond race: both orderings and failure cleanup were already tested with deterministic gates.

## 5. Timeout, Retry, Continue and GM reload — SCR-58

This optional deterministic simulation affects only the current GM browser page. It holds delivery to Player2 while leaving that player online. Install it in the **GM browser console**, not the player console. Use only new walkthrough prompts; reuse section 2's compose snippet before each new prompt when the manager is showing an existing one.

```js
globalThis.dpWalkthroughDelivery?.restore();
{
  const { emit } = await import("/modules/drawing-prompts/scripts/socket.mjs");
  const original = emit.openDrawingPrompt;
  const player = game.users.find(u => u.name === "Player2" && !u.isGM);
  if (!player?.active) throw new Error("Join Player2 first");
  globalThis.dpWalkthroughDelivery = {
    restore() {
      emit.openDrawingPrompt = original;
      delete globalThis.dpWalkthroughDelivery;
    }
  };
  emit.openDrawingPrompt = function (userId, ...args) {
    if (userId === player.id) return new Promise(() => {});
    return original.call(this, userId, ...args);
  };
}
```

- [ ] With the hold installed, send a new prompt to Player2. After approximately **10 seconds**, Sending gives way to a named failure with **Retry / Continue**. The manager remains usable.
- [ ] Restore delivery using `globalThis.dpWalkthroughDelivery?.restore()`, then click Retry. Player2 receives the original invitation; no second prompt is created.
- [ ] Install the hold again; send another new prompt to Player2 only. After failure, click Continue. Setup text, dimensions and other configuration remain available for another Send; the empty attempt is discarded. Restore delivery afterward.
- [ ] Optional partial case: install the hold, send to Player2 and another online player. One succeeds and Player2 fails. Continue keeps the successful recipient and withdraws Player2; bulk Resend must not revive that withdrawn invitation. Restore delivery afterward.
- [ ] Reload case: install the hold, send a fresh prompt, and refresh **the GM page while Sending is visible**, before the timeout. Reopen the manager. Interrupted delivery offers Retry/Continue rather than remaining stuck on Sending. Reload automatically clears the hold. Retry succeeds.
- [ ] For a partial reload, repeat with another online recipient: the already successful recipient remains confirmed after GM refresh.

Always finish with `globalThis.dpWalkthroughDelivery?.restore()` or refresh the GM page. This test does not simulate or promise restoration of unsent player artwork.

## 6. Intentional Fit Width — SCR-61

- [ ] In Drawing Prompts module settings, deliberately choose **Fit Width** as the default and save.
- [ ] Refresh the GM page. The setting remains Fit Width.
- [ ] Optional first-migration check: in the GM console run `await game.settings.set("drawing-prompts", "legacyFitModeMigrated", false)`, then refresh. Your explicitly selected Fit Width must survive. The migration marks itself complete again.
- [ ] Restore your preferred default afterward. The inherited-default and idempotence cases are also covered by the actual WorldSettings harness.

## Finish and record sign-off

- [ ] Finish the walkthrough prompts and remove only the Tiles/Tokens/Actors you created.
- [ ] Record Pass/Fail/Not tested for sections 1–6. Keep local results distinct from Forge results; Forge timing remains unverified here.
- [ ] Review PR #6 and PR #7 before integration. This checklist does not mark Linear issues Done.
- [ ] Separately review `scr-65-recovery-discussion.md`: choose recovery durability, acceptable checkpoint age, editable-history expectations and preview-only fallback before recovery/shared-drawing implementation.

Shapes, shared drawing, spectators and beautiful-corpse composition are not included in this build.
