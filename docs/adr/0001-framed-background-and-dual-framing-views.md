# Framed background delivery and dual Framing Views

Players receive only a Framed background (Prompt Framing region of the source, fitted into the Prompt canvas)—never the full source image—so composition stays leak-safe and the player surface stays a simple W×H canvas. Submissions live in Prompt canvas coordinates; the GM maps them into full source space for Source Framing using the source’s bounding box relative to the Prompt canvas (from Prompt Framing + Fit mode). Save always writes both Framing View rasters in one action (same gate and refresh path for framed and blank prompts): Prompt-canvas image at `{basename}.{ext}`, Source Framing at `{basename}_full.{ext}` at the source image’s natural resolution. Place/Transform use the file for the currently selected Framing View.

Alternative rejected: treating W×H as a large shared “drawing world” that players pan within while holding full-source data—surprising, leak-prone, and not how Prompt dimensions work today.
