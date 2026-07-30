# Release

## Release gate

Run from the repository root:

```bash
npm ci
npm run verify:release
```

`verify:release` runs `verify:checks` first, then the full vitest suite, then both
linked-install smokes. The `verify:checks` half is generated from `package.json`
below — in its real order, so this list cannot drift from the gate:

<!-- BEGIN gate-enumeration — generated from package.json by scripts/check-gate-enumeration.mjs -->

- raw control-byte gate (`check:control-bytes`)
- version-gate scan (`check:version-gates`)
- guard wiring/reach reconciliation (`check:guard-reach`)
- loop-core pattern-list drift check (`check:loop-core-patterns`)
- constitutional-doc-path parity (`check:constitutional-doc-paths`)
- dead-code export gate (`check:deadcode`)
- doc-manifest reconciliation gate (`check:doc-manifest`)
- relative-link resolution gate (`check:doc-links`)
- backticked repo-path citation gate (`check:doc-code-citations`)
- gate-enumeration parity (this list) (`check:gate-enumeration`)
- README philosophy-brief parity (`check:philosophy-brief`)
- nightly scheduler-prompt parity (`check:nightly-routine-prompt`)
- HANDOFF roadmap parity (`check:handoff-roadmap`)
- backlog seek-index parity (`check:backlog-index`)
- memory-citation check (`check:memory-citations`)
- backlog size-budget gate (`check:backlog-budget`)
- backlog status-token gate (`check:backlog-status`)
- test-tree typecheck (`check:tests`)
- TypeScript typecheck (`build`)
- host-install verification (audit) (`verify:hosts`)
- host-install verification (remediate) (`verify:remediate-hosts`)
- single-tarball pack smoke (`pack:smoke`)
- packaged-install smoke (audit-code) (`smoke:packaged-audit-code`)
- packaged-install smoke (remediate-code) (`smoke:packaged-remediate-code`)

<!-- END gate-enumeration -->

…followed by the full automated test suite (`vitest`), then
`smoke:linked-audit-code` and `smoke:linked-remediate-code`.

For live child-process output while debugging smoke tests:

```bash
AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code
AUDIT_CODE_VERBOSE=1 npm run smoke:linked-audit-code
```

The packaged smoke path strips inherited `npm_config_*`, `NODE_AUTH_TOKEN`, and
`NPM_TOKEN` values before nested npm operations so dry runs and smoke installs
do not accidentally inherit publish credentials or suppress tarball generation.

## Host validation — the manual half of the release gate

The automated half of multi-host validation lives in `npm run verify:hosts`
(wired into `verify:release`): it deploys every host surface into an isolated
temp `$HOME` and re-runs each host's own `verify()` handler from the same
`INSTALL_HOST_DEFINITIONS` table the postinstall deploy uses. That gate catches
*our* drift — a missing, unparseable, or canonical-body-diverged asset — before
publish.

This checklist covers only what CI **cannot** reach: actually invoking
`/audit-code` inside a GUI host and confirming a real dispatch round-trips. A GUI
host can change its asset format or command-rendering out from under us; the
no-drift guard does not see that, so a human runs these rows at release. A failed
row becomes a backlog item.

Codex and `agy` are headless CLIs, so they are correctly absent from the GUI-host
table below and their live dispatch is automated instead of listed here — see the
`RUN_PROVIDER_MATRIX_E2E=1`-gated provider-matrix e2e in
`tests/audit/provider-matrix-dispatch-e2e.test.ts` (supersedes the former
per-provider `RUN_CODEX_E2E=1` gate). Run it at release with a live backend
present:

```
RUN_PROVIDER_MATRIX_E2E=1 npx vitest run tests/audit/provider-matrix-dispatch-e2e.test.ts
```

Coverage gap: that e2e currently exercises only `codex` / `opencode` /
`openai-compatible`. `agy` and `claude-worker` have **no live-dispatch e2e coverage**
yet — until a row is added for each, their real dispatch is unverified by any
automated gate (`claude-worker`'s existing test, `tests/shared/claude-worker-provider.test.ts`,
is a local-mock-HTTP-server unit test of transport/argv/env, not a live-dispatch e2e).

### How to run a row

For each GUI host below:

1. **Install** — from a clean repo, run `npm install -g audit-tools` (or the
   local equivalent) so postinstall deploys the host surface, then open the
   repository in the host.
