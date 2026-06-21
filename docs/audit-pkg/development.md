# Development

## Repository layout

- `src/`: implementation code
- `schemas/`: JSON schemas for public and internal artifacts
- `examples/`: validated artifact examples
- `skills/audit-code/`: canonical prompt and skill-facing instructions
- `dispatch/`: packet-dispatch support data
- `tests/`: Node test suite and regression coverage
- `dist/`: checked-in compiled runtime used by packaged installs

## Agent handoff

Keep long-term product direction in `docs/product.md` and archival context
(shipped sprints, field-trial lessons) in `docs/history.md`. There is no
standing per-sprint handoff file; sprint notes are folded into `docs/history.md`
once the work ships.

## Build and test

```bash
npm install
npm run check
npm test
npm run test:single -- tests/next-step.test.mjs
npm run verify:release
```

Run `npm install` from the repository root before running build, check, test, or
package-scoped workflows in a fresh clone or git worktree. Missing
`node_modules` can surface as misleading `audit-tools/shared` export or type
errors because dependents may resolve stale compiled `dist/` output.

The test suite is intentionally contract-heavy. Update tests when changing
schema shape, prompt contracts, dispatch behavior, installer output, or release
workflow semantics.

## Architecture

The system separates deterministic extraction from bounded LLM judgment:

1. intake and file disposition
2. surface, flow, graph, unit, risk, and coverage artifacts
3. audit task planning
4. review packet construction
5. semantic review through the active conversation or fallback provider bridge
6. result ingestion, selective deepening, runtime validation, and synthesis
7. final `audit-report.md`

Portability rules:

- tool-specific collectors write tool-agnostic JSON
- prompts consume artifacts and bounded source context
- review work is attributable to files, lenses, passes, and tasks
- coverage gaps are machine-detectable

`AuditTask` is the coverage identity; `AuditResult[]` is the ingestion contract.

## Adding language analyzers

Language support should be adapter-based. A new analyzer should enrich shared
artifacts instead of inventing a language-specific planning path.

Avoid adding another bespoke manifest or project-file parser by default. First
ask whether the signal is common in expected repositories, whether it provides
direction or ownership that path heuristics cannot, and whether the same value
could come from a generic analyzer-supplied ownership hint.

Preferred outputs:

- graph edges with kind, direction, confidence, and reason
- entrypoints and surfaces
- test-to-source links
- package/module ownership hints, including analyzer-supplied `ownership_roots`
  that become `analyzer-ownership-root-link` graph references
- contract-suite links for small JSON Schema, workflow, package-script, or
  TypeScript type suites when planner metrics show otherwise weak packets
- external boundary hints
- line counts and anchor summaries for large files

Keep deep analyzers optional: a repository should still produce useful packets
from manifests, paths, tests, and external analyzer results when a language has
only fallback support. Command-backed analyzers should prove project intent
before running — prefer repo-local config checks (`eslint.config.*`, `.eslintrc*`,
`package.json` `eslintConfig`) over executing a globally installed tool and
parsing its no-config failure.

Language-agnostic semantic affinity is useful for ranking adjacent context but
should stay low-authority: don't let shared token frequency alone force packet
merges; use it for `boundary_files` or candidate explanations unless a
deterministic edge corroborates the relationship.

## Production readiness

Drive priorities from field trials, not speculation: run representative
repositories through planning, validate the bundle (`audit-code validate`), and
compare `audit_plan_metrics.json` (packet count, weak-packet count, cohesion,
merge/boundary edge kinds) across runs. Promote an extractor or planner change
when those metrics expose a deterministic gap — and prefer improving shared
graph resolution or generic analyzer ownership roots before adding another
ecosystem-specific parser.

Before treating a build as production-ready, verify the full review loop in one
real host (`prepare-dispatch` → worker reviews each packet → `submit-packet` →
`merge-and-ingest` → `validate`), then run `npm run verify:release` from a clean
checkout. On Windows, runtime validation runs package-manager shims (`npm`,
`npx`, `pnpm`, `yarn`) through the command shell so `.cmd` wrappers execute
reliably — keep that covered when changing runtime command execution. If the
final `audit-report.md` cannot be copied into the target repo due to local
permissions, completion still succeeds and the artifact copy is authoritative.
</content>
