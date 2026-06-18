# Release

## Release gate

Run from the repository root:

```bash
npm ci
npm run verify:release
```

`verify:release` covers:

- TypeScript typecheck
- full automated test suite
- linked-install `audit-code` smoke coverage
- packaged-install `audit-code` smoke coverage
- tarball contract verification for shipped assets and runtime entrypoints
- packaged and linked verification of bootstrap install behavior

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

The workflow:

- requests `id-token: write` for npm OIDC exchange
- pins Node `22.14.0`
- upgrades npm to `>=11.5.1`
- runs `npm run verify:release`
- previews the packed tarball with `npm pack --dry-run`
- publishes with public access and provenance
- defaults semver prerelease versions to the `next` dist-tag unless overridden
- verifies that the published version resolves from the registry
- uploads `*-npm-logs` artifacts on failure

Routine CI exercises Node `20` and Node `22`.

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

That command checks the worktree, runs the release gate, bumps the version,
commits, tags, pushes `main` and the tag, creates the GitHub Release, waits for
`publish-package.yml`, and confirms the new npm version resolves.

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
