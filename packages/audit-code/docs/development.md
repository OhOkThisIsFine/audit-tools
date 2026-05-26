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

Use `docs/handoff.md` as the current pickup note for the next implementation
agent. It should name the latest completed slice, verification status, files
touched, and the most practical next steps. Keep long-term product direction in
`docs/product.md`; keep transient implementation pickup notes in the handoff.

## Build and test

```bash
npm install
npm run check
npm test
npm run verify:release
```

The test suite is intentionally contract-heavy. Update tests when changing
schema shape, prompt contracts, dispatch behavior, installer output, or release
workflow semantics.

## Production-readiness workflow

Use field trials to decide what to fix next. For each representative repository,
run to the local review handoff, validate the artifact bundle, and compare
`audit_plan_metrics.json` across runs. Track at least packet count, weak packet
count, average cohesion, `merge_edge_kind_counts`,
`boundary_edge_kind_counts`, and `weakly_explained_packet_samples`.

Only promote an extractor or planner change when those metrics expose a
deterministic gap. Prefer improving shared graph resolution or importing
generic analyzer ownership roots before adding another ecosystem-specific
manifest parser.

The latest remediator field trial closed the remaining mixed code/schema/test
weak packet by adding package script links, schema contract test links, bounded
TypeScript type contract suites, package-script-seeded script suite links, and
generated test artifact disposition. Keep future suite links similarly bounded
and evidence-led.

The Polar field trial added `conftest-link` (conftest.py → Python files in
scope) and `pyproject-testpaths-link` (pyproject.toml → conftest.py via
`[tool.pytest.ini_options] testpaths`). `conftest-link` fires only when the
conftest is inside a `isTestPath` directory to avoid O(n) fan-out from
root-level conftests. `pyproject.toml` was also added to `shouldReadForGraph`
so its content is available during the filesystem-backed build path. Together
these raised Polar's average cohesion from 0.625 to 0.857 and reduced weak
packets from 5 to 3.

A second Polar field trial added `yaml-path-reference-link` (YAML/YML files
→ other config files referenced by explicit relative path). Resolution tries
repo-root-relative first, then file-directory-relative. The extractor only
fires for string values ending in `.yaml`, `.yml`, `.json`, or `.toml` that
resolve to an existing repo file. In Polar, this produced 4 edges from
`configs/benchmark.yaml` to its template files and raised `internal_edge_count`
in the `experiments-domains` packet from 90 to 94.

A third Polar field trial added `python-test-util-suite-link`, which chains
`.py` files co-located in `utils/`, `helpers/`, or `support/` subdirectories
within `isTestPath` directories (same bounded-suite pattern as the TypeScript
type, JSON schema, and package-script suite links). `conftest.py` is excluded
from the predicate. In Polar, this produced 2 intra-unit edges within the
`tests-utils` packet, raising its `internal_edge_count` from 0 to 2 and
eliminating it as a weak packet. Polar metrics improved from 0.857 to 1.000
cohesion and 3 to 2 weak packets. The 2 remaining weak packets share genuinely
isolated files (`.auditorignore`, `experiments/domains/__init__.py`,
`experiments/summarize_results.py`) that cannot be linked without false
positives; treat as the current floor. Note that intra-unit suite edges do not
appear in `merge_edge_kind_counts` — their effect is visible in the packet's
`internal_edge_count` and `unexplained_file_count` fields instead.

Before treating a build as production-ready, verify the complete review loop in
one real host:

```text
audit-code prepare-dispatch --run-id <run_id> --artifacts-dir <artifacts_dir>
worker reviews each packet prompt
audit-code submit-packet ...
audit-code merge-and-ingest --run-id <run_id> --artifacts-dir <artifacts_dir>
audit-code validate
```

On Windows, runtime validation runs package-manager shim commands such as
`npm`, `npx`, `pnpm`, and `yarn` through the command shell so `.cmd` wrappers
execute reliably. Keep that behavior covered when changing runtime command
execution.

If the final `audit-report.md` cannot be copied into the target repository
because of local permissions, completion should remain successful and the
artifact copy remains authoritative. Run `audit-code validate` against the
artifact bundle before treating the run as complete.

Then run `npm run verify:release` from a clean checkout.

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
- package/module ownership hints, including analyzer-supplied
  `ownership_roots` that become `analyzer-ownership-root-link` graph references
- contract-suite links for small JSON Schema, workflow, package script, or
  TypeScript type suites when planner metrics show otherwise weak packets
- external boundary hints
- line counts and anchor summaries for large files

Current analyzer priorities:

- planner observability before additional ecosystem breadth
- exercising the generic ownership-root input from analyzers or imported
  evidence
- continued behavior-preserving extraction of high-concentration graph helpers
- JS/TS compiler-backed resolution only after the current regex edges stay
  stable
- Python deterministic support beyond the current local import, package/module,
  and pytest/unittest adjacency edges only where planner metrics show gaps
- generic fallback from path patterns, ctags/tree-sitter, LSP output, or
  external analyzer results when available

Keep deep analyzers optional. Repositories should still produce useful packets
from manifests, paths, tests, and external analyzer results when a language has
only fallback support.

Command-backed analyzers should prove project intent before running. Prefer
repo-local config checks, such as `eslint.config.*`, `.eslintrc*`, or
`package.json` `eslintConfig`, over executing a globally installed tool and
parsing its no-config failure.

Language-agnostic semantic affinity can be useful for ranking adjacent context,
but it should be low authority. Do not let shared token frequency alone force
packet merges; use it for `boundary_files` or candidate explanations unless a
deterministic edge corroborates the relationship.

## Packetization work

The current packetizer groups tasks across lenses and merges graph-connected
task groups within line budgets. Plan metrics now record which graph edge kinds
caused packet merges, which candidate edge kinds stayed as boundary context,
and which packets remain weakly explained. Weak-packet diagnostics aggregate
primary gap counts and unique file-extension counts, while bounded samples
include representative file paths. Together those metrics let real or fixture
runs point at the next deterministic extractor or analyzer-ownership
improvement. The next phase is consolidation and carefully chosen deterministic
depth:

- use packet-quality observations to prioritize extractor gaps
- keep manifest/project-file edge extraction isolated from packet planning code
- use the generic ownership-root contract before adding more ecosystem-specific
  module formats
- keep bounded suite edges as contract evidence, not as a generic
  same-directory merge rule
- exercise the Python import, package layout, and test/source edges against
  fixture and real repositories before adding deeper Python framework handling

Keep `AuditTask` as the coverage identity and `AuditResult[]` as the ingestion
contract.

## File-splitting priorities

The largest implementation files should be split conservatively and
behavior-preservingly:

- move CLI command families out of `src/cli.ts`
- move language metadata tables out of file inventory logic
- move graph manifest/project-file parsers out of `src/extractors/graph.ts`
- split selective-deepening task builders by trigger type
- keep packetization, recovery, and schema changes easier to review

Run the focused tests for each area before and after a split, then run
`npm test`.
