# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── scripts/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

## Grilled decisions become written spec

When a grill (or any explicit design conversation) **settles** a product/UI/architecture choice, record it in the same session—do not leave it only in chat or Linear comments:

| Kind of decision | Where it goes |
|------------------|---------------|
| Domain term / ubiquitous language | `CONTEXT.md` (glossary only) |
| Hard-to-reverse trade-off, surprising shape, or rejected alternative | New or updated `docs/adr/NNNN-*.md` |
| Layout / interaction product rules that implementers must follow | `docs/design/*.md` plus an ADR when the three ADR tests apply |

Later grills that intentionally replace a decision must update or supersede the written record. Tickets may point at these docs; they are not a substitute for them.
