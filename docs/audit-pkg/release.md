# Release

The maintainer land-and-publish flow — release gate, publication, version bumps —
is owned by the ship skill (`.claude/skills/ship/SKILL.md`), including the
generated gate-step list. `npm run release:patch` bumps + tags;
`npm run release:patch:publish` runs the full flow (`release:minor` /
`release:major` variants likewise). Routine CI runs the full suite on every Node major
that `engines.node` admits and the Node project still ships; the matrix in
`.github/workflows/audit-code-test-suite.yml` is self-describing, and the release pipeline
builds and publishes on its single pinned line (`RELEASE_NODE_VERSION`).

This page keeps what the skill does not carry: manual host validation, manual
workflow dispatch, trusted-publisher configuration, and troubleshooting.

## Host validation — the manual half of the release gate

The automated half of multi-host validation lives in `npm run verify:hosts`
(wired into `verify:release`): it deploys the four hosts in
`INSTALL_HOST_DEFINITIONS` (codex, opencode, vscode, antigravity) into an
isolated temp `$HOME` and re-runs each host's own `verify()` handler from that
table. The postinstall also writes surfaces outside the table — the
`~/.claude/commands/` entry and the Claude Desktop external-plugin manifest,
command and skill — and the gate does not cover those. That gate catches
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

1. **Install the candidate** — download `qualified-npm-tarball-<attempt>` from
   the candidate's `publish-package.yml` run (a manual dry run can provide it).
   Compute the extracted `.tgz` file's SHA-256 and match it against the gate
   summary. Run `npm install -g /absolute/path/to/the-qualified.tgz` with
   postinstall enabled so it deploys the host surface, then open a clean,
   disposable fixture in the host. Do not use a registry install or repack.
2. **Command appears** — confirm the host offers `/audit-code` (or
   `/remediate-code` for its rows) and uses the candidate installation.
3. **One live handoff** — invoke the command in the GUI in a small fixture
   that reaches host work. Continue past bootstrap until the installed CLI
   emits a workload. Complete one item using its current prompt and write the
   answer to its declared result path with the emitted run ID, work-item ID
   and prompt digest.
4. **Bound result accepted** — call the installed CLI's next step through the
   GUI and verify CLI acceptance for that exact item in its accepted-results
   record or applied outcome state. A result file or advancing
   `current-step.json` alone does not show ingestion. If an item was not
   accepted or this host path could not be exercised, mark the handoff failed
   or unverified even if the command was visible.

Record the version, date, GitHub run and attempt, tarball SHA-256 and accepted
item evidence in the release's own notes or a `docs/reviews/` record. Never
commit a filled copy of the grids below.

### Checklist (one row per GUI host)

| Host | Surface deployed | 1. Install + open | 2. `/audit-code` visible | 3. One live handoff | 4. Bound result accepted |
|---|---|---|---|---|---|
| Antigravity | `.agent/skills/audit-code/SKILL.md` skill, `.gemini/commands/audit-code.toml` slash command, planning guide, AGENTS instructions | ☐ | ☐ | ☐ | ☐ |
| OpenCode | global `/audit-code` command (npm-installed) + generated `opencode.json` project permissions | ☐ | ☐ | ☐ | ☐ |
| VS Code | generated prompt file + custom agent + Copilot instructions (`INSTALL_HOST_DEFINITIONS.vscode`, `setup_kind: 'prompt+agent'`) | ☐ | ☐ | ☐ | ☐ |

Notes / failures (file each as a backlog item):

-

### remediate-code checklist (one row per GUI host)

`remediate-code` has its own automated half — `npm run verify:remediate-hosts`
(`scripts/remediate/verify-hosts.mjs`, wired into `verify:release`), the mirror of
the audit gate: it deploys the four hosts in `INSTALL_HOST_DEFINITIONS` into an
isolated temp `$HOME` and re-runs each host's `verify()` handler from that
table, and likewise does not cover the `~/.claude/commands/` surface the
postinstall writes outside it. As with audit, that gate catches *our* drift but
cannot invoke `/remediate-code` inside a live GUI host — a human runs the rows
below at release, using the same GUI-host set.

| Host | Surface deployed | 1. Install + open | 2. `/remediate-code` visible | 3. One live handoff | 4. Bound result accepted |
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

The non-test gate packs once and both packaged smokes install that tarball.
The fresh release pack runs the normal `prepack` build before the checks that
require `dist/`; the gate does not run a second build first. Local and PR
checks keep their standalone build and pack behavior.
The publish job downloads the gate's artifact and checks its SHA-256 and packed
package name and version against the verified checkout. Both live publish and
dry-run use those same tarball bytes without rebuilding or repacking. A live
run reports success only once npm returns the qualified tarball integrity and
the requested dist-tag points to that version.

## Refreshing release shard timings

The sequencer uses measured test-file times wherever it has them and estimates
only unmeasured files from the median of the measured files in the selection.
The log distinguishes measured and estimated specs and reports predicted shard
workloads; these are sums of per-file work, not elapsed CI time.

Refresh the baseline with `npm run generate:shard-baseline` after a green
unsharded full suite, or download all timing ledgers from one green release run
and run `npm run generate:shard-baseline -- --shards <ledger1> <ledger2> ...`.
The generator rejects red or incomplete evidence and verifies that every test
from the measured commit occurs exactly once across the shard ledgers. A new
test need not wait for a refresh to be included in weighted sharding.

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

Post-publish checks (substitute the release version for `x.y.z`):

```bash
npm view audit-tools@x.y.z dist.integrity --json
npm view audit-tools dist-tags --json
npm audit signatures
```
