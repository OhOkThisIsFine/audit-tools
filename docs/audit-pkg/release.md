# Release

## Release gate

Run from the repository root:

```bash
npm ci
npm run verify:release
```

`verify:release` covers:

- TypeScript typecheck (`build`)
- dead-code export gate (`check:deadcode`)
- doc-manifest reconciliation gate (`check:doc-manifest`)
- full automated test suite (`vitest run`)
- host-install verification for both bins (`verify:hosts`, `verify:remediate-hosts`)
- packaged-install smoke coverage for both bins (`smoke:packaged-audit-code`, `smoke:packaged-remediate-code`)

Linked-install smoke coverage (`smoke:linked-audit-code`, `smoke:linked-remediate-code`) is available as a
standalone command but is not part of the `verify:release` chain.

For live child-process output while debugging smoke tests:

```bash
AUDIT_CODE_VERBOSE=1 npm run smoke:packaged-audit-code
AUDIT_CODE_VERBOSE=1 npm run smoke:linked-audit-code
```

The packaged smoke path strips inherited `npm_config_*`, `NODE_AUTH_TOKEN`, and
`NPM_TOKEN` values before nested npm operations so dry runs and smoke installs
do not accidentally inherit publish credentials or suppress tarball generation.

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
