# INV-1 — Deterministic-analysis levers: build / defer / reject decision memo

> Investigation deliverable for INV-1 (`docs/remaining-specs.md` §"Later-feature
> investigations"). This memo **decides per lever** and builds nothing: no
> analyzer is implemented and no runtime dependency is added this run. Each
> `build` lever below becomes its own committed spec. The `defer`/`reject` calls
> record *why now is not the time*, so a future session re-opens them with the
> rationale already paid for.

## Why this investigation exists

Audit signal today leans on LLM judgment per task. Static analysis is cheaper,
reproducible, and **grounded by construction** — a deterministic run is the same
bit every time, which is exactly what tier-2 anchor grounding already trades on
(`src/audit/validation/anchorGrounding.ts`: re-run `madge`/`grep`, the tool's run
is the confirmed bit, never the model's word). INV-1 asks: which deterministic
levers should *produce* audit artifacts directly, rather than only *verify* a
model claim after the fact.

The constraint is fixed by CLAUDE.md and restated in the spec: every new analyzer
**enriches the shared language-neutral artifacts via the adapter-normalize
pattern** — it must not fork planning logic per ecosystem. So every `build`
decision below is forced to name (a) the shared artifact it enriches and (b) the
adapter seam it routes through. A lever that cannot name both is not a candidate.

## The two integration seams (what every lever must plug into)

Two seams already exist; new levers reuse them, they do not invent a third.

**Seam A — external-analyzer → `ExternalAnalyzerResults` → graph/risk.**
`src/audit/adapters/normalizeExternal.ts` exposes
`normalizeGenericExternalResults(tool, items)`, the single funnel every adapter
(`adapters/semgrep.ts`, `adapters/eslint.ts`, `adapters/npmAudit.ts`) maps native
tool JSON into. Output is the zod-`.strict()` `ExternalAnalyzerResults`
(`src/audit/types/externalAnalyzer.ts`): `{ tool, generated_at?, ownership_roots?,
tool_statuses?, results[] }`, where each `results[]` item is
`{ id, category, severity, path, line_start?, line_end?, summary, rule?, raw? }`.
Malformed input degrades (rows missing `path`/`summary` are dropped with a
`normalizer_findings_dropped` stderr event) — the normalizer never throws. This
is the **risk/finding** seam: items flow into the risk register and audit
findings as deterministic, pre-grounded results.

**Seam B — `ExternalAnalyzerResults.ownership_roots` → `GraphBundle` edges.**
`src/audit/extractors/graph.ts` already consumes one analyzer output as graph
edges: `extractAnalyzerOwnershipEdges(externalAnalyzerResults, pathLookup)`
(graph.ts:174) reads `ownership_roots[]` and pushes
`kind: "analyzer-ownership-root-link"` edges into the `references` channel. The
`GraphBundle` edge shape it targets is the language-neutral contract: `graphs: {
imports, calls, references, routes, heuristics }`, each edge a `GraphEdge =
{ from, to, kind, direction?, confidence?, reason? }`
(`src/shared` graph types; deduped/sorted by `uniqueSortedEdges`). This is the
**graph** seam: any lever whose output is *relationships between files/symbols*
lands here as additional `GraphEdge[]` in the appropriate channel, with a stable
`kind` literal added to the `EDGE_KIND` table and a `confidence` constant.

A lever is **graph-shaped** (Seam B) if it yields edges (dependencies, calls,
dataflow), **risk-shaped** (Seam A) if it yields per-location findings
(dead code, complexity, rule violations). Some levers are both.

## Placement axis — in-process pure-JS vs MCP

The spec's placement rule: **prefer in-process pure-JS adapters** (reproducible,
OS-agnostic, no native build, no network), **reserve MCP for engines that
genuinely need it**. Decode that into three concrete placements:

- **In-process pure-JS library** — the engine ships as a pure-JS npm package we
  import and call directly (no child process). Cleanest: OS-agnostic by
  construction, deterministic, no PATH discovery. Cost: a runtime dependency
  (governed by the two-tier dependency policy — fine for a vetted pure-JS parser
  on a correctness-sensitive grammar).
- **In-process via the allowlisted read-only runner** — the engine is a CLI we
  shell *through the existing read-only allowlist*
  (`src/shared/tooling/allowlistedExec.ts` → `runAllowlistedReadOnlyCommand`,
  argv-only, env-stripped, timeout-killed). No runtime dep; tool may be absent →
  the lever degrades to empty. Already proven for `madge`, `ast-grep`, `grep`,
  `rg`, read-only `git` (all in the allowlist today; `anchorGrounding.ts`
  consumes them).
- **MCP** — the engine is a heavy external service (database build, multi-minute
  scan, its own runtime) that cannot live in-process. Reserved; nothing in INV-1
  ships here this run.

OS-agnostic discipline (CLAUDE.md): a shelled CLI must route command resolution
through `resolveWindowsShimSpawnCommand` and paths through the `.audit-tools`
path module — never a baked `node_modules/.bin/...` string.

---

## Per-lever decisions

### L1 — Promote `madge` to a graph-edge extractor · **BUILD**

- **Decision: build** (own spec). Highest-value, lowest-risk lever — the tool is
  already on the read-only allowlist (`allowlistedExec.ts:137`) and already
  shelled in `anchorGrounding.ts`; promoting it from *verifier* to *extractor* is
  additive and the precedent (`extractAnalyzerOwnershipEdges`) already exists.
- **Enriches:** `GraphBundle` (Seam B). `madge --json src` yields the
  import/dependency adjacency; map each `from → to` to a `GraphEdge` in the
  `imports` channel with a new `kind: "madge-dependency"` (add to `EDGE_KIND`) and
  a dedicated confidence constant. `madge --circular --json` yields cycles →
  emit as a `risk_register` entry (Seam A) flagging an architecture smell, *or* a
  `heuristics`-channel edge annotated `reason: "participates in import cycle"`.
- **Adapter seam:** a thin `adapters/madge.ts` parsing madge's JSON into either
  `GraphEdge[]` (graph) or `normalizeGenericExternalResults("madge", …)` (risk),
  mirroring `adapters/semgrep.ts`. Degrade-to-empty on absent tool / non-zero
  exit / parse error, same as the normalizer contract.
- **Placement:** in-process via the allowlisted runner. madge is not pure-JS
  enough to vendor (it has its own resolution stack) but is already a sanctioned
  read-only CLI — no new runtime dep, no new allowlist entry.
- **Note:** madge counts type-only edges (recorded in `advanceTypes.ts:14`,
  ARC-1fa005bb). The extractor must tag or filter type-only edges so the graph
  doesn't over-report runtime coupling — fold this into the spec's acceptance.

### L2 — AST / structural matching (tree-sitter / ast-grep) · **BUILD (ast-grep), DEFER (tree-sitter)**

- **Decision: build the `ast-grep` lever; defer raw tree-sitter.** `ast-grep`
  (and its `sg` alias) is **already on the read-only allowlist**
  (`allowlistedExec.ts:150`) and already cited in the worker prompt as a sanctioned
  anchor tool (`prompts/renderWorkerPrompt.ts:58`). A structural-pattern extractor
  that runs curated `ast-grep --pattern … --json` queries and normalizes the hits
  is the natural promotion — same verifier→extractor move as L1.
- **Enriches:** both seams. Structural *relationships* (e.g. "call site of X",
  "registration of route handler Y") → `GraphBundle` `calls`/`references` edges
  (Seam B). Structural *smells* (e.g. "forbidden API used here") → per-location
  risk findings via Seam A. This is also where the spec's "mine
  ralph-architecture-sweep heuristics re-expressed as graph queries" lands: a
  repeated call-site signature becomes an `ast-grep` pattern whose hits are graph
  edges, not an LLM judgment.
- **Adapter seam:** `adapters/astGrep.ts` → `GraphEdge[]` or
  `normalizeGenericExternalResults("ast-grep", …)`.
- **Placement:** ast-grep in-process via the allowlisted runner (no new dep).
  **Defer tree-sitter (in-process pure-JS via WASM grammars):** strictly more
  capable (full typed AST, arbitrary queries, no per-pattern CLI spawn) and the
  ideal long-term endpoint, but it is a real build — grammar selection per
  language, a query DSL, and a non-trivial dependency surface — that should not
  ride L1/L2's coattails. Defer to its own spec *after* the ast-grep lever proves
  the structural-edge shape is useful; the ast-grep adapter output shape is the
  contract tree-sitter would later satisfy in-process.

### L3 — Dead-code / unused-export (knip, ts-prune) · **DEFER**

- **Decision: defer.** Genuinely valuable (unused exports are a real
  maintainability finding and a strong deletion-test signal), and the spec
  explicitly wants ralph's "deletion test → low-in-degree nodes" re-expressed
  deterministically. **But** the cleanest expression of "is this export used"
  is a *graph query over the L1 madge import graph* (an export with zero inbound
  `imports` edges is a dead-export candidate), not a second external tool.
- **Why defer, not build now:** building knip/ts-prune as adapters duplicates
  reachability that L1's graph already encodes, and both are TS/JS-only (fights
  the language-neutral invariant — they cannot enrich the graph for a Go or Rust
  repo). Sequence **after L1**: first land the madge import graph, then add a
  deterministic *graph-query* dead-export detector over it (Seam A: emit
  low-in-degree exported symbols as risk findings). If that graph-query proves
  insufficient (e.g. needs type-aware usage that madge can't see), *then* revisit
  importing knip as a pure-JS in-process library in its own spec.
- **Enriches (when built):** `risk_register` (Seam A) for the findings;
  conceptually reads the L1 `GraphBundle.imports` channel as input.
- **Placement (when built):** in-process pure-JS — knip is a pure-JS library and
  would be imported, not shelled — but only after the graph-query alternative is
  ruled out.

### L4 — Complexity / duplication metrics · **DEFER**

- **Decision: defer.** Per-function cyclomatic complexity and duplicate-block
  detection are legitimate maintainability/risk signals and map cleanly onto
  Seam A (each is a per-location finding with a `severity`). Deferred not because
  it's wrong but because it is **lower-priority than the graph levers** (L1/L2)
  and adds the least *new* structural information — it re-scores files the audit
  already visits rather than revealing hidden relationships.
- **Why defer:** complexity is only actionable as a *threshold* policy
  (what counts as "too complex"), which is a judgment call that needs an explicit
  configured contract, not a hardcoded number — that design is the spec, and it
  shouldn't block L1/L2. Duplication detection (token-window hashing) is a small
  pure-JS build but, again, ranks below the graph work.
- **Enriches (when built):** `risk_register` (Seam A), one finding per
  over-threshold unit / duplicate cluster.
- **Placement (when built):** in-process pure-JS (complexity from a pure-JS AST
  walk; duplication from a rolling-hash over normalized tokens — no external
  engine, no network, OS-agnostic).

### L5 — Type-coverage · **DEFER**

- **Decision: defer.** "What fraction of the codebase is typed / `any`-free" is a
  real maintainability metric, but it is **TS-specific** (fights language-neutral)
  and overlaps the existing `npm run check` typecheck signal. Low marginal value
  over what the audit already knows from a clean typecheck.
- **Why defer:** to enrich the language-neutral artifacts honestly, type-coverage
  would have to generalize to "static-confidence coverage" across ecosystems,
  which is a bigger contract than a TS `type-coverage` wrapper. Until that
  generalization is wanted, this stays deferred rather than shipping a TS-only
  metric that the planning logic would then have to special-case.
- **Enriches (when built):** `risk_register` / audit summary (Seam A) as a
  repo-level maintainability metric.
- **Placement (when built):** in-process pure-JS (the `type-coverage` engine is
  pure-JS) — but only behind a language-neutral coverage contract.

### L6 — Broader semgrep rulepacks · **BUILD**

- **Decision: build** (own spec, small). The semgrep adapter **already exists**
  (`adapters/semgrep.ts` → Seam A); this lever is not a new analyzer, it is
  *configuration breadth* — curate and ship a broader, security-and-correctness
  ruleset (and let operators point at their own packs) so the existing adapter
  produces more signal. Lowest-effort `build` on the list.
- **Enriches:** `risk_register` / audit findings (Seam A) — unchanged path, more
  results. Severity already normalizes through `normalizeSemgrepSeverity` →
  `normalizeGenericExternalResults`.
- **Adapter seam:** existing `adapters/semgrep.ts`; no new code beyond rulepack
  selection/config and possibly surfacing `tool_statuses` when a pack fails to
  resolve.
- **Placement:** in-process via the allowlisted runner (semgrep is already the
  shelled precedent). Keep packs operator-configurable — never hardcode a fixed
  ruleset as the only option.

### L7 — CodeQL for dataflow · **REJECT (this round; MCP-only if ever)**

- **Decision: reject for now.** CodeQL is the one lever the spec itself flags for
  MCP ("reserve MCP for engines that need it (CodeQL)"). It requires building a
  per-language database, runs for minutes, ships a large non-pure-JS toolchain,
  and is license-gated for some uses — it cannot live in-process and violates the
  "reproducible, OS-agnostic, no-network, fast" default that every other lever
  satisfies.
- **Why reject vs defer:** dataflow-grade taint analysis is genuinely beyond the
  regex/AST levers, so the *capability* is not rejected forever — but as an
  **in-tree** analyzer it is the wrong shape, and the cheaper levers (L1/L2/L6)
  must prove the enrichment pipeline first. If a dataflow lever is ever wanted, it
  enters as an **MCP** engine behind Seam A (its alerts normalized into
  `ExternalAnalyzerResults` exactly like semgrep), not as a bundled dependency.
- **Enriches (if ever):** `risk_register` (Seam A) via an MCP boundary.
- **Placement:** MCP only — explicitly *not* in-process.

---

## Decision summary

| Lever | Decision | Shared artifact (seam) | Adapter | Placement |
|---|---|---|---|---|
| L1 madge → graph-edge extractor | **build** | `GraphBundle` (B); cycles → `risk_register` (A) | new `adapters/madge.ts` | in-process, allowlisted runner |
| L2a ast-grep structural matching | **build** | `GraphBundle` calls/references (B); smells → risk (A) | new `adapters/astGrep.ts` | in-process, allowlisted runner |
| L2b tree-sitter (typed AST) | **defer** | `GraphBundle` (B) — same shape as L2a | (future, in-process) | in-process pure-JS (WASM) |
| L3 dead-code / unused-export | **defer** | `risk_register` (A); reads L1 `imports` | graph-query first; knip later | in-process pure-JS |
| L4 complexity / duplication | **defer** | `risk_register` (A) | future pure-JS | in-process pure-JS |
| L5 type-coverage | **defer** | risk / summary (A) | future pure-JS | in-process pure-JS |
| L6 broader semgrep packs | **build** | `risk_register` (A) | existing `adapters/semgrep.ts` | in-process, allowlisted runner |
| L7 CodeQL dataflow | **reject** (MCP-only if ever) | `risk_register` (A) | future MCP normalizer | MCP only |

**Build now (each its own spec):** L1 (madge extractor), L2a (ast-grep
structural), L6 (broader semgrep packs) — all three reuse an existing
allowlisted CLI and an existing seam, so each is additive and language-respecting.

**Sequence:** L1 first (it is the import graph that L3 and the ralph
deletion-test heuristic depend on), then L2a (structural edges / re-expressed
heuristics), then L6 (config breadth) in parallel. L3/L4/L5 are deferred *behind
L1* — most are best expressed as graph queries over L1's output or as
language-neutral contracts not yet specified. L7 stays out-of-tree (MCP) and
waits on the in-process pipeline proving itself.

**Invariant check.** Every `build`/`defer` lever above names its target shared
artifact and the adapter-normalize seam it routes through, and states its
dependency-tier placement (in-process pure-JS vs allowlisted-runner vs MCP). No
lever forks planning per ecosystem: graph levers add `GraphEdge` kinds to the one
language-neutral `GraphBundle`; risk levers add `ExternalAnalyzerResults` items
through the one `normalizeGenericExternalResults` funnel. madge is consistently
the L1 graph extractor here and the tier-2 anchor verifier in
`anchorGrounding.ts` — same tool, two roles, one allowlist entry.
