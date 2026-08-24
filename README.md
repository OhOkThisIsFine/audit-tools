# audit-tools

One npm package shipping two independent code tools over a shared library. Each has its
own CLI and host slash-command, and each is useful on its own:

- **`audit-code`** (`/audit-code`) — audits a repository/project and produces a findings report.
- **`remediate-code`** (`/remediate-code`) — implements changes from findings and/or free-form intent.

They **compose but don't depend on each other**: audit-code's findings are clean input to
remediate-code, but you can run either alone. Audit a repo and stop. Or point remediate-code
at a plain-English request with no audit in sight - or hand it audit findings *and* extra
suggestions at the same time.

Each tool writes its results to `.audit-tools/` as a machine contract (JSON) plus a
human-readable render (markdown):

| Tool | Machine contract | Human render |
|---|---|---|
| audit-code | `audit-findings.json` | `audit-report.md` |
| remediate-code | `remediation-outcomes.json` | `remediation-report.md` |

## Philosophy

<!-- BEGIN philosophy-brief — generated from docs/project-philosophy.md; do not hand-edit -->

- The tool must be trustworthy even when the host agent is weak. Correctness is guaranteed by the tool,
  never by the host being careful or clever.
- Use mechanical, deterministic tools wherever one does the job as well as or better than a model.
- Use LLM judgment where it clearly lifts quality — bounded, scoped and recorded. The project is not
  "100% deterministic", and it is not trying to be.
- Whatever *can* be enforced in tooling *must* be, regardless of who does the work.
- Don't grade your own homework: anything important or complex gets an independent adversarial check
  that is allowed to refuse.
- Keep tasks tightly bound and well defined, so the gap between weak and strong models shrinks.
- Batch work into logical units of reasonable size — rigor balanced against token cost, not 100 agents
  for 100 files.
- Keep everything IDE-, provider-, model-, OS-, shell- and language-agnostic: outside the product
  contract or abstracted, never baked in. The host owns semantic execution; audit-tools detects repo
  structure and normalizes analyzer output into shared contracts, never forks planning per ecosystem.
- Auditing and remediating are not two tools — they are two cases of ONE logical core, drawn read-only or
  write-and-apply. The boundary between them is continuously being dissolved, and re-introducing it is the
  most persistent mistake made against this project; a difference between the two is a policy axis of the
  shared core, almost never a reason to fork it.
- Auditing produces findings, remediation consumes them and fixes. The machine contract is the source of
  truth; the human report is its render.
- Nothing runs to completion in a single call. Each invocation does a bounded, persisted piece of work,
  so a run is resumable, parallelizable and failure-isolated.
- Scale the process to the work — depth and granularity are dials on one pipeline, never a separate
  lighter path.
- Artifacts are continuity: staleness propagates along an explicit dependency map, never ad-hoc
  freshness checks.

<!-- END philosophy-brief -->

## Install

```bash
npm install -g audit-tools
```

This puts both `audit-code` and `remediate-code` on your `PATH` and deploys global
slash-command assets for supported hosts (Claude, Codex, OpenCode, Antigravity, etc.).
Running `/audit-code` inside a repo then bootstraps any remaining per-repo host files
(e.g. VS Code's prompt/agent/instructions).

## Usage

The tools are meant to be run as slash-commands inside a host agent. Just invoke the
command—there are no provider, model, or quota flags. audit-tools plans bounded work and
emits self-contained host workloads; the host chooses how to execute them, writes the bound
result records, and returns them for strict validation and ingestion. The agent you're
conversing with works through the persisted workflow and stops only for a real decision.

**Audit a code base:**

```text
/audit-code
```

You'll confirm scope, depth, and which lenses to apply (security, correctness, reliability,
data_integrity, etc.), then it runs autonomously to completion and leaves
`audit-findings.json` + `audit-report.md` in `.audit-tools/`.

Every finding in the report is adversarially verified against current source by an
independent reviewer before it's kept. The report opens with a triaged summary and 
drills down by severity:

*(Illustrative sample — the counts and the `file:line` citation below are fabricated for the example, not a real finding.)*

```text
# Audit findings — verified & pruned

- Verified-real findings: 186 (of 204 extracted; 10 false, 8 uncertain)
- By severity: high 7 · medium 97 · low 78 · info 4
- By lens: tests 69 · maintainability 68 · correctness 24 · observability 17 · ...

## High (7)
### Citation-grounding retry leaves extracted plan completion marker
- Lens: correctness · Category: incorrect-state-transition · Confidence: high
- Summary: The promotion path writes the plan before running the citation-grounding
  backstop ... a later step treats the pipeline as complete, bypassing the retry.
- Affected: src/remediate/steps/contractPipeline.ts:540-548
```

**Remediate issues or implement changes:**

```text
Just run:
/remediate-code
# auto-detects audit-findings.json and other sources of remediation targets

/remediate-code fix the stupid OAuth issues I keep running into
# turns your desires into structured plans, then remediates

/remediate-code implement ~/1337h4x/top-secret-plans.txt - also make a mobile app I can
use to track the progress of my nefarious machinations
# synthesizes structured findings + free-form feedback, plans out the whole refactor
```

