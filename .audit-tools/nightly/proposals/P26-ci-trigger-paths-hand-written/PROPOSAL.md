# P26 — CI trigger paths are hand-written while the guard-reach registry already declares what each gate inspects

Nightly leg 3, 2026-08-13. Queue item `sol-1`. Propose-only.

## The defect

`.github/workflows/ci.yml` gates its `push` and `pull_request` runs on a hand-written
`paths:` list (`src/**`, `tests/**`, `scripts/**`, `*.mjs`, …). `check:guard-reach` inspects
`.claude/**`, and `.claude` is not in that list — so a commit touching only a hook lands with
**zero CI runs** while a gate that reads that exact directory sits in `verify:checks`.

The registry that knows the answer already exists: `scripts/guard-reach-data.mjs` declares, per
guard, the file globs it scans. The CI list is a second, hand-maintained copy of a subset of it,
kept honest by nothing.

## Recurrence — counted, 2 distinct dates

| Date | Incident |
|---|---|
| 2026-07-19 | A markdown-only push outside `docs/` ran no CI, while `check:doc-manifest` reconciles every tracked `*.md`. Fixed by hand-adding `"**/*.md"`; the incident is recorded in `ci.yml`'s own comment. |
| 2026-08-08 | `docs/backlog/open-bugs.md` records that trigger paths omit `.claude/**`, which `check:guard-reach` inspects; commit `ce83638f` triggered zero runs. |

The first fix was a hand-patch that did not generalize, which is why the second happened. No test
asserts the containment — `tests/audit/release-contract.test.ts` reads `ci.yml` only for
lockfile and artifact-pin assertions.

## Mechanism — makes the trap unrepresentable

A generator, `scripts/shared/generate-ci-trigger-paths.mjs`, supporting `--check` and `--write`,
that derives the `paths:` block from the union of `files` globs across `guard-reach-data.mjs`'s
reach rows, and fails when `ci.yml` disagrees. Wire `check:ci-trigger-paths` into `verify:checks`
beside the four existing `--check` generators (`check:backlog-index`, `check:handoff-roadmap`,
`check:constitutional-doc-paths`, `check:loop-core-patterns`).

A gate that inspects a path CI cannot be triggered by then **fails the build** rather than
landing green.

Secondary benefit: the `push` and `pull_request` blocks are byte-identical duplicates including
the comment — the lockstep-comment duplication tell. A generator collapses them to one source.

## What it would have caught

`ce83638f` (2026-08-08) and the 2026-07-19 markdown incident — both, mechanically, at commit.

## False-positive surface — stated honestly

The union of reach globs is **broader** than today's hand-written list: it includes `.claude/**`
and every row's declared file set. CI would therefore run on more pushes. The cost is runner
minutes, not a wrong signal.

The real risk is the other direction: someone widens a reach row's glob for documentation
reasons and silently widens CI. Mitigate by generating only from rows whose `guardedBy` is not
`declared-gap`.

## Not authored this run

The patch and its red-green tests were **not** written. This is a proposal record, not a
ready-to-apply one — the owner should expect a build step, not a one-click approve. Tests would
belong under `tests/` (vitest excludes `.claude/**`).
