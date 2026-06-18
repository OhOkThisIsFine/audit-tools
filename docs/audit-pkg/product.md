# Product

> Normative definition: [`spec/audit-goals.md`](../spec/audit-goals.md) — product
> identity, invariants, deterministic/LLM boundaries, and completion. This page is
> the product overview.

## Canonical surface

The primary product is `/audit-code` in conversation.

Normal product usage should:

- use the active conversation model by default
- use project files and attached repository context by default
- avoid manual paths, provider flags, and model-selection arguments
- keep semantic review with the active conversation agent by default
- advance the audit automatically until it completes or no further automatic progress is possible

The CLI is backend infrastructure, a local development harness, and a repo-local
fallback. It is not the preferred end-user mental model.

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

Packet quality should not depend on one language ecosystem. Every language
analyzer must write into the same language-neutral graph and artifact contracts;
JS/TS and Python get the richest early support only because they are common.

Do not keep expanding support by adding one bespoke parser per ecosystem unless
there is concrete repository demand or a high-value deterministic signal. Prefer
making graph planning observable and extensible through generic ownership hints
over an open-ended list of file-format handlers.

The shared graph should model:

- file dependencies
- module/package ownership
- test-to-source relationships
- entrypoint-to-handler relationships
- config, schema, migration, workflow, and deployment relationships
- external boundary crossings such as HTTP, queues, databases, filesystems, and
  subprocesses
- edge confidence, direction, and reason

Graph evidence is tiered, strongest first:

- deterministic directed edges (imports, entrypoints, route handlers,
  test/source links, resolved analyzer references)
- deterministic ownership edges (package, module, project, or subsystem roots)
- analyzer-supplied ownership roots, normalized into graph reference edges
- language-agnostic semantic affinity (shared unusual domain terms, nearby
  paths, identifier overlap, embeddings)

Semantic affinity can rank `boundary_files`, explain possible context, and
highlight missing extraction — but it must not merge packets on frequency alone,
because common tokens (`user`, `request`, `client`, `config`, `error`) connect
unrelated code.

The fallback must stay useful even when a language has no deep analyzer:
manifests, path structure, tests, config, and external analyzer output can seed a
graph with lower-confidence edges. Deterministic tool runners should be
project-config aware — e.g. ESLint syntax-resolution runs only when the repo has
local ESLint configuration, not merely because the binary is installed.

## Packet planning

`AuditTask` is the deterministic coverage identity; `ReviewPacket` is the
worker-facing unit of understanding. Packetization aims for packets that read as
coherent code-ownership or execution-flow units, not merely budget-sized bundles:

- build packets around coherent subsystems and execution flows
- keep shared fan-in files visible as context rather than merging large parts of
  the repo into one packet
- distinguish strong (deterministic) edges from weak or heuristic ones
- group tests with the code they verify when it aids review
- carry packet rationale, key edges, entrypoints, and boundary files
- prefer the generic ownership-root contract (analyzers naming module roots) over
  a new parser per ecosystem, and keep graph/manifest parsing modular

Planner observability (`audit_plan_metrics.json`: cohesion, fan-in/out, boundary
crossings, weak-packet gaps) is how extraction gaps are found and prioritized.

## Non-goals

- repositioning the CLI as a peer product surface
- making session config the normal way to redirect semantic review into a
  second external LLM
- making backend implementation details outrank the conversation contract
- tying packetization quality to one programming language