It plans the changes, implements and verifies them, and lands the result - a commit, a
PR / publish, whatever. You confirm scope and the closing action up front, and review
a summary before anything is committed.

### What to expect

- **It drives itself.** A single slash-command runs the full workflow; it pauses only for
  clarifications, and tries to front-load those questions so it can run uninterrupted.
- **Runs are resumable.** State persists to `.audit-tools/` in the target repo, so an
  interrupted run picks up where it left off.
- **The host owns execution.** It can run independent work items in parallel using whatever
  native subagent or collaboration facilities are available in the current session.
- **Effort scales to the work.** Trivial work gets light review; risky or complex work
  gets deeper scrutiny.
- **Results are untrusted input.** Prompt bindings, file coverage, worktree identity, commit
  evidence, and test evidence are checked before host-produced work changes persisted state.

### The pipelines, step by step

**audit-code:**

1. **Understand the repo** — deterministically maps files, public surfaces, the dependency
   graph, critical flows, and a risk register; runs available static analyzers and auto-fixes.
2. **Confirm intent** — you review the scope and pick the review lenses.
3. **Map the subsystems** — deterministically clusters the code into real subsystems by
   overlaying how it actually behaves (call/import, co-change, shared state) against how it's
   declared to be organized (directories, docs, comments), and flags where the two disagree:
   a tightly-coupled cluster no declared boundary owns, or a declared purpose smeared across
   the codebase. On a deeper review it then has an LLM extract and confirm each subsystem's
   charter — what it's *stated* to do versus what the code *reveals* it does — and surfaces the
   gaps, then triangulates any charter question still worth resolving into a clear yes/no before
   moving on.
4. **Review the design** — two parallel passes: a contract pass (invariants, boundaries,
   obligations) and a conceptual pass (philosophy, alternatives, better directions). On a deeper
   review it also runs a second-order adversarial pass over the whole codebase asking "is there a
   fundamentally better way to do this?", looping until a round turns up nothing new.
5. **Plan** — turns the risk register into bounded, prioritized review tasks and emits a
   complete, provider-neutral host workload.
6. **Review through the host** — the conversation host assigns the bounded items, then
   audit-tools validates and ingests the bound result records and deep-dives selectively.
7. **Synthesize** — consolidates everything into `audit-findings.json` + `audit-report.md`,
   then layers on a narrative (themes, executive summary, top risks).

The numbering is a conceptual grouping, not the literal execution sequence — the authoritative
order is the `PRIORITY` array in `src/audit/orchestrator/nextStep.ts`, which interleaves some
steps (e.g. deterministic subsystem clustering runs before the intent checkpoint).

**remediate-code:**

1. **Intake** — reads the findings and/or free-form intent, validates the input, and drafts a
   summary with any open questions.
2. **Confirm intent** — you confirm scope, answer open questions, and set the closing action
   (commit, push, open PR, publish, or halt).
3. **Design the change** — decomposes the work into modules, drafts a contract per module in
   parallel, detects and reconciles seams (where one module's output must match another's
   input), then derives obligations and a test plan. Riskier changes get an independent
   critic-and-judge pass.
4. **Review the findings** — presents every finding bucketed by how much of your judgment it
   needs (strategic / concrete / mechanical); you approve or decline each before anything
   proceeds to implementation.
5. **Implement through the host** — emits all eligible provider-neutral work items. The host
   performs the edits and returns prompt-bound commit and test evidence; audit-tools validates
   that evidence before accepting completion.
6. **Close** — previews the file list and commit message for your confirmation (unless
   pre-authorized), then runs the closing action and writes `remediation-outcomes.json` +
   `remediation-report.md`.

The numbering is a conceptual grouping, not the literal execution sequence — the authoritative
order is `decideNextStep` in `src/remediate/steps/nextStep.ts`, which interleaves some steps.

### CLI (backend / fallback)

The slash-commands are the product; the same engines are also directly runnable via CLI:

```bash
audit-code next-step        # advance an audit one step
remediate-code next-step    # advance a remediation one step
```

Add `--root <repo>` when running from outside the target repository.

## Develop

TypeScript, Node 22+. From the repo root:

```bash
npm install     # always run first in a fresh clone/worktree
npm run build   # tsc → dist/
npm run check   # typecheck only
npm test        # build + test
```

Missing `node_modules` makes `audit-tools/shared` resolve a stale `dist/`, producing
misleading "no exported member" type errors, so install before build/check/test.

The published package carries the consumer-facing guides only:

- [Product overview](docs/audit-pkg/product.md)
- [Operator guide](docs/audit-pkg/operator-guide.md)
- [Contract reference](docs/audit-pkg/contracts.md)

Everything else is repository-only and therefore linked absolutely: architecture
and design decisions
([`CLAUDE.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/CLAUDE.md)),
the normative specs
([`spec/`](https://github.com/OhOkThisIsFine/audit-tools/tree/HEAD/spec)), the
contributor guide
([`docs/audit-pkg/development.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/docs/audit-pkg/development.md)),
and the release runbook
([`docs/audit-pkg/release.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/docs/audit-pkg/release.md)).

## License

ISC