2. **Command appears** — confirm the host registers/offers `/audit-code` (slash
   command, skill, or agent, per the host's setup kind).
3. **One live dispatch** — invoke `/audit-code` and let it run one bounded audit
   step (a single `audit-code next-step` round-trip).
4. **Result lands** — confirm the step's result artifact is written under
   `.audit-tools/audit/` (e.g. `steps/current-step.json` advances and the
   expected artifact for that step appears).

Mark each cell pass / fail; record the release version and date **in the release's own
notes or a `docs/reviews/` record — never by committing a filled copy of the grids below.**
They are a timeless template, like `docs/end-of-sprint-report-template.md`.

### Checklist (one row per GUI host)

| Host | Surface deployed | 1. Install + open | 2. `/audit-code` visible | 3. One live dispatch | 4. Result lands under `.audit-tools/audit/` |
|---|---|---|---|---|---|
| Antigravity | `.agent/skills/audit-code/SKILL.md` skill, `.gemini/commands/audit-code.toml` slash command, planning guide, AGENTS instructions | ☐ | ☐ | ☐ | ☐ |
| OpenCode | global `/audit-code` command (npm-installed) + generated `opencode.json` project permissions | ☐ | ☐ | ☐ | ☐ |
| VS Code | generated prompt file + custom agent + Copilot instructions (`INSTALL_HOST_DEFINITIONS.vscode`, `setup_kind: 'prompt+agent'`) | ☐ | ☐ | ☐ | ☐ |

Notes / failures (file each as a backlog item):

-

### remediate-code checklist (one row per GUI host)

`remediate-code` has its own automated half — `npm run verify:remediate-hosts`
(`scripts/remediate/verify-hosts.mjs`, wired into `verify:release`), the mirror of
the audit gate: it deploys every remediate host surface into an isolated temp
`$HOME` and re-runs each host's `verify()` handler from the same
`INSTALL_HOST_DEFINITIONS` table. As with audit, that gate catches *our* drift but
cannot invoke `/remediate-code` inside a live GUI host — a human runs the rows
below at release, same GUI-host set. Codex / `agy` are headless CLIs and are
automated the same way (correctly absent from this table).

| Host | Surface deployed | 1. Install + open | 2. `/remediate-code` visible | 3. One live dispatch | 4. Result lands under `.audit-tools/remediation/` |
|---|---|---|---|---|---|
| Antigravity | `.agent/skills/remediate-code/SKILL.md` skill, `.gemini/commands/remediate-code.toml` slash command, planning guide, AGENTS instructions | ☐ | ☐ | ☐ | ☐ |
| OpenCode | global `/remediate-code` command (npm-installed) + generated `opencode.json` project permissions | ☐ | ☐ | ☐ | ☐ |
| VS Code | generated prompt file + custom agent + Copilot instructions (`INSTALL_HOST_DEFINITIONS.vscode`, `setup_kind: 'prompt+agent'`) | ☐ | ☐ | ☐ | ☐ |

Notes / failures (file each as a backlog item):

-

## Publication

Publication is operational through GitHub Actions Trusted Publishing.

Workflow:

```text
.github/workflows/publish-package.yml
```

The release gate is split into two parallel jobs — `gate` (`npm run verify:checks`) and `test` (the
vitest suite, sharded 4 ways) — so publish latency is bounded by the slowest gate job rather than their
sum. The `publish` job needs both, then:

- requests `id-token: write` for npm OIDC exchange
- pins the Node and npm versions declared in `.github/workflows/publish-package.yml`
- rebuilds `dist/` for packing (the `gate`/`test` jobs already ran the full verify chain)
- previews the packed tarball with `npm pack --dry-run`
- publishes with public access and provenance
- defaults semver prerelease versions to the `next` dist-tag unless overridden
- verifies that the published version resolves from the registry
- uploads `*-npm-logs` artifacts on failure

Routine CI exercises the Node majors matrixed in `.github/workflows/*.yml` (the matrix there is self-describing).

## Version bump helpers

Use:

```bash
npm run release:patch
```

That bumps the version, updates `package.json` and `package-lock.json`, and
creates the release commit and annotated tag.

Available variants:

- `npm run release:minor`
- `npm run release:major`

Full maintainer flow:

```bash
npm run release:patch:publish
```

That command checks the worktree, runs a fast local typecheck gate (`npm run check` — not the full
`verify:release` suite, which already ran via CI/the `/ship` preflight), bumps the version, commits,
tags, pushes `main` and the tag, creates the GitHub Release, waits for `publish-package.yml`, and
confirms the new npm version resolves.

Minor and major publish variants:

- `npm run release:minor:publish`
- `npm run release:major:publish`

## Manual workflow dispatch

Use GitHub Actions `workflow_dispatch` to exercise or run the publish workflow.

Dry run:

- `dry_run=true`
- `publish_tag=auto`

Live publish:

- `dry_run=false`
- `publish_tag=auto` unless intentionally overriding the dist-tag

`publish_tag=auto` resolves stable versions to `latest` and prerelease versions
to `next`.

Publishing a GitHub Release triggers the same workflow.

## Trusted publisher setup

npm Trusted Publishing is configured for this repository. If repository,
workflow, or ownership details change, keep the npm trusted publisher entry
aligned with:

- owner or organization: `OhOkThisIsFine`
- repository: `audit-tools`
- workflow filename: `publish-package.yml`

## Troubleshooting

If a GitHub Actions run fails:

1. download the uploaded `*-npm-logs` artifact
2. rerun `npm ci` and `npm run verify:release` locally from the same commit
3. for publish failures, rerun `publish-package.yml` with `dry_run=true`
4. confirm npm Trusted Publishing still targets `publish-package.yml`

Post-publish checks:

```bash
npm view audit-tools version
npm view audit-tools dist-tags --json
npm audit signatures
```
