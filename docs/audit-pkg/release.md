# Release

The maintainer land-and-publish flow — release gate, publication, version bumps —
is owned by the ship skill (`.claude/skills/ship/SKILL.md`), including the
generated gate-step list. `npm run release:patch` bumps + tags;
`npm run release:patch:publish` runs the full flow (`release:minor` /
`release:major` variants likewise). Routine CI exercises the
Node majors matrixed in `.github/workflows/*.yml` (the matrix there is
self-describing).

This page keeps what the skill does not carry: manual host validation, manual
workflow dispatch, trusted-publisher configuration, and troubleshooting.

## Host validation — the manual half of the release gate

The automated half of multi-host validation lives in `npm run verify:hosts`
(wired into `verify:release`): it deploys every host surface into an isolated
temp `$HOME` and re-runs each host's own `verify()` handler from the same
`INSTALL_HOST_DEFINITIONS` table the postinstall deploy uses. That gate catches
*our* drift — a missing, unparseable, or canonical-body-diverged asset — before
publish.

This checklist covers only what CI **cannot** reach: actually invoking
`/audit-code` inside a GUI host and confirming a host handoff round-trips. A GUI
host can change its asset format or command-rendering out from under us; the
no-drift guard does not see that, so a human runs these rows at release. A failed
row becomes a backlog item.

Concrete semantic execution is outside the package boundary, so release
validation covers workload emission and result ingestion rather than a matrix
of execution backends.

### How to run a row

For each GUI host below:

1. **Install** — from a clean repo, run `npm install -g audit-tools` (or the
   local equivalent) so postinstall deploys the host surface, then open the
   repository in the host.
2. **Command appears** — confirm the host registers/offers `/audit-code` (slash
   command, skill, or agent, per the host's setup kind).
3. **One live handoff** — invoke `/audit-code` and let it run one bounded audit
   step (a single `audit-code next-step` round-trip). If semantic work is
   reached, complete one emitted host work item.
4. **Result lands** — confirm the step's result artifact is written under
   `.audit-tools/audit/` (e.g. `steps/current-step.json` advances and the
   expected artifact for that step appears).

Mark each cell pass / fail; record the release version and date **in the release's own
notes or a `docs/reviews/` record — never by committing a filled copy of the grids below.**
They are a timeless template, like `docs/end-of-sprint-report-template.md`.

### Checklist (one row per GUI host)

| Host | Surface deployed | 1. Install + open | 2. `/audit-code` visible | 3. One live handoff | 4. Result lands under `.audit-tools/audit/` |
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
below at release, using the same GUI-host set.

| Host | Surface deployed | 1. Install + open | 2. `/remediate-code` visible | 3. One live handoff | 4. Result lands under `.audit-tools/remediation/` |
|---|---|---|---|---|---|
| Antigravity | `.agent/skills/remediate-code/SKILL.md` skill, `.gemini/commands/remediate-code.toml` slash command, planning guide, AGENTS instructions | ☐ | ☐ | ☐ | ☐ |
| OpenCode | global `/remediate-code` command (npm-installed) + generated `opencode.json` project permissions | ☐ | ☐ | ☐ | ☐ |
| VS Code | generated prompt file + custom agent + Copilot instructions (`INSTALL_HOST_DEFINITIONS.vscode`, `setup_kind: 'prompt+agent'`) | ☐ | ☐ | ☐ | ☐ |

Notes / failures (file each as a backlog item):

-

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

For live child-process output while debugging the packaged/linked smokes:

```bash
AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code
AUDIT_CODE_VERBOSE=1 npm run smoke:linked-audit-code
```

The packaged smoke path strips inherited `npm_config_*`, `NODE_AUTH_TOKEN`, and
`NPM_TOKEN` values before nested npm operations so dry runs and smoke installs
do not accidentally inherit publish credentials or suppress tarball generation.

Post-publish checks:

```bash
npm view audit-tools version
npm view audit-tools dist-tags --json
npm audit signatures
```
