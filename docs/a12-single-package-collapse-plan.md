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
