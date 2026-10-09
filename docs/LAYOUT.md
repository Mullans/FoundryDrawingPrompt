# Drawing Prompts documentation and local resources

This repository owns Drawing Prompts product documentation, architectural history, and feature verification. Reusable development guidance lives in FoundryHub.

## Module documentation

- [AGENTS.md](../AGENTS.md): module identity and context pointers, importing shared hub instructions.
- [CLAUDE.md](../CLAUDE.md): imports AGENTS.md.
- [CONTEXT.md](../CONTEXT.md): domain vocabulary.
- [README.md](../README.md): product usage and codebase layout.
- [docs/adr/](adr/): the six architectural decisions for framing/dual saves, display layers, timer layout, placement lifecycle, socket trust, and the local-first recovery boundary. These records retain their product context and rejected alternatives.
- [docs/design/](design/): Drawing Prompts display surfaces, live manager layout, and approved prompt lifecycle/recovery specifications.
- [docs/verification/](verification/): product walkthrough cases and sign-off evidence.
- mockups/: tracked HTML UI references.
- [tools/forge-probe.md](../tools/forge-probe.md): module-specific Forge path-probe snippets.

## Shared FoundryHub guidance

- [Agent instructions](https://github.com/Mullans/FoundryHub/blob/dev/AGENTS.md)
- [Domain documentation workflow](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/domain.md)
- [Linear workflow](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/issue-tracker.md) and [triage labels](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/triage-labels.md)
- [Codex delegation](https://github.com/Mullans/FoundryHub/blob/dev/docs/agents/codex-delegation.md)
- [Verification lifecycle](https://github.com/Mullans/FoundryHub/blob/dev/standards/verification.md)
- [Canvas placement](https://github.com/Mullans/FoundryHub/blob/dev/standards/canvas-placement.md), [socket security](https://github.com/Mullans/FoundryHub/blob/dev/standards/socket-security.md), and [asynchronous rendering](https://github.com/Mullans/FoundryHub/blob/dev/standards/async-rendering.md)

The former module docs/agents/ guides and docs/codex_delegation.md were consolidated into those hub documents. New shared guidance belongs there; module product rules belong here.

## Local history and resources (untracked)

- docs/archive/: retained Drawing Prompts plans, design prompts, issue reports, and dated research. Treat research as historical input requiring validation before reuse. Installation archives are local runtime resources.
- docs/superpowers/plans/ and docs/superpowers/specs/: retained module implementation plans and design specs.
- ignore__*: ad-hoc local dumps.
- .planning/: local GSD roadmap, state, phases, and research.
- .worktrees/: local worktrees.
- .superpowers/: Superpowers runtime state.
- .cursor/: Cursor plans and project state.
- .design-sync/, .ds-sync/, ds-bundle/: local design sync state, conversion tooling, and generated output.
- design-system/: existing local design reference; canonical cross-module design guidance lives in [FoundryHub/design-system](https://github.com/Mullans/FoundryHub/tree/dev/design-system).
- .claude/, .agents/, skills-lock.json: local agent tooling and skill state.

Workspace brainstorms belong in FoundryHub's docs/ideas/; settled Drawing Prompts terms and decisions are recorded in this module's glossary, design notes, and ADRs.
