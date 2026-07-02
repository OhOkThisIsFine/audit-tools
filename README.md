# audit-tools

One npm package shipping two independent code tools over a shared library. Each has its
own CLI and host slash-command, and each is useful on its own:

- **`audit-code`** (`/audit-code`) — audits a repository/project and produces a findings report.
- **`remediate-code`** (`/remediate-code`) — implements changes from findings and/or free-form intent.

They **compose but don't depend on each other**: audit-code's findings are clean input to
remediate-code, but you can run either alone. Audit a repo and stop. Or point remediate-code
at a plain-English request with no audit in sight — or hand it audit findings *and* extra
suggestions at the same time.

Each tool writes its results to `.audit-tools/` as a machine contract (JSON) plus a
human-readable render (markdown):

| Tool | Machine contract | Human render |
|---|---|---|
| audit-code | `audit-findings.json` | `audit-report.md` |
| remediate-code | `remediation-outcomes.json` | `remediation-report.md` |

## Install

```bash
npm install -g audit-tools
```

This puts both `audit-code` and `remediate-code` on your `PATH` and, via the package
postinstall, deploys slash-command assets for supported hosts (Claude Code, Codex,
OpenCode, VS Code, Antigravity).

## Usage

The tools are meant to be run as slash-commands inside a host agent. Just invoke the command —
no manual path, provider, or model flags. The agent works its way through the whole workflow
on its own, running against your active conversation model, and only stops to ask you when it
needs a real decision (scope, ambiguous intent, whether to open a PR, and the like).

**Audit a code base:**

```text
/audit-code
```

You'll confirm scope and which lenses to apply (security, correctness, reliability,
data-integrity, etc.), then it runs to completion and leaves `audit-findings.json` +
`audit-report.md` in `.audit-tools/`.

**Remediate issues or implement changes:**

```text
/remediate-code path/to/audit-findings.json
/remediate-code split the auth module and make session refresh easier to test
/remediate-code path/to/audit-findings.json — and prioritize the error-handling issues
```

It plans the changes, implements and verifies them, and lands the result — a commit by
default, or a PR / publish if you ask. You confirm scope and the closing action up front and
review a summary before anything is committed.

### What to expect

- **It drives itself.** A single slash-command runs the full workflow; it pauses only for
  clarifications, not to hand each step back to you.
- **Runs are resumable.** State persists to `.audit-tools/` in the target repo, so an
  interrupted run picks up where it left off.
- **Work runs in parallel** where it safely can, even allowing for coordination between
  different IDEs, different providers, CLIs, local models, etc.
- **Effort scales to the work.** Trivial work gets light review; risky or complex work
  gets deeper scrutiny.

### The pipelines, step by step

**audit-code:**

1. **Confirm providers** — discovers the LLMs available in your session and confirms which to use.
2. **Understand the repo** — deterministically maps files, public surfaces, the dependency
   graph, critical flows, and a risk register; runs available static analyzers and auto-fixes.
3. **Confirm intent** — you review the scope and pick the review lenses.
4. **Review the design** — two parallel passes: a contract pass (invariants, boundaries,
   obligations) and a conceptual pass (philosophy, alternatives, better directions).
5. **Plan** — turns the risk register into bounded, prioritized review tasks.
6. **Review in parallel** — dispatches the review tasks to your LLMs, routing riskier work to
   more capable models, and deep-dives selectively.
7. **Synthesize** — consolidates everything into `audit-findings.json` + `audit-report.md`,
   then layers on a narrative (themes, executive summary, top risks).

**remediate-code:**

1. **Confirm providers** — same session-level provider check as audit-code.
2. **Intake** — reads the findings and/or free-form intent, validates the input, and drafts a
   summary with any open questions.
3. **Confirm intent** — you confirm scope, answer open questions, and set the closing action
   (commit, push, open PR, publish, or halt).
4. **Design the change** — decomposes the work into modules, drafts a contract per module in
   parallel, detects and reconciles seams (where one module's output must match another's
   input), then derives obligations and a test plan. Riskier changes get an independent
   critic-and-judge pass.
5. **Preview the risk** — shows the classified risk, file list, and commit message before
   anything runs.
6. **Implement in parallel** — executes the changes in isolated worktrees, running tests and
   verifying each unit; failures are triaged and retried or blocked.
7. **Close** — runs the closing action and writes `remediation-outcomes.json` +
   `remediation-report.md`.

### CLI (backend / fallback)

The slash-commands are the product; the same engines are also directly runnable:

```bash
audit-code next-step        # advance an audit one step
remediate-code next-step    # advance a remediation one step
```

Add `--root <repo>` when running from outside the target repository.

## Develop

TypeScript, Node 20+. From the repo root:

```bash
npm install     # always run first in a fresh clone/worktree
npm run build   # tsc → dist/
npm run check   # typecheck only
npm test        # build + test
```

Missing `node_modules` makes `audit-tools/shared` resolve a stale `dist/`, producing
misleading "no exported member" type errors — so install before build/check/test.

See [`CLAUDE.md`](CLAUDE.md) for architecture and design decisions, the specs in
[`spec/`](spec/), and the product/operator/contract guides in `docs/audit-pkg/`.

## License

ISC
