# GM live manager summary bar

Product layout notes for the live/review Drawing Prompt Manager summary. Decision record: [ADR-0003](../adr/0003-gm-live-manager-timer-block.md).

## Summary row

| Zone | Contents |
|------|----------|
| Left identity | Prompt quote (+ expand) · separator · drawing name |
| Right timer block | Only when the prompt has a timer; otherwise disabled transport stubs may still sit here for stability |

## Timer block

- One contiguous control cluster (not split across rows).
- Upside-down T: chip over Pause / Reset / Stop; minus adjustments left; plus adjustments right.
- Active countdown stays inside the block with those controls.

## Explicitly not in the summary or preview chrome

- Canvas width × height readout (GMs already set these; Prompt-canvas dims are wrong under Full Framing).
- Background thumbnail.
