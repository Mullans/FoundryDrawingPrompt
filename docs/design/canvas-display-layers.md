# Canvas display layers (SCR-6 refinement)

Working model for how Prompt canvas geometry shows up in UI. Domain terms: `CONTEXT.md`. Decision record: [ADR-0002](../adr/0002-canvas-plate-and-display-layers.md).

## Shared rules

| Rule | Detail |
|------|--------|
| Prompt canvas size | Logical W×H the GM sets; sole Submission coordinate space. |
| Fit mode | Places Framed background **into** the Prompt canvas / plate, not the outer window. |
| Canvas plate | On-screen box with that aspect ratio. |
| Plate border | Thin Foundry-style accent on the plate; display-only; not exported. |
| No motion chrome | No resize/fade animations on previews or plate layout. |

## Surfaces

### Player workstation

```
┌── Display stage (Canvas chrome) ─────────────────┐
│  pan / zoom target (stage padding navigable)     │
│   ┌── Canvas plate (accent border) ───────────┐  │
│   │  Framed background (Fit mode) + ink       │  │
│   │  logical W×H                              │  │
│   └───────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

- Open / navigation reset: fit plate fully in stage (letterbox/pillarbox).
- Tools only on plate pixels; stage exterior is navigation-only for pan/zoom (including right-click pan, wheel, space+primary, etc.).
- Chrome on stage is intentional—do **not** reserve chrome to the plate alone on this surface.

### GM compose framing

```
┌── Panel void (no chrome) ────────────────────────┐
│   ┌── Canvas plate (chrome + accent border) ──┐  │
│   │  Framing pan/zoom of source into W×H      │  │
│   │  (Prompt Framing delivery, not player nav)│  │
│   └───────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

- Plate aspect = draft `canvasWidth` × `canvasHeight`.
- Plate size: responsive within the manager preview pane (keep ratio as window resizes).
- Chrome only on the plate.

### GM Assignment review

- Static Prompt-canvas Framing View **or** Source Framing.
- No draw, pan, zoom, or drawing engine.
- Prompt-canvas image ladder: live/pending → saved path → **Framed background** (never bare “no snapshot” when a delivery image exists).
- Source Framing: baked remapped preview / `_full` / source alone as appropriate.
- Prefer simple responsive images; Plate border without double outlines against existing frame CSS.

## Export / Save

Borders and stage chrome never enter overlay, merged, source-space, or `_full` rasters. Dual Save and Framing Views remain as in ADR-0001.
