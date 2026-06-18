# A12 — single-package collapse plan

> Collapse `@audit-tools/shared` + `auditor-lambda` (packages/audit-code) + `remediator-lambda`
> (packages/remediate-code) → ONE published package **`audit-tools`** (name free on npm),
> two bins (`audit-code`, `remediate-code`), shared **inlined**. One install / publish / version line.
> Decisions: Ethan 2026-06-18 — shared *inlined into one src tree*; old names *deprecated+redirected*.
> Endpoint after: reach a clean publishable milestone → publish → dogfood remediate-code on the rest.

## Target layout (repo root = the package)

```
/ (package "audit-tools", private:false, two bins)
  package.json            # name audit-tools; bin{audit-code,remediate-code}; exports self-ref ./shared(/*)
  tsconfig.json           # one project; rootDir src; outDir dist; paths audit-tools/shared(/*) -> src/shared
  vitest.config.ts        # remediate tests
  audit-code.mjs / remediate-code.mjs + audit-code-wrapper-*.mjs    # bins at root, resolve dist/audit|remediate
  src/shared/   src/audit/   src/remediate/
  dist/shared/  dist/audit/  dist/remediate/
  tests/shared/ tests/audit/ tests/remediate/
  schemas/ dispatch/ templates/ skills/{audit-code,remediate-code}/ scripts/ docs/ spec/
  (no packages/, no workspaces)
```

## Import strategy — SELF-REFERENCE (not relative rewrite)

- Global string replace `@audit-tools/shared` → `audit-tools/shared` across all `.ts`/`.mjs` (src+tests+wrappers).
  Same specifier shape, depth-independent → one substitution, not 360 per-file relative paths.
- package.json `exports`: `"./shared": {types,default -> dist/shared/index.*}`, `"./shared/*": dist/shared/*.js`.
  Node self-referencing resolves `audit-tools/shared` by the package's own `name`+`exports` (no node_modules needed).
- tsconfig `paths`: `audit-tools/shared` -> `src/shared/index.ts`, `audit-tools/shared/*` -> `src/shared/*.ts`
  (typecheck resolves to SOURCE; emitted JS keeps the specifier; runtime self-resolves via exports). tsc never
  rewrites specifiers, so this is consistent dev + installed-global.
- Deep import in use: `@audit-tools/shared/quota/compositeQuotaSource` (2 files) → covered by `./shared/*`.

## Build / test

