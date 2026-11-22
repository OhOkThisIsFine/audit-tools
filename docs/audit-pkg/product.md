# Product

> Normative definition:
> [`spec/audit/audit-goals.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/spec/audit/audit-goals.md)
> — product identity, invariants, deterministic/LLM boundaries, and completion.
> This page is the product overview. (The `spec/` corpus is repository-only and
> is not part of the published package, so the link is absolute.)

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
2. `npm install -g audit-tools` as the one-time package install
3. `audit-code prompt-path` to locate the packaged prompt asset
4. the installer verbs below, for bootstrap, repair, and post-install verification
5. `audit-code` as the repo-local backend fallback

<!-- BEGIN GENERATED CLI SURFACE — scripts/shared/generate-cli-surface.mjs — DO NOT EDIT BY HAND -->

> Rendered from `wrapper/installer-verb-help.mjs` — the module both shipped bins read to answer
> `<verb> --help`. Add a verb there and this list follows.

- `audit-code ensure` — lazily bootstraps repo-local /audit-code assets when they are missing or stale
- `audit-code install` — bootstraps /audit-code into supported repo-local host surfaces
- `audit-code install-host` — installs repo-local /audit-code assets for Copilot (--host copilot)
- `audit-code verify-install` — smoke-tests the generated /audit-code host assets after an install

<!-- END GENERATED CLI SURFACE -->

This is the one home for that list — `operator-guide.md` points here rather than
restating it.

Anything below `dist/` is backend or development interface.

## Product model

The intended workflow is:

1. The user invokes `/audit-code`.
2. The prompt runs `audit-code ensure --quiet`.
3. `audit-code next-step` builds or refreshes the artifacts and names the
   current prompt to follow.
4. When the backend emits a question review, the active conversation uses its
   native review facilities (or answers itself as directed) and submits the
   bound question answers.
5. The backend accepts eligible answers, carries forward their limitations, and
   emits the next step. Continue until the current prompt says to stop.
6. The final `audit-report.md` distinguishes findings, answered questions
   without findings, and incomplete evidence. A static answer does not imply that
   a runtime check ran.

Semantic execution belongs entirely to the active host conversation. audit-tools
does not configure, rank, probe, instantiate, or account for execution backends;
it emits bounded work and validates the returned records.

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

Semantic affinity is the weakest tier by conviction: see *Three analyzer convictions have ONE
home* in `CLAUDE.md` (standing decisions) for what it may and may not decide.

The fallback must stay useful even when a language has no deep analyzer:
manifests, path structure, tests, config, and external analyzer output can seed a
graph with lower-confidence edges. Deterministic tool runners should be
project-config aware — e.g. ESLint syntax-resolution runs only when the repo has
local ESLint configuration, not merely because the binary is installed.

## Question planning

The selected lenses determine what needs to be answered. Plans attach questions
to scoped inventory and evidence, rather than treating every file as an
independent review obligation. Graph edges and ownership can help group related
evidence and point the reviewer toward callers, boundaries and tests. Suggestions
are not proof of coverage; the submitted answer records what was actually
inspected and what could not be established.

## Non-goals

- repositioning the CLI as a peer product surface
- making backend implementation details outrank the conversation contract
- tying packetization quality to one programming language
