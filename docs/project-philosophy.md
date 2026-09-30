# Project philosophy

The brief is the canonical condensed statement. Detailed contracts and procedures live in the homes
below; refer to them instead of maintaining another prose restatement. If a detailed contract changes,
update the brief when its principle changes too.

The README's Philosophy section is generated from the Product half by
`npm run check:philosophy-brief -- --write`. The question-philosophy hook reads the whole brief directly.
Never hand-edit the generated README block.

## The brief

<!-- BEGIN philosophy-brief — the README's Philosophy section is generated from the Product half -->

**Product — what audit-tools is.**

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

**Working — how the work gets done.**

- Ideal code over compatibility; delete legacy rather than carry it. Effort, complexity and refactor
  size are NOT costs — only the endpoint matters. Correctness is the only thing that gates pace.
  What lands on `main` is still the atomic replace; a temporary internal seam may exist BETWEEN
  COMMITS ON A BRANCH, provided it is gone before that branch merges and every commit is green.
- Ask on genuine ambiguity, and batch the questions. Never silently pick a default, and never quietly
  defer a decision that is the owner's.
- A needed manual flag, or a fix that amounts to "be careful next time", is a bug signal — move the
  friction into the tool instead.
- One home per fact. Single-source and extract rather than keeping two copies honest with a drift test.
- Deliverables land in a file; chat gets the path and a short digest, never the deliverable itself.
- Green at every commit, and every regression test is red-green validated before it is trusted.
- End-of-sprint cleanup runs unprompted, and every remaining step is stated with the document it lives
  in — a step that lives only in chat is lost.
- Docs capture durable concepts, not current state. Absence of a thing is not staleness. Semantic
  document review scales to what changed — the changed documents, their declared dependents, and a
  periodic sweep — never the whole corpus every pass. The end-of-sprint closeout does NOT scale: it
  runs whole, every sprint.
- Front-load the broad prior-art search before authoring anything — narrow scope is the top churn driver.
- Log friction the moment you hit it, in all its categories, without being asked.
- A disambiguation pass leaves an item fully specified or unchanged. Do not silently defer based on
  an assumption that a problem is rare; ground that judgment in operational evidence and the owner's direction.

<!-- END philosophy-brief -->

## Canonical homes

The A/B labels remain navigation references for existing project guidance, not separate policy copies.

| Concept | Canonical home |
| --- | --- |
| A1: one core, two policy draws; bounded obligation drain | [`CLAUDE.md`](../CLAUDE.md), Concepts and audit-code architecture; [`orchestration policy`](../spec/audit/orchestration-policy.md) |
| A2–A3: deterministic tools, bounded judgment, tool-owned correctness | [`CLAUDE.md`](../CLAUDE.md), Concepts and Conventions & invariants |
| A4–A5: host/platform neutrality and conversation-first execution | [`CLAUDE.md`](../CLAUDE.md), Conventions & invariants |
| A6: adversarial depth and phase granularity on one pipeline | [`Self-scaling pipeline`](../spec/self-scaling-pipeline-design.md) |
| A7: contract authoring and distinct review responsibilities | [`CLAUDE.md`](../CLAUDE.md), Preferences & standing decisions |
| A8: source/test co-location and optimistic shared-file work | The Product brief above; implementation in `src/remediate/steps/contractPipeline.ts` and `src/remediate/steps/dispatch/hostHandoff.ts` |
| A9: cooperative host agents in the same run | [`Concurrent runs`](../spec/multi-ide-concurrent-runs-design.md) |
| A10: acquired analyzers, consent and vetted parsing dependencies | [`CLAUDE.md`](../CLAUDE.md), Preferences & standing decisions |
| A11: content sizing and the host execution boundary | [`Audit workflow`](../spec/audit-workflow-design.md) and [`remediation workflow`](../spec/remediation-workflow-design.md) |
| B1: endpoint-first decisions and communication | The Working brief above; [`CLAUDE.md`](../CLAUDE.md), Preferences & standing decisions |
| B2: authorized shipping and live verification | [`Ship workflow`](../.claude/skills/ship/SKILL.md) |
| B3: atomic replacement, green commits and shared primitives | [`CLAUDE.md`](../CLAUDE.md), Conventions & invariants |
| B4: full end-of-sprint cleanup | [`CLAUDE.md`](../CLAUDE.md), Conventions & invariants, and the repository closeout renderer |
| B5: durable documentation with one home per fact | [`Documentation philosophy`](documentation-philosophy.md) |
| B6: complete disambiguation and friction records | [`Disambiguation workflow`](../.claude/skills/disambiguate-backlog/SKILL.md); [`CLAUDE.md`](../CLAUDE.md), Known friction & deferred fixes |

A product principle and its development consequence use the same home. In particular, one core/two
draws and enforcing correctness in tooling do not need a second bridge section.
