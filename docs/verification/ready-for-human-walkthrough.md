# Ready-for-human walkthrough — `feature/scr-6-close-and-followups`

Manual sign-off sheet for the seven `ready-for-human` tickets on this branch: **SCR-37, SCR-21, SCR-44, SCR-45, SCR-48, SCR-20, SCR-25**. This is the last gate before the branch merges.

**This document does not close anything.** Ticking a box here records an observation. Moving a Linear ticket to Done, or leaving it open with a comment, stays a human decision made after the run.

Every checkbox is an acceptance item lifted from the ticket (or from a comment that amended it). Where automation already covers an item, the section says so and asks only for a spot-check — do not re-derive coverage that `node --test tests/` and `node tools/e2e-smoke.mjs` already prove.

## Run order

Sections are ordered so one Foundry session covers all of them. Sections 1–6 share **Prompt A** (built once in *Session setup*). Section 7 has no click path at all.

| # | Ticket | Needs |
|---|--------|-------|
| 1 | SCR-48 timer block layout | Prompt A, timer set |
| 2 | SCR-20 tool shortcuts | Player A window |
| 3 | SCR-44 polyline line tool | Player A window |
| 4 | SCR-45 recent colours | **two** player windows + a GM preview window |
| 5 | SCR-37 Full Framing union | source-image background with pad; a player drawing live |
| 6 | SCR-21 hide manager during Place | a saved submission |
| 7 | SCR-25 architecture housekeeping | nothing — see section |

---

## Before you start

### Start the session

