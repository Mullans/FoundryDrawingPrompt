@../../AGENTS.md

# Drawing Prompts — Module Instructions

Shared development rules come from the [FoundryHub agent instructions](https://github.com/Mullans/FoundryHub/blob/dev/AGENTS.md); the import above applies in the hub workspace.

- **Repository:** work and commit module files in this repository, Mullans/FoundryDrawingPrompt (modules/drawing-prompts/ in FoundryHub).
- **Issues:** use Linear team Scratchprojects (SCR), project Drawing Prompts. Follow the hub [issue workflow](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/issue-tracker.md) and [triage labels](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/triage-labels.md). PRs are not a request intake surface.
- **Domain:** before exploring product behavior, read [CONTEXT.md](CONTEXT.md) and relevant [ADRs](docs/adr/). Record settled product rules in [docs/design/](docs/design/) and architectural trade-offs in ADRs, following the hub [domain workflow](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/domain.md).
- **Brainstorms:** in FoundryHub, save them in the hub's docs/ideas/; a standalone clone uses its own docs/ideas/. Merge settled vocabulary into this module's CONTEXT.md.
- **UI and rendering:** read [canvas display layers](docs/design/canvas-display-layers.md) for framing/review surfaces and [GM live manager summary](docs/design/gm-live-manager-summary.md) for live layout. Placement and socket changes must also follow [ADR-0004](docs/adr/0004-canvas-placement-must-settle.md) and [ADR-0005](docs/adr/0005-socket-trust-boundary.md), respectively.
- **Verification:** follow the hub [verification lifecycle](https://github.com/Mullans/FoundryHub/blob/dev/standards/verification.md). UI changes run node tools/e2e-smoke.mjs, including its layout geometry assertions and GM/player console checks. For the historical SCR-6 follow-up acceptance cases, use the module [human walkthrough](docs/verification/ready-for-human-walkthrough.md); record fresh evidence before claiming a pass.
- **Documentation:** [docs/LAYOUT.md](docs/LAYOUT.md) maps module docs, local archives, and shared hub guidance.
