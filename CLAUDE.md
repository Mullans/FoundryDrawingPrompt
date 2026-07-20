@AGENTS.md

Store shared agent instructions in `AGENTS.md`. Keep agent-specific behavior in the corresponding agent file. In particular, Claude-specific orchestration and delegation instructions belong in `CLAUDE.md`.

## Division of Labor

The primary agent owns the task from planning through verification. Codex is an available implementation subagent, not the mandatory executor for every file change.

Use Codex when delegation is likely to reduce total effort, cost, or context consumption. Evaluate the complete coordination cost, including preparing the handoff, transferring context, waiting for the result, reviewing the changes, and correcting misunderstandings.

### Delegate to Codex when

Delegation is usually worthwhile when the work is:

* Substantial enough that implementation cost exceeds handoff and review cost
* Clearly scoped with an independently verifiable outcome
* Primarily mechanical, repetitive, or spread across several files
* Suitable for parallel execution while the primary agent continues other work
* Relatively independent of nuanced context held only by the primary agent
* Best handled by inspecting the repository and implementing against an existing specification
* Likely to consume significant primary-agent tokens without requiring primary-agent judgment

Typical examples include implementing a well-defined feature, performing a contained refactor, updating repetitive call sites, adding tests for specified behavior, or making coordinated changes across multiple files.

### Implement directly when

The primary agent should make the change directly when delegation would add more overhead than it saves. This usually includes:

* Small or localized edits
* Trivial fixes
* Changes that can be completed immediately using context already in hand
* Work tightly coupled to ongoing reasoning or debugging
* Changes whose correct implementation depends on subtle conversational context that would be expensive to transfer
* Exploratory edits where the desired implementation is still being determined
* Follow-up corrections that are faster to apply than to explain
* Updates to agent instructions, specifications, or plans currently being authored by the primary agent

Do not delegate merely because a task involves files or implementation. Optimize for total workflow efficiency rather than maximizing Codex utilization.

Avoid unnecessary delegation chains. The agent that receives a task should not delegate it again unless doing so provides a clear efficiency advantage.

## Delegating to Codex

When using Codex, provide enough information for it to work independently without unnecessarily reproducing the primary agent's entire context.

A good handoff should identify:

* The objective and intended behavior
* The relevant repository location or working directory
* The expected scope of changes
* Important constraints, conventions, and compatibility requirements
* Existing files or symbols that Codex should inspect
* Behavior that must be preserved
* Acceptance criteria and relevant verification commands

Include exact file paths, APIs, or method signatures when they are already known or constitute part of the required contract. Do not invent or prematurely prescribe implementation details when Codex can determine them more reliably by inspecting the repository.

Prefer asking Codex to inspect the relevant code before editing rather than embedding large amounts of source code in the prompt.

Codex should remain within the delegated scope. It should report material ambiguities, unexpected repository conditions, or changes that would expand the blast radius rather than making broad assumptions.

## Review and Verification

The primary agent remains responsible for the final result even when Codex performs the implementation.

After Codex completes a task, the primary agent should:

1. Inspect the resulting changes.
2. Compare them against the original intent and acceptance criteria.
3. Check for unintended changes or regressions.
4. Run or review the appropriate tests, linters, type checks, or build commands.
5. Apply small corrections directly when that is more efficient than another delegation round.
6. Delegate a follow-up only when the remaining work is substantial enough to justify it.

Do not treat Codex's completion message as proof that the task is correct. Review the actual files and verification results.

## Invoking Codex

Codex is installed through npm under the Scoop-persisted `fnm` installation.

Stable Windows path:

```text
C:\Users\Sean\scoop\persist\fnm\node-versions\v24.12.0\installation\codex.cmd
```

From a Bash environment:

```bash
CODEX="/c/Users/Sean/scoop/persist/fnm/node-versions/v24.12.0/installation/codex"
"$CODEX" exec --sandbox workspace-write -C "C:\Code\FoundryVTT" - < prompt.md
```

Invocation requirements:

* Use non-interactive `codex exec`.
* Use `--sandbox workspace-write`. Do not use the deprecated `--full-auto` option.
* For substantial prompts, write the prompt to a scratch file and pass it through standard input with `- < prompt.md`. This avoids shell quoting and escaping problems.
* Set the working directory with `-C` rather than relying on the caller's current directory.
* Prefer narrowly scoped prompts that allow Codex to inspect the repository itself.
* Preserve Codex's output and exit status so the primary agent can evaluate failures and verification results.

### Git safety

Codex runs as the separate Windows sandbox user `CodexSandboxOffline`.

Do not instruct Codex to perform Git write operations, including:

* `git init`
* Commits
* Branch creation or switching
* Tag creation or deletion
* Changes to remotes
* Operations that rewrite repository history
* Creation or replacement of `.git` metadata

Repository metadata created by the sandbox user can produce ownership conflicts and Git “dubious ownership” errors for the real user.

Codex may use read-only Git commands when useful for understanding changes, such as `git status`, `git diff`, `git log`, or `git show`. The primary agent or user performs Git write operations outside the Codex sandbox.

### Locating Codex after an fnm upgrade

If the stable path stops working, locate the current executable from Bash with:

```bash
ls ~/scoop/persist/fnm/node-versions/*/installation/codex
```

Update the documented path after confirming the active `fnm` Node installation.

## Agent Skills

### Issue tracker

Issues are maintained in GitHub Issues for `Mullans/FoundryDrawingPrompt` through the `gh` CLI.

See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary:

* `needs-triage`
* `needs-info`
* `ready-for-agent`
* `ready-for-human`
* `wontfix`

See `docs/agents/triage-labels.md`.

### Domain documentation

The repository uses `CONTEXT.md` and `docs/adr/` as its primary domain and architectural context.

See `docs/agents/domain.md`.
