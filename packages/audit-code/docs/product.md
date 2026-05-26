# Product

## Canonical surface

The primary product is `/audit-code` in conversation.

Normal product usage should:

- use the active conversation model by default
- use project files and attached repository context by default
- avoid manual paths, provider flags, and model-selection arguments
- keep semantic review with the active conversation agent by default
- advance the audit automatically until it completes or no further automatic progress is possible

The CLI is backend infrastructure, a local development harness, and a
repo-local fallback. It is not the preferred end-user mental model.

## Supported surfaces

The supported user-facing surfaces are:

1. `/audit-code` in conversation
2. `npm install -g auditor-lambda` as the one-time package install
3. `audit-code prompt-path` to locate the packaged prompt asset
4. `audit-code ensure` for idempotent repo-local bootstrap
5. `audit-code install` for explicit repair or force refresh
6. `audit-code` as the repo-local backend fallback

Anything below `dist/index.js` is backend or development interface.

## Product model

The intended workflow is:

1. The user invokes `/audit-code`.
2. The prompt runs `audit-code ensure --quiet`.
3. Deterministic backend steps build or refresh artifacts.
4. The active conversation dispatches bounded review packets when semantic
   judgment is required.
5. Packet workers submit validated `AuditResult` objects through backend-owned
   commands.
6. The backend ingests results, performs selective deepening and runtime
   validation when needed, and writes the final `audit-report.md`.

Semantic review belongs to the active host conversation by default. Backend
provider adapters such as `claude-code`, `opencode`, `subprocess-template`, and
`vscode-task` are compatibility bridges for repo-local fallback workflows.

## Language strategy

Packet quality should not depend on one language ecosystem. JavaScript,
TypeScript, and Python can receive the richest early support because they are
common in current usage, but every language analyzer must write into the same
language-neutral graph and artifact contracts.

Do not keep expanding support by adding one bespoke parser per ecosystem unless
there is concrete repository demand or a high-value deterministic signal. The
current breadth of package and workspace manifest hints is enough to validate
the packetization approach. The next product goal is to make graph planning
observable, maintainable, and extensible through generic ownership hints rather
than through an open-ended list of file-format handlers.

The shared graph should model:

- file dependencies
- module/package ownership
- test-to-source relationships
- entrypoint-to-handler relationships
- config, schema, migration, workflow, and deployment relationships
- external boundary crossings such as HTTP, queues, databases, filesystems, and
  subprocesses
- edge confidence, direction, and reason

Graph evidence should be treated in tiers:

- deterministic directed edges, such as imports, entrypoints, route handlers,
  test/source links, and resolved analyzer references
- deterministic ownership edges, such as package, module, project, or subsystem
  roots
- analyzer-supplied ownership roots, normalized into graph reference edges
- language-agnostic semantic affinity, such as shared unusual domain terms,
  nearby paths, identifier overlap, or embeddings

Semantic affinity can help rank `boundary_files`, explain possible context, and
highlight missing deterministic extraction. It should not merge packets on
frequency alone because common tokens like `user`, `request`, `client`,
`config`, and `error` often connect unrelated code.

Language-specific adapters should enrich the graph without changing packet or
result contracts:

- JS/TS: TypeScript compiler API, package manifests, import/export edges, route
  conventions, test adjacency
- Python: local import statement parsing, package/module resolution,
  pytest/unittest adjacency, and future framework route conventions
- Other ecosystems: prefer analyzer-supplied ownership roots, ctags/tree-sitter,
  LSP output, or existing external analyzer data before adding new bespoke
  manifest parsers

The fallback should remain useful even when a language has no deep analyzer:
manifest files, path structure, tests, config, and external analyzer output can
still seed a graph with lower-confidence edges.

Deterministic tool runners should be project-config aware. For example, ESLint
syntax-resolution should run only when the repository has repo-local ESLint
configuration, not merely because an ESLint binary is installed.

## Packet planning

`AuditTask` remains the deterministic coverage identity. `ReviewPacket` is the
worker-facing unit of understanding.

The next packetization phase should:

- use planner observability to tune which edge kinds change grouping, which
  files stay boundary-only, and which extractor gaps leave weakly explained
  packets
- extend and exercise the generic ownership-root input so external analyzers
  can say "these files belong to module root X" without a new parser for every
  ecosystem
- keep graph and manifest parser code modular before broadening it further
- exercise deterministic Python import, package, and test/source graph support
  on fixture and real repositories to find the next highest-value gaps
- use language-agnostic semantic affinity only as low-authority context unless
  corroborated by deterministic graph evidence
- build packets around coherent subsystems and execution flows
- keep shared fan-in files visible as context instead of letting them merge too
  much of the repository into one packet
- distinguish strong edges from weak or heuristic edges
- group tests with the code they verify when that helps review quality
- include packet rationale, key edges, entrypoints, and boundary files
- track packet-quality metrics such as cohesion, fan-in/fan-out, boundary
  crossings, orphan tasks, weak-packet gap and extension counts, risk
  concentration, and largest unexplained packet

The practical success bar is that packets feel like reviewable code ownership
or execution-flow units, not merely budget-sized bundles.

## Production readiness

The package publication path is operational. The release gate, packaged install
smoke tests, and GitHub Actions Trusted Publishing path are routine
maintenance. The remaining production work is product confidence rather than a
new contract shape.

Readiness should be judged through three checks:

- field-trial quality: run real repositories through planning, validate
  artifacts, and use `audit_plan_metrics.json` to track packet count, weak
  packet count, average cohesion, merge edge kinds, and weak-packet samples
- full-loop behavior: prove `next-step` capability routing, packet dispatch,
  worker review, `submit-packet`, `merge-and-ingest`, selective deepening,
  runtime validation, and final `audit-report.md` promotion in at least one
  real host flow
- release hygiene: keep `npm run verify:release`, linked smoke, packaged
  smoke, tarball preview, and Trusted Publishing green from a clean checkout

Extractor work should follow field-trial evidence. Fix deterministic graph gaps
when metrics show them, prefer analyzer-supplied ownership roots before new
manifest parsers, and keep semantic affinity as context unless deterministic
evidence corroborates it.

The current production-readiness focus is:

- use the remediator packet-dispatch loop and Polar runtime-confirmed loop as
  regression evidence for Windows runtime execution, runtime follow-up, final
  synthesis, and report-promotion behavior
- use the remediator contract-link field trial as regression evidence that
  small schema, workflow, package script, and type contract suites can become
  graph evidence without broad directory merges
- rerun `remediator-lambda` after its Windows `EBUSY` test cleanup issue is
  fixed
- keep exercising analyzer ownership roots on real repositories before adding
  ecosystem-specific manifest parsers
- keep host setup claims aligned with verified Codex, Claude Desktop, OpenCode,
  VS Code, and Antigravity behavior
- split high-concentration implementation files only after the packetization
  and schema contracts stay easy to review

## Non-goals

- repositioning the CLI as a peer product surface
- making session config the normal way to redirect semantic review into a
  second external LLM
- making backend implementation details outrank the conversation contract
- tying packetization quality to one programming language
