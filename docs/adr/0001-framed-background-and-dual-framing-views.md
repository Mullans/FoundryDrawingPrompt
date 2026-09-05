# Framed background delivery and dual Framing Views

Players receive only a Framed background (Prompt Framing region of the source, fitted into the Prompt canvas)—never the full source image—so composition stays leak-safe and the player surface stays a simple W×H canvas. Submissions live in Prompt canvas coordinates; the GM maps them into **Full Framing** space: the axis-aligned union of (1) the natural source rect and (2) the Prompt canvas extent mapped into source space via Prompt Framing + Fit (so pad outside the source **and** Fit letterbox/pillarbox pad—e.g. hat room above a character—are included with the full source underlay). Save always writes both Framing View rasters in one action (same gate and refresh path for framed and blank prompts): Prompt-canvas image at `{basename}.{ext}`, Full Framing at `{basename}_full.{ext}` at the composition plate size. Place/Transform use the file for the currently selected Framing View.

Alternative rejected: treating W×H as a large shared “drawing world” that players pan within while holding full-source data—surprising, leak-prone, and not how Prompt dimensions work today.

Alternative rejected: natural-source-only `_full` that drops pad-outside-source ink—loses player work in exterior framing (e.g. a large hat drawn above a head crop).

Alternative rejected: Full Framing = source ∪ Prompt Framing rect only—drops Fit letterbox pad that exists on the Prompt canvas but outside the framing rect in source space.