- One `tsc -p tsconfig.json` compiles shared+audit+remediate together → `dist/{shared,audit,remediate}`.
- No project references / composite / shared-built-first ordering (single compile).
- Tests: node:test (`tests/shared/*.test.mjs`, `tests/audit/*.test.mjs`) + vitest (`tests/remediate/*.test.ts`).
  `npm test` runs build then both runners. Keep them separate (don't port runners — out of A12 scope).

## Phases (each ends GREEN: shared build N/A, `npm run build && npm run check` + touched suites)

- **P0 (this doc).** Plan + decisions checkpoint. (cheap commit)
- **P1 — physical collapse (the monster, atomic).** Move src/tests/assets to root layout; rename import
  specifier; one package.json (merged deps/devDeps/scripts/files/bin/exports); one tsconfig + paths; vitest
  config; bins + wrappers repointed (dist/audit|remediate, drop the `@audit-tools/shared` preflight); delete
  `packages/` + workspaces. Verify build+check+BOTH suites green. ONE commit (atomic-replace invariant).
- **P2 — release/publish machinery.** One `scripts/release-and-publish.mjs` (plain `v*` tag), delete
  `scripts/release-changed.mjs` + 3 per-pkg scripts. `publish-package.yml` → one job, `v*` trigger, single
  verify:release. Merge smoke (linked+packaged for both bins) + postinstall (deploy both host assets) under new
  name. Update `files`. Green via local `verify:release` (CLAUDECODE unset).
- **P3 — rename touch-points + docs.** hooks test paths, `.gitignore` patterns, opencode.json permission rules
  (`auditor-lambda`/`remediator-lambda` → `audit-tools`), CLAUDE.md layout table, README, NEW-MACHINE-SETUP,
  ship skill version checks. Backlog + HANDOFF + memory.
- **P4 — publish + deprecate.** Publish `audit-tools` via /ship-equivalent; `npm deprecate auditor-lambda` /
  `remediator-lambda` / `@audit-tools/shared` with redirect message; reinstall global bins.

## EXECUTION STATUS (live checkpoint — branch `a12-single-package-collapse`)

**P1 physical collapse: DONE in working tree (uncommitted).** Build + check GREEN. Shared node:test
suite GREEN (724/0/1). Audit node:test suite: 2010 pass / 56 fail / 6 skip (was 167 fail). Remediate
vitest: NOT YET RUN.

Landed so far (working tree):
- Moved src→src/{shared,audit,remediate}, tests→tests/{shared,audit,remediate}, assets to root
  (dispatch, schemas, templates, skills, examples), bins+wrappers→root, scripts→scripts/{audit,remediate,shared},
  docs/audit→docs/audit-pkg, spec→spec/{audit,remediate}, package opencode/AGENTS/README → *.audit/*.remediate.
  Deleted packages/ + workspaces.
- Root package.json (name `audit-tools` 0.28.0, two bins, self-ref exports ./shared(/*), merged deps).
  Root tsconfig.json (paths audit-tools/shared→src/shared). vitest.config (alias + include tests/remediate only).
- Global rename `@audit-tools/shared`→`audit-tools/shared` (src+tests+wrappers, incl. escaped-slash regex forms).
- Bins repointed (dist/audit|remediate/index.js); wrapper-build preflightWorkspace removed.
- SOURCE asset-root depth +1: src/audit/cli/paths.ts, src/audit/io/runArtifacts.ts, src/remediate/index.ts.
- dispatch/validate.mjs import → dist/audit/validation.
- Test transforms (scripts/.a12-*.mjs, all deletable): import depth (+1 ../ +sub), dynamic+multiline imports,
  root-var normalize to repo-root depth, asset-join sites, sourceImport.mjs helper (3-up root, temp pkg.json
  name+exports for self-ref, src→audit map, --declaration/Map/sourceMap false).
- Structural guards updated: shared-core/tests/quota-invariants, single-source x3, id-glossary, git.test;
  retired INV-shared-core-15 (CI shared-first/workspaces) → 15b single-package; INV-core-16 async-typecheck
  → src/(shared|audit|remediate). Rewrote .claude/hooks/async-typecheck.mjs + .github/workflows/ci.yml to
  single-package. TEMP no-op scripts/postinstall.mjs stub (real one = P2).

**REMAINING (the 56 audit fails + P2 + remediate):**
- Cluster D (audit source-scan structural tests): change `join(root,"src",…)` audit-source refs → `src/audit`
  (NOT the tempDir fixture `join(root,"src")` ones). Sites incl. audit-extractors-invariants:20,
  audit-infra-architecture:17/18/27/140 (pkgRoot/repoRoot collapse to root; src→src/audit),
  audit-tests-invariants:239, audit-orchestrator-invariants:28, steps-write-current-step:14, cleanup:239,
  cli-dispatcher:103, + io/artifacts/graphManifestEdges/single-authority/worker-prompt/schema-contracts scans.
- Cluster E (schema tests): schema-contracts.test + "committed worker schemas match generate-schemas.mjs"
  (script now scripts/audit/generate-schemas.mjs; schemas/ at root).
- P2 machinery (author): merged scripts/postinstall.mjs (replace stub; deploy BOTH host asset sets),
  merged scripts/release-and-publish.mjs (plain `v*` tag) + delete scripts/release-changed.mjs + the 3
  namespaced release scripts, merged smoke (4 smoke scripts under scripts/{audit,remediate}/ — repoint to
  single tarball + new package name `audit-tools`), opencode.json merge (root + opencode.audit/remediate.json
  → one), host-asset no-drift (.agent/.github committed copies), session-start.sh, publish-package.yml→one job.
  Tests asserting these: postinstall*(4), smoke contracts, release helper/OIDC/poll-log, CI workflow pins,
  session-start(3), product docs, INV-RCI-16/repo-assets-04/no-drift, "test framework split" ARC-843ce274-2,
  CLAUDE.md file-lock sync, next-step/ingest-results (likely artifact-promotion path).
- Remediate vitest suite: run + fix (same path patterns; templates/ at root, pkgRoot in src/remediate/index.ts).
- Then: full `npm test` + verify:release green → COMMIT the atomic collapse. Then P3 docs / P4 publish+deprecate.

**STATUS UPDATE 2 (this session): shared GREEN (724), remediate GREEN (1607), audit 2110 pass / 17 fail.**
All 17 audit fails are the P2 machinery/docs/CI cluster. Remediate fully fixed (gate command list →
single-package `npm run build`+check+2-unit; `isAuditToolsMonorepo` detects src/{shared,audit,remediate}+bins;
generator script paths; wrapper dist/remediate paths + message; opencode merged into root opencode.json with
BOTH agent.auditor+agent.remediator; root postinstall propagates sub-script failure exit). opencode.audit.json
+ opencode.remediate.json DELETED (root opencode.json is canonical). Merged scripts/postinstall.mjs spawns both
sub-postinstalls and exits non-zero if either fails.

**P2 AUTHORING PROGRESS (this session):**
- DONE: merged `scripts/postinstall.mjs` (runs scripts/{audit,remediate}/postinstall.mjs best-effort);
  both sub-postinstalls path-fixed (pkgRoot dirname×3, `audit-tools/shared`, audit `auditor-lambda`→
  `audit-tools`, remediate `dist/remediate/utils/hostAssets.js`).
- DONE: single `scripts/release-and-publish.mjs` (plain `vX.Y.Z` tag, root-relative, --bump-only/--dry-run,
  verify:release gate, OIDC publish-run wait). Moved poll-log helper → `scripts/poll-log-throttle.mjs`.
  DELETED scripts/release-changed.mjs + the 3 per-pkg release scripts.
- DONE: `.github/workflows/publish-package.yml` → ONE `publish` job, trigger `release` tag `v*` +
  workflow_dispatch (no package choice), OIDC trusted publishing + retry/idempotency + registry-verify preserved.
- REMAINING P2: (1) smoke scripts scripts/{audit,remediate}/smoke-{linked,packaged}-*.mjs — repoint to ONE
  `audit-tools` tarball (was packing shared+pkg separately), new pkg name, dist/audit|remediate paths, asset
  dirs at root, bin names unchanged. (2) opencode.json merge: root opencode.json + opencode.audit.json +
  opencode.remediate.json → decide published form (remediate shipped opencode.json; audit didn't). (3)
  .claude/hooks/session-start.sh (the audit tests for it). (4) .github/workflows/audit-code-test-suite.yml →
  single-package or delete. (5) docs (product docs /audit-code canonical, NEW-MACHINE-SETUP, README). (6)
  host-asset no-drift: .agent/.github committed copies regenerate. (7) remediate vitest suite (path patterns:
  pkgRoot in src/remediate/index.ts already fixed; templates/ at root; tests/remediate import depths already
  done by the transformer — RUN `cd packages... no` → from repo root `npx vitest run` picks tests/remediate
  per vitest.config; verify + fix). (8) green the P2-asserting audit tests (postinstall*, smoke, release,
  OIDC, CI-pins, session-start, opencode INV-RCI-16, no-drift, product docs, CLAUDE.md file-lock sync,
  "test framework split"). (9) P3 docs (CLAUDE.md layout table, backlog, HANDOFF, memory). (10) P4 publish +
  `npm deprecate auditor-lambda/remediator-lambda/@audit-tools/shared` redirect + reinstall global bins.

## Open execution notes / traps
- Filename collisions when merging `scripts/` (both have postinstall.mjs, release-and-publish.mjs, smoke-*.mjs),
  `docs/`, `spec/`, `opencode.json`, `AGENTS.md`, `README.md`. Namespace or merge deliberately.
- audit dist has `dist/cli.js` referenced by smoke required-paths — becomes `dist/audit/cli.js`.
- wrapper-build.mjs: drop `preflightWorkspace`/`assertWorkspaceInstalled` (no shared workspace); repoRoot=root;
  distEntry=dist/audit/index.js; build lock fine.
- `@types/node` version skew (audit ^24 vs remediate/shared ^22) — pick one (^24) in the single devDeps.
- Self-reference + tsconfig paths: confirm `npm run check` resolves to src (not stale dist) — primary risk to verify in P1.
- Green-at-every-commit: P1 can't be split (file moves break build mid-way) → iterate in working tree, commit once green.
```
