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
- Whatever *can* be enforced in tooling *must* be, regardless of who does the work — at a boundary the
  gate actually owns. A gate states where it is authoritative, and one that guesses at a boundary
  belonging to something else is moved to the boundary that owns it, never left guessing.
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
- The tool owns structure, IDs, cross-references and validation; the host supplies bounded judgment.
  Contract assessment and conceptual design critique are distinct review jobs.
- Decomposition keeps source and its tests together, with bounded work units, dependency ordering and
  enforced write scope. Shared-file work may proceed optimistically; serialized acceptance detects
  conflicts and requires retry against the updated tree, rather than trusting predicted edit regions.
- Multiple host agents can contribute to the same run through persisted bindings and idempotent
  ingestion; no provider-specific claim registry or lease is required.
- Audit preserves source by default. Formatting requires current-run opt-in, and dry-run prevents it.
  Analyzer grants and declines are scoped to the current run. Remediation must run the target's
  declared verification commands or pause for an explicit verification decision.

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

Every finding is re-verified against the source on disk before the report is written. A finding a
tool-executable check disproves is excluded outright; a finding that cannot be confirmed stays in
the report, explicitly marked not-confirmed, so an unverifiable claim is surfaced rather than either
hidden or asserted. The report opens with a summary; each finding then carries its severity,
confidence, lens, and grounding:

<!-- BEGIN sample-report — generated by scripts/check-readme-sample-report.mjs from the real renderer; do not hand-edit -->

*(Illustrative excerpt — rendered by the real report renderer from a fabricated sample repo and one fixture finding; the cited src/queue.ts path belongs to that fabricated repo, not to this repository. A real report carries more sections between Lens coverage and Findings and leads.)*

```text
# Audit Report

## Lens coverage

- behavior: selected. Illustrative fabricated fixture only; no repository was inspected. (findings: 1)

## Findings and leads

- question-finding-69f8d3ab67ba05511a101ef8d6795c33bb960611476b67c9397f70f08e4ba35b: confirmed_defect (actionable; medium).
  - sample-queue-001 on sample-review-queue: Queue summary omits pending entries. The reported total differs from the number of queued entries.
    - Next step: Count pending entries in the same total.
    - Verification: queue-summary-total.
```

<!-- END sample-report -->

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

### Review context and result conformance

For optional independent contract conformance review during remediation, set
`conformance_review: true` in the confirmed intent checkpoint before the first
implementation handoff. The tool binds that choice to the run. Successful landed
and no-change results then need a content-bound independent review after mechanical
checks; missing review pauses, insufficient evidence requests repair, and unavailable
independent review cannot silently fall back to self-review. Independence is declared
by the host; audit-tools verifies the declaration and binding, not reviewer identity.

Required contract reviews use a prompt-bound review submission envelope. Full-depth
critique/critic reviews and the final judge require an independent context; unavailable
review pauses instead of falling back to self-review. The explicit light critique/critic
policy permits declared degraded review. Downstream roles read validated canonical
artifact `payload` fields, while authors write only the separate submission paths.

### The pipelines, step by step

**audit-code:**

Before the audit starts, the host records observed source and relationship inspection
capabilities. Missing capabilities require an explicit stop or an operator-approved,
reported limitation; an installed tool name alone is not evidence.

1. **Understand the repo** — deterministically maps files, public surfaces, the dependency
   graph, critical flows, and a risk register; runs available static analyzers. Audits preserve source files by default; formatting requires explicit per-run `next-step --auto-fix` approval, and `--dry-run` prevents formatting for the rest of that run. Analyzer grants and declines apply only to the current audit.
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
   (commit, push, open PR, publish, tag, none, or a custom command).
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

Run them from anywhere inside the target repository — each resolves that repository's root
from the working directory. `--root <repo>` is the explicit override for running from outside
it (or for targeting a sub-project inside a larger repo).

For targeted review, `next-step` provides a `review_routing` artifact listing only
the pending assignment IDs, issued workload fingerprint and bound command arguments. The dispatch
host runs `audit-code prepare-review --work-item <assignment_id> --workload-sha256
<workload_sha256>` for each selected assignment, using the same root and artifacts
directory. Use the routing artifact's `prepare_review_argv_prefix`, then append
`--work-item` and the assignment ID. The command returns a `prompt_path` and
`read_paths`, not reviewer content. Hand those files and the frozen workspace
to the reviewer harness, or send a reviewer in that workspace only the packet
path. Do not read the full workload or packet into the dispatcher's conversation.
A separate machine must be able to access the advertised paths; the command does
not transfer or remap the workspace. Ordinary host command permissions apply.
When present, the packet’s shared graph handle is for read-only navigation: call
\`audit-code review-graph --graph-index <graph_index> --graph-sha256 <graph_sha256> --path <repo-relative path>\`.
It returns a page of incoming and outgoing file links; narrow with \`--direction\`
or \`--relation\`, or continue with the returned \`--offset\`. Inspect frozen source
before treating a link as evidence. Do not load the full index into reviewer context.
The packet contains just that question, linked evidence and submission
instructions. Reviewers can look up related code in the admitted, frozen
source using the shared index. The worker MCP remains submit-only.

If an accepted answer in an **active** audit addressed the wrong question, run
`audit-code reopen-questions --from <review-reopen.json>` with a unique `reopen_id`,
a `reason`, and a `questions` array. Each entry names the exact `question_id`,
`revision_id`, `snapshot_id`, and `expected_submission_ids` (all current answer IDs
for that question). This preserves the old answers and decisions as history.
Run `audit-code next-step` to issue replacement assignments; do not reuse old
assignment IDs or result paths. Exact request replay is a no-op. Finished audits
are not changed by this command.

If a **review-only tooling upgrade** would stale the active plan, an explicit
`tooling_transition` in that request may qualify the existing evidence. Give
`prior_implementation_hash`, `current_implementation_hash`, and a `reason`
for reusing the historical evidence. Both hashes, the frozen source, scope,
intent, and analyzer evidence must match. This authorizes continuing review
under the new host, not rerunning analysis or recertifying old findings.

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

### Analyzer versions and incomplete runs

A new audit resolves current upstream releases for admitted managed analyzers, except when a bundled dependency lock qualifies the analyzer and its compiler together (currently type-coverage and TypeScript). It records the exact versions and outcomes in the acquisition artifact. Resuming a completed acquisition does not upgrade those tools. Cargo and Bundler analyzers still use the project's toolchain. Existing consent, approved origins, binary checksum verification, and repository scope remain in force.

If an analyzer fails, the next step identifies the analyzer, attempted version, and stage. Read its status record, diagnose the failure, and retry only that analyzer on the same frozen source. Record any version override and import the normalized output with `audit-code import-external-analyzer` and the retry's tool status. If it cannot be recovered, carry the coverage gap into the report. A failed run is not a clean result, and no older release is silently substituted.
