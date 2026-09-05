# Issue tracker: Linear

Issues and PRDs for this repo live in **Linear**. Use the **Linear MCP** (`plugin-linear-linear`) for all ticket operations. Do **not** create work tickets as GitHub issues.

## Defaults

| Setting | Value |
|---------|-------|
| Team | `Scratchprojects` (key `SCR`) |
| Project | `Drawing Prompts` |
| Identifiers | `SCR-N` (e.g. `SCR-5`), never bare GitHub `#N` for work tickets |
| Workspace URL | https://linear.app/scratchprojects |

Triage labels: see `docs/agents/triage-labels.md`. They already exist on the Linear team.

PRs, code review, and CI stay on GitHub (`gh` for those only).

## Conventions

Discover tool schemas with MCP inspection before first use in a session if unsure. Pass Markdown descriptions with real newlines (no escaped `\n`).

### Search before create (hard rule)

**Never create a duplicate.** Before every `save_issue` **create** (no `id`):

1. `list_issues` / search the project (`Drawing Prompts`) with 1–2 keywords from the intended title (and a second query if needed).
2. If an open (or recently completed) issue already covers the same intent — even with a different title — **update that issue** (`id: "SCR-N"`, patch description / labels / state). Do **not** create a second ticket.
3. Create only when nothing similar exists. “Similar enough to merge later” means you should have merged **now**.

Creating an issue and later canceling it as a duplicate is a **process failure at creation time**, not normal triage.

- **Create an issue**: only after the search-before-create check; then `save_issue` with `title`, `team: "Scratchprojects"`, `project: "Drawing Prompts"`, and `description` body. Add triage labels via `labels` (e.g. `["needs-triage"]`).
- **Read an issue**: `get_issue` with the identifier (`SCR-N` or UUID). Load thread with `list_comments` (`issueId`).
- **List issues**: `list_issues` with filters as needed — `team`, `project: "Drawing Prompts"`, `label` (e.g. `ready-for-agent`), `state`, `assignee` (`"me"` or `null` for unassigned), `includeArchived: false`.
- **Comment on an issue**: `save_comment` with `issueId` (identifier or UUID) and body.
- **Apply / replace labels**: `save_issue` with `id: "SCR-N"` and `labels: ["…"]` — this **replaces** the full label set; include every label that should remain.
- **Close / cancel**: `save_issue` with `id: "SCR-N"` and `state: "Done"` (completed) or `state: "Canceled"` (won't do / abandoned). Prefer a `save_comment` first with the resolution note. Do **not** create duplicates in order to cancel them — that violates search-before-create.
- **Claim**: `save_issue` with `id: "SCR-N"` and `assignee: "me"`.
- **Priority** (optional): `priority` on `save_issue` — `0` none, `1` urgent, `2` high, `3` medium, `4` low.

## Verification before Done (hard rule)

Agents implement and leave evidence on the ticket; they do **not** mark issues `Done` until verification is complete.

| Stage | Linear state / labels | Who |
|-------|----------------------|-----|
| Implementing | `In Progress`, `ready-for-agent` | Agent |
| Code claimed complete; needs human/Foundry check | Keep open (`In Progress` or `Backlog`), set `ready-for-human`, comment with what was done + how to verify | Agent |
| Verified (unit + any required e2e/walkthrough per the ticket) | `Done` | Human, or agent **only when the user explicitly says to close / mark verified** |

**Do not** treat green unit tests alone as license to close product/UI tickets (framing, reopen, Place, player tools, etc.).

### Recourse after a premature or post-Done failure

1. **Same defect / same acceptance criteria** — **Reopen** the existing `SCR-N` (`state: "In Progress"` or `Backlog`), comment with the walkthrough failure and repro, keep `ready-for-agent` (or `ready-for-human` if triage needed). Prefer reopen over a new ticket so history and AC stay on one id.
2. **New distinct follow-up** — Create a new issue, `relatedTo` / `parentId` as appropriate; leave the original Done if its AC still holds.
3. **Parent epic** — If open children still need verification, do not close the parent; if the parent was closed early, reopen it until residual children are verified or explicitly deferred.

Agents: comment freely; create/update issues freely when the user has authorized plan-related tracker work. **Never block the session waiting for permission to close** — leave tickets open with a verification comment instead.

If Linear MCP is unauthenticated, run `mcp_auth` for server `plugin-linear-linear` before other tools.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, external **GitHub PRs** are intake only (not the issue tracker). Use `gh pr` then **mirror** accepted requests into Linear via `save_issue` with `needs-triage` or the appropriate triage label:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment on PR**: `gh pr comment`. Do not treat the PR as the durable ticket — create/update Linear instead.

GitHub `#N` may be an issue or PR. Resolve with `gh pr view N` then `gh issue view N` only when referring to historical GitHub artifacts. New work uses `SCR-N`.

## When a skill says "publish to the issue tracker"

Create a Linear issue (`save_issue` on team `Scratchprojects`, project `Drawing Prompts`).

## When a skill says "fetch the relevant ticket"

Run `get_issue` for `SCR-N` (or the given Linear URL/id) and `list_comments` on that issue.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single Linear issue with **child** issues as tickets.

- **Map**: one issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `save_issue` with `labels: ["wayfinder:map"]` (and any other labels that must stay). Prefer project `Drawing Prompts`.
- **Child ticket**: `save_issue` with `parentId` set to the map's identifier (`SCR-N`). Put `Part of SCR-<map>` at the top of the child body for human readability. Labels: `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`). Once claimed, set `assignee` to the driving dev (`"me"` or their user id).
- **Blocking**: Linear relations on `save_issue` — `blockedBy: ["SCR-…"]` (append-only) for open blockers; `blocks` for the inverse. A ticket is unblocked when every blocker is **Done** or **Canceled**. Where relations are unavailable, fall back to a `Blocked by: SCR-N, SCR-M` line at the top of the child body.
- **Frontier query**: `list_issues` for open children of the map (`parentId` when supported by the query, otherwise filter project/team results by parent in the map body / `get_issue` children). Drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `save_issue` with `id: "SCR-N"` and `assignee: "me"` — the session's first write.
- **Resolve**: `save_comment` with the answer, then `save_issue` with `state: "Done"`, then append a context pointer (gist + link) to the map issue's Decisions-so-far (`save_issue` `patch` or full description update on the map).