Follow the hub [verification lifecycle](https://github.com/Mullans/FoundryHub/blob/dev/standards/verification.md) to link modules, start Foundry, poll readiness, and stop the server after the run. Use the configured test world and port (defaults: **`test-world`**, **30000**).

1. Open **two browser profiles** (separate profiles, not two tabs — Foundry binds one user per session):
   * Profile 1 → join as the **GM**.
   * Profile 2 → join as **Player A**.
2. Section 4 additionally needs a **third client**: either Player A opening a second assignment window in the same session, or a **Player B** in a third profile. Player B is the cleaner test and also serves section "Two players, ordinary lifecycle" below — prefer it.
3. Confirm module settings before building Prompt A (Configure Settings → Module Settings → Drawing Prompts):
   * **Live GM preview** — on (sections 4 and 5 depend on live snapshots).
   * **Auto-open player window** — on (saves a click per assignment).
4. Have a **source image** ready in the world's data — ideally a character portrait that is clearly *not* square, so letterbox pad is unambiguous. Sections 5 and 6 need it; sections 1–4 do not.

For symptoms that **move between attempts**, apply the hub verification lifecycle's [wedged-server rule](https://github.com/Mullans/FoundryHub/blob/dev/standards/verification.md#wedged-server-rule).

### Two regressions that ride along — read once, do not repeat per section

**SCR-52, staged submission path fail-closed.** The staged-path allowlist now rejects instead of waving a submission through when its context cannot be resolved. **Every Submit in this document implicitly regression-checks it.** You do not need a dedicated step. What a false positive looks like: the GM gets the notification *"The submitted drawing payload was invalid and was ignored."* and the player's drawing never appears in the manager, even though the player saw a normal submit. If that appears at any point in this run, stop and report it against SCR-52 — it means the gate became over-strict, not that the drawing was bad. Note that the staged path is only exercised for players who hold the core **Upload New Files** permission; a player without it shows a *"No file upload"* flag in the manager's player list and travels a different (socket) path.

**SCR-53, socket sender identity.** All five GM-side socket handlers (assignment opened, live snapshot, submitted, rejected, player window closed) now authorise against the socketlib sender rather than a payload field. An over-strict check would silently break real players — the handlers `return` quietly on rejection, so the failure is *nothing happening*, not an error dialog. One explicit check, with **two** connected players:

- [ ] With Player A and Player B both holding an assignment: Player A opens their window → the GM's manager row for A shows **Window open**.
- [ ] Player A draws → GM's preview plate updates live for A.
- [ ] Player A clicks **Submit** → A's row flips to **Submitted** and the plate holds A's drawing.
- [ ] Player B clicks **Reject** → B's row flips to **Rejected**.
- [ ] Player A clicks **Close** → the **Window open** flag clears on A's row.
- [ ] Neither player's action ever lands on the *other* player's row.

**What failure looks like:** any of the above producing no visible change on the GM side while the player client looks normal. Open the GM console and look for `drawing-prompts | ignored …` debug lines — that is the new authorisation path rejecting a legitimate message. A single one of those against a genuine player action is a blocking SCR-53 regression.

### Session setup — build Prompt A

GM client:

1. Open the left scene-control toolbar → **Token controls** → the palette button, **Drawing Prompts**. The Drawing Prompt Manager opens in compose mode.
2. **Prompt text**: something long enough to truncate in the summary bar (a full sentence, 80+ characters) — section 1 needs the expand chevron.
3. **Drawing name**: `Prompt A`.
4. **Timer seconds**: `180`.
5. **Dimensions**: set **Width** and **Height** to an aspect that clearly differs from your source image — e.g. `512` × `768` with a landscape source, or `768` × `512` with a portrait source. This is what produces the letterbox/pillarbox pad section 5 depends on.
6. **Background → Source**: click **Browse** and pick your source image (or **Token** / **Scene** if that is easier). The hint line under the buttons should name it.
7. **Fit mode**: **Fit canvas**. The Prompt Framing panel on the right now shows the source inside the plate with empty bands on two sides — that empty band is the pad.
8. In **Prompt Framing**, use **Zoom out** once or twice so there is a visible empty band *above* the subject's head. This is the "room for a large hat" case. Do not pan the subject out of frame.
9. **Players**: tick Player A and Player B.
10. Click **Send**.

The manager switches to review mode. Leave it open.

---

## 1 · SCR-48 — live manager timer block layout

**Ticket:** regression, timer readout and transport controls drifted onto separate rows. Hard spec is ADR-0003 and `docs/design/gm-live-manager-summary.md`.

**Preconditions:** Prompt A sent (timer `180`), manager in review mode, GM client only. No source background needed.

**Already covered by automation:** `tools/e2e-layout-geometry.mjs` asserts the timer block does not *overflow* the summary bar, and that assertion runs in the e2e. It does not check the arrangement inside the block. Spot-check the geometry; read the arrangement carefully.

**Steps**

1. Look at the summary bar directly under the *Unfinished prompts* dropdown.
2. Read the left side: quoted prompt text, a separator, then the drawing name (`Prompt A`).
3. Read the right side: the timer block.
4. Hover the truncated prompt quote and click its chevron to expand, then collapse it again.
5. Click **−30s**, then **+30s**, then **Pause**, then **Resume**, then **Reset**.

**Expected observable**

- [ ] Timer controls sit on the **same row** as the prompt quote and drawing name — not on a row of their own below the summary.
- [ ] The active countdown readout sits **inside the same block** as Pause / Reset / Stop, not detached from them.
- [ ] Block reads as an upside-down T: the countdown chip **above** the Pause / Reset / Stop row, with **−2m / −30s** as the left wing and **+30s / +2m** as the right wing.
- [ ] No canvas width × height readout anywhere in the summary bar.
- [ ] No background thumbnail in the live summary.
- [ ] Expanding the long prompt quote does not push the timer block onto its own row or out of the summary bar.
- [ ] No canvas width × height readout appears in a preview corner, per [ADR-0003](../adr/0003-gm-live-manager-timer-block.md).

**What failure looks like:** the countdown chip rendering on the summary row while Pause / Reset / Stop wrap to a second row underneath (this is the exact regression the ticket was filed for); the ± adjustment buttons stacking vertically instead of flanking as wings; a `512 × 768` dimensions string reappearing next to the drawing name; the timer block sliding out past the right edge of the summary bar once the prompt quote expands.

---

## 2 · SCR-20 — player drawing tool keyboard shortcuts

**Ticket AC** covers B and E as a minimum. A comment extended the implemented set to **B** Brush, **E** Eraser, **L** Line, **F** Fill, **I** Eyedropper, plus **Enter** commits a polyline draft and **Escape** cancels it. The Enter/Escape half is verified in section 3.

**Preconditions:** Prompt A sent; Player A's drawing window open. One client (Player A).

**Steps**

1. On Player A's client, click once on the drawing canvas so the window has focus.
2. Press **B** — watch the toolbar. Press **E**, then **L**, then **F**, then **I**, then **B** again.
3. Hover any tool button to confirm its label matches what the key selected (Brush, Eraser, Line, Fill, Eyedropper).
4. Now click into a text field and type letters containing b, e, l, f, i. Use the **Brush size** slider's neighbouring controls if no text input is handy — otherwise switch to the GM client, open the manager in compose mode for a second prompt, and type `blue felt line` into **Prompt text** while a player window is open elsewhere.
5. Back on the canvas: draw a short stroke with the pointer, then use the zoom buttons and pan, confirming nothing about pointer drawing changed.

**Expected observable**

- [ ] With the drawing app focused, **B** selects Brush and **E** selects Eraser (the ticket's minimum).
- [ ] **L**, **F**, **I** select Line, Fill, Eyedropper.
- [ ] The pressed tool's toolbar button becomes visibly active; the previously active one clears.
- [ ] Typing letters into a text field, textarea, or select **never** changes the active tool.
- [ ] Pointer drawing, zoom in/out, reset view, and space-drag panning all still behave as before.
- [ ] Every tool button carries a localized label (hover tooltip / accessible name), no raw `DRAWING-PROMPTS.*` keys.

**What failure looks like:** a tool switching while you type a prompt or a drawing name — that is the "shortcuts fire while typing" regression, and it is the one worth hunting for, because the listener is bound to `window` rather than to the app element. Also watch for a modifier combination (Ctrl+B, Alt+E) changing the tool: it must not.

---

## 3 · SCR-44 — polyline line tool

**Ticket product decisions (locked):** click-to-place vertices; double-click **or** Enter commits; Escape cancels; committed as a normal stroke op. A comment adds: polyline strokes commit **straight** (no bezier smoothing) — the first implementation ran them through brush quadratic smoothing and they came out visibly curved.

**Preconditions:** Prompt A sent; Player A's drawing window open. One client.

**Steps**

1. Select the **Line** tool (toolbar button or **L**).
2. Click four times at well-separated points on the canvas to place four vertices — make at least one sharp corner.
3. Between clicks, move the pointer without clicking and watch the segment from the last vertex to the cursor.
4. Press **Enter**.
5. Select **Line** again, place three vertices, and press **Escape**.
6. Select **Line** again, place three vertices, and **double-click** to place the fourth and commit.
7. Press **Undo** once, then **Redo** once.

**Expected observable**

- [ ] The **Line** tool is selectable in the toolbar and shows a localized label.
- [ ] Each click adds a vertex; the accumulated polyline is visible as you go.
- [ ] A rubber-band segment follows the cursor from the last placed vertex while placing.
- [ ] **Enter** commits the polyline as a single stroke.
- [ ] **Double-click** commits, and does **not** leave a doubled vertex at the end point.
- [ ] **Escape** discards the draft with nothing committed — the canvas returns to its pre-draft state.
- [ ] Committed segments are **straight lines with round caps and joins**. Sight down a long segment: it must not bow.
- [ ] Undo removes the whole polyline in one step; Redo restores it in one step.

**What failure looks like:** segments that curve gently between vertices, or that round off a sharp corner — the smoothing regression from the comment; a double-click that both commits *and* resets the canvas view (the viewport also listens for double-click to reset navigation, so a mis-routed event shows up as the drawing snapping to fit); Escape cancelling the draft *and* closing the drawing window; a committed polyline that undoes one segment at a time.

---

## 4 · SCR-45 — recent colour swatches

**Ticket AC:** up to 3 recent **distinct** colours as swatches, click to re-select, history persists across sessions, visual language matching the existing Background swatches. Amended by comments: history records the last 3 colours **actually used to draw**, not palette-drag selections; always show 3 slots, empty ones border-only and non-selectable; a **fourth** swatch to the right of the three is always the Foundry player identity colour.

**Cross-reference — SCR-55.** The multi-window clobber and the GM-preview pollution were fixed on this branch and **no test can reach either**: `#recentColors` is per-instance but persists to a shared client setting, and both bugs need two live windows. Items 4.6 and 4.7 below are the actual bug and are the reason this section needs a human. The single-window pollution-on-reopen path is covered by unit tests — spot-check it (4.5) and move on.

**Preconditions:** Prompt A sent to Player A **and** Player B. For 4.6 you need two assignment windows open at once on **one** client — the cleanest way is a second prompt sent to Player A, so Player A holds two assignments simultaneously. Build it now if you did not already:

> GM: manager → the *Unfinished prompts* dropdown is only present once a second prompt exists. Compose a second prompt (**Prompt B**, blank background, no timer, Player A only) and **Send** it. Player A now has two drawing windows.

**Steps**

1. On Player A's first window, note the three history slots to the right of the **Color** input, plus the fourth player-colour swatch.
2. Set the **Color** input to a strong red. **Do not draw yet.** Look at the swatches.
3. Draw a stroke in red.
4. Change to blue, draw a stroke. Change to green, draw a stroke. Change to red again, draw a stroke.
5. Click the **second** history swatch — watch the **Color** input.
6. Click the fourth (player identity) swatch.
7. Close and reopen the drawing window (footer **Close**, then reopen from the prompt list or GM **Show player UI**). Look at the swatch order.
8. **The multi-window case.** With Player A's *two* assignment windows both open and visible: draw a distinct colour (say orange) in window 1, then a different distinct colour (say purple) in window 2, then another new colour in window 1 again. Watch both swatch rows.
9. **The GM preview case.** On the **GM** client, open the manager in compose mode and click **Show preview** in the footer. Draw several strokes in colours the GM has never used. Close the preview window and check the GM's own recent swatches on a subsequent preview.

**Expected observable**

- [ ] 4.1 — Exactly three history slots are always present. Empty slots are border-only, transparent, and not clickable.
- [ ] 4.2 — A fourth swatch sits to the **right** of the three and is the Foundry player identity colour.
- [ ] 4.3 — Merely changing the **Color** picker records **nothing**. History only advances when a stroke or fill actually lands.
- [ ] 4.4 — After red → blue → green → red, the history reads **red, green, blue** (most recent first, distinct, red moved to front rather than duplicated).
- [ ] 4.5 — Clicking a history swatch sets the brush to that colour and the **Color** input updates to match.
- [ ] 4.6 — Reopening the assignment does **not** reorder history: the restored drawing's last stroke colour must not jump to the front. *(Unit-covered; spot-check only.)*
- [ ] 4.7 — **Two windows open at once:** each window's row shows the shared, merged history. Neither window clobbers the other's colours — the colour drawn in window 2 must still be present after window 1 draws again.
- [ ] 4.8 — **GM preview window:** drawing in a **Show preview** window writes **nothing** to the GM's palette. The GM's history is unchanged after previewing.
- [ ] 4.9 — History survives a full client reload (F5, rejoin, reopen a drawing window).
- [ ] 4.10 — Swatches read as the same visual family as the **Background** swatch row below them.

**What failure looks like:** for 4.7, the specific bug is *last-writer-wins* — window 1 draws orange, window 2 draws purple, then window 1 draws again and purple silently vanishes from both rows because window 1 pushed onto a stale snapshot taken when it opened. If the two rows ever disagree, or a colour drawn in the other window disappears, that is the regression. For 4.8, the failure is the GM's palette filling with colours the GM only ever used while previewing someone else's prompt. For 4.3, the failure is dragging the colour picker across a gradient and watching the history churn through every intermediate colour.

---

## 5 · SCR-37 — Full Framing union composition

**This is the most important section in the document.** Give it real time.

**Ticket AC:** pad-above + hat ink appears on Full Framing save / preview / Place with the body underlay; the Prompt canvas primary stays framed-only; a full-source default framing yields a `_full` at natural source size; blank prompts get no Full Framing and no `_full`.

Two comments amended this: Full Framing is `source ∪ Prompt-canvas AABB mapped into source space`, so **Fit letterbox/pillarbox pad is included** — an earlier build regressed to a source-only bounding box and dropped the hat room. A later comment records the live-switch flash fix.

**Cross-reference — SCR-51 (review plate arbitration).** This is the **least verified change in the whole PR**. It has no unit coverage, and the e2e cannot reach it: the blank-plate regression needs Full Framing, Full Framing needs a source-image background, and the smoke flow never sets one up. **Section 5.3 below is the primary coverage for SCR-51.** Do not skip it, and do not rush it — if it needs three attempts to observe cleanly, take three attempts.

**Preconditions:** Prompt A (source image, Fit canvas, aspect mismatch producing visible pad, framing zoomed out so there is empty sky above the head). Player A's window open and actively drawing. GM manager in review mode with Player A's row selected. Live GM preview enabled.

### 5.1 — Pad ink survives into Full Framing

1. On **Player A**: draw a large hat **in the empty pad above the subject's head** — ink that sits outside the source image but inside the Prompt canvas. Also draw something clearly on the body, inside the source.
2. Player A clicks **Submit**.
3. On the **GM** manager, select Player A's row. The Framing View toggle (**Prompt canvas** | **Full Framing**) is visible above the plate.
4. Click **Full Framing**.
5. Click **Save**, give the drawing a name, confirm.
6. Hover the **Saved** indicator to read the saved path; note the basename.
7. Click **Place**, choose **Tile**, and place it on the scene. Inspect the placed tile.

- [ ] 5.1a — Full Framing preview shows **both** the hat (pad ink, above the source) **and** the body underlay from the source image, in one plate.
- [ ] 5.1b — Switching back to **Prompt canvas** shows the framed-only view: the region sent to the player, primary raster unchanged.
- [ ] 5.1c — Save produces two files: the primary at the Prompt-canvas basename and a second one ending in **`_full`**.
- [ ] 5.1d — The placed Tile under Full Framing carries hat + body, and its dimensions match the composition plate, not the natural source.

**What failure looks like:** the classic regression is Full Framing looking like a *source-only bounding box* — the body is there, the hat is cropped away at the top edge of the source. That is exactly the 2026-08-12 walkthrough regression and means the union lost its pad term. The mirror failure is the Prompt canvas view picking up the body underlay it should not have.

### 5.2 — Degenerate cases

1. Return to compose mode (Finish prompt or the queue) and build a prompt with a source background left at **default framing** — click **Reset framing** so the frame covers the whole source with no pad. Send it, have a player scribble, submit, switch to **Full Framing**, and Save.
2. Build a second prompt with **no background at all** (click **Clear** in the Background row). Send, scribble, submit, and look at the preview panel.

- [ ] 5.2a — Full-source default framing: the `_full` file is at the **natural source size**, not padded or expanded.
- [ ] 5.2b — On a **blank** prompt, the **Framing View** toggle is **absent** entirely (not present-but-disabled).
- [ ] 5.2c — A blank prompt's Save produces **no** `_full` file.

**What failure looks like:** a `_full` a few pixels larger than the source on a crop-only framing (a rounding error in the union); or the Framing View toggle appearing on a blank prompt and producing a broken or duplicate plate when clicked.

### 5.3 — SCR-51: switching Framing View while a player is actively drawing

This is the arbitration case. It needs the player to be *mid-stroke*, not idle, because the bug lives in the window between the toggle changing the plate's target aspect and the remapped preview finishing its decode.

1. Set up as in 5.1: source background, Prompt Framing including pad, GM manager in review mode with Player A's row **selected**, Framing View on **Prompt canvas**.
2. Have **Player A draw continuously** — long, steady strokes, one after another, so live snapshots keep arriving. Do not let them stop.
3. While that is happening, on the GM client click **Full Framing**. Watch the plate closely through the switch.
4. Click back to **Prompt canvas**, still while the player draws. Watch again.
5. Repeat the switch four or five times at different moments in the player's drawing. The flash is timing-dependent; a single clean switch is not evidence.
6. Now select **Player B's** row, then quickly switch Framing View, then quickly select Player A's row again — still with Player A drawing.
7. Resize the manager window while Full Framing is selected and the player is still drawing.

- [ ] 5.3a — The plate **never** flashes the *"No snapshot has been received for this assignment."* empty state during or after a switch, at any of the attempts.
- [ ] 5.3b — The plate **never** shows a **different assignment's** image, even momentarily, when switching views around a row change.
- [ ] 5.3c — The image and the plate's aspect change **together**, in one step. There is no intermediate frame where the previous bitmap is stretched or letterboxed into the new view's aspect.
- [ ] 5.3d — Resizing the manager mid-draw does not re-trigger a flash or leave the plate laid out for the wrong Framing View.
- [ ] 5.3e — Live snapshots keep arriving after the switch: the plate continues updating as the player keeps drawing, in the newly selected view.

**What failure looks like:** the two named symptoms, in order of severity. (a) A blank *"No snapshot…"* plate appearing for a fraction of a second on switch, then the correct image filling in — this is the blank-plate regression and it is a blocker. (b) The plate briefly painting the *other* player's drawing before correcting — this is a cross-assignment leak and is worse than a flash. (c) The subtler one: the plate resizing to the Full Framing aspect while the old Prompt-canvas bitmap is still on screen, so for one frame the drawing appears stretched or shows unexpected empty bands before the correct image lands. Watch for that specifically — it is the symptom the fix was written against, and it is easy to blink past. (d) The plate freezing after a switch — correct image, but it stops tracking the player's ongoing strokes.

If any of these appear, capture which attempt number and what the player was doing at the time; the failure is timing-sensitive and that detail is what makes it reproducible.

---

## 6 · SCR-21 — temporarily hide the manager during Place / Transform

**Ticket AC:** the flow gets the manager out of the way; it restores reliably after place completes **or** cancels; it works for both Tile and Token modes; no loss of draft/review UI state beyond the intentional hide.

**Cross-reference — SCR-50 (placement abort).** SCR-50 partially discharges the "restores reliably" criterion and its abort path is already asserted in the e2e (abandon a placement by switching canvas layer → the placement settles, the manager comes back, no zombie Tile is created, no listener leaks). **Do not re-verify that path by hand.** What automation cannot reach is the human interaction: pressing Escape mid-placement, and closing the manager while a placement is live. Those two are 6.3 and 6.4 and are the point of this section.

**Preconditions:** a **saved** submission — the Place and Transform buttons stay disabled until Save has run (hover them for the *"Save the submission before placing it."* tooltip). Reuse the Prompt A submission saved in 5.1. GM client only; a scene must be in view. For Transform, control at least one token on the scene first.

### 6.1 — Tile place, committed

1. Select the saved row, click **Place**.
2. In the **Place Drawing** dialog, choose mode **Tile**, then click **Place**.
3. Watch the manager window at the moment the dialog closes.
4. Move the cursor around the canvas, then **left-click** to commit.

- [ ] 6.1a — The Place dialog stays visible while you pick the mode; the manager only hides **after** you commit the dialog.
- [ ] 6.1b — The manager disappears **completely** — no translucent ghost, no residual paint in the window's old rectangle, no window frame catching clicks.
- [ ] 6.1c — A tile preview follows the cursor and is **centred on it**, not offset to a corner.
- [ ] 6.1d — Left-click creates the Tile at the cursor and the manager reappears, in its previous position and size.
- [ ] 6.1e — The review panel is exactly as you left it: same assignment selected, same Framing View, same Saved indicator.

### 6.2 — Token place

1. Repeat 6.1 with mode **New Actor** (or **Existing Actor**), which routes through the tokens layer.

- [ ] 6.2a — Token preview follows the cursor and is centred on it — a Token stores size in grid units, so a preview that sits a half-grid up and left is the specific bug here.
- [ ] 6.2b — Left-click creates the Token; the manager restores.

### 6.3 — Escape mid-placement *(human-only path)*

1. Click **Place** → **Tile** → **Place**.
2. With the preview following the cursor, press **Escape**.
3. Now press **Escape** again, with nothing in flight. Then close some other Foundry window with Escape.

- [ ] 6.3a — Escape cancels the placement: the preview disappears and **no** Tile is created.
- [ ] 6.3b — The manager restores immediately, fully interactive.
- [ ] 6.3c — The **next** Escape you press anywhere in Foundry behaves normally — it is not swallowed.

**What failure looks like:** the manager staying invisible after Escape (the promise never settled, and reopening from the scene control will *not* fix it — the window frame is reused, so only an F5 clears it); or a stray Tile appearing at the cursor despite the cancel; or a later Escape doing nothing anywhere in the app, which means an orphaned capture-phase listener is still eating keystrokes.

### 6.4 — Close the manager while a placement is live *(human-only path)*

1. Click **Place** → **Tile** → **Place** so a preview is following the cursor.
2. The manager is hidden, so you cannot click its close button — instead abandon the placement by pressing **Escape**, and *then*, before doing anything else, close the manager with its window **✕**.
3. Reopen the manager from the scene control.
4. Now the harder variant: start a placement, and while the preview is live, close the manager **programmatically or via another route** if one exists in your setup; otherwise switch scenes in the scene navigation bar while the preview is live.

- [ ] 6.4a — After abandoning and closing, reopening the manager gives a **fully visible, interactive** window — not a blank or invisible one.
- [ ] 6.4b — Switching scenes with a placement live: the placement aborts cleanly, nothing is created on either scene, and the manager (when reopened) is visible.
- [ ] 6.4c — No Tile or Token is ever created against the scene you navigated **to**.

**What failure looks like:** reopening the manager and getting a window that occupies space in the DOM but renders nothing — the inline `display: none` from the hide survived because the restore never ran. Also: a Tile appearing on the *new* scene after a scene switch, which means the placement committed against a scene the GM never chose.

### 6.5 — Transform Token

1. Control one or more tokens on the scene.
2. Select the saved submission and click **Transform Token**, then confirm.

- [ ] 6.5a — The manager gets out of the way for the transform, then restores.
- [ ] 6.5b — The controlled tokens take the drawing's art.
- [ ] 6.5c — Review UI state is intact afterwards.

---

## 7 · SCR-25 — post-SCR-6 architecture deepen

**Judgement: this ticket has no user-observable walkthrough, and none should be invented for it.**

SCR-25 is an architecture-housekeeping epic. Its stated purpose is depth, locality, and AI-navigability — explicitly *"no new Product Framing / dual Save / chrome stories"* — and its own "Done when" clause asks for the opposite of new observable behaviour: **"Regression: dual Save, Framing Views, player delivery unchanged in product terms."** A click path that produced a visible difference would be evidence the ticket *failed*.

There is nothing for a tester to click that is specific to SCR-25. Writing steps for it would manufacture false confidence.

### What constitutes evidence instead

- [ ] 7.1 — `node --test tests/` is green on the branch, in particular the seams this epic carved: `tests/assignment-review.test.mjs`, `tests/framed-background.test.mjs`, `tests/plate-layout.test.mjs`, `tests/prompt-service.test.mjs`, `tests/dual-save.test.mjs`.
- [ ] 7.2 — `node tools/e2e-smoke.mjs` is green (layout → send → draw → snapshot → submit → save → place → finish), with clean GM and player consoles.
- [ ] 7.3 — **Sections 1–6 of this document passed.** That is the real regression evidence for "unchanged in product terms": the deepen slice touched review, framing, plate layout, and the prompt service, and those are precisely the surfaces sections 4–6 exercise. If any of the six sections failed, resolve that first — a product regression there may well be an SCR-25 regression wearing another ticket's number.
- [ ] 7.4 — Module-boundary spot-check, not a click path: open `scripts/prompts/assignment-review.mjs`, `scripts/drawing/framed-background.mjs`, `scripts/drawing/plate-layout.mjs`, and `scripts/prompts/prompt-service.mjs` and confirm each reads as one concept rather than a pass-through. The epic's own success test is *"manager / service / framing hops no longer require walking five files for one concept"* — that is a reading judgement, and it is the repo owner's to make.
- [ ] 7.5 — Children **SCR-26, SCR-27, SCR-28, SCR-29** are each Done or cancelled with a reason. Per the epic's Done-when clause, the parent cannot be closed while any child is still open.

**Note on sequencing:** SCR-25 is blocked by SCR-6 completion. Signing it off before SCR-37 and SCR-48 (both SCR-6 children) are resolved would be out of order.

---

## Sign-off summary

| Ticket | Sections | Verdict | Notes |
|--------|----------|---------|-------|
| SCR-48 | 1 | | |
| SCR-20 | 2 | | |
| SCR-44 | 3 | | |
| SCR-45 | 4 | | |
| SCR-37 | 5 | | |
| SCR-21 | 6 | | |
| SCR-25 | 7 | | |
| SCR-52 (rides along) | preamble | | any Submit |
| SCR-53 (rides along) | preamble | | two-player lifecycle |
| SCR-51 (rides along) | 5.3 | | primary coverage |
| SCR-50 (rides along) | 6.3, 6.4 | | human paths only |
| SCR-55 (rides along) | 4.7, 4.8 | | human paths only |

When the run is done: record the outcome on each Linear ticket within the authorized tracker scope. A human decides which passing tickets to move to Done; agents do so only with explicit user authorization, following the hub [issue workflow](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/issue-tracker.md). Leave anything that failed `ready-for-human` with the failing section number and, for section 5.3, the attempt number and what the player was doing.
