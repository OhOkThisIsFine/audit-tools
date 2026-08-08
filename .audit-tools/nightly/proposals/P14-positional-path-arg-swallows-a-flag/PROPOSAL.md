# P14 — a script that takes a positional path silently accepts `--help` as that path

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Thin recurrence: two instances, two dates. Recorded at that strength, not inflated.**

## The recurrence

`scripts/shared/triage-backlog.mjs:80`

```js
const OUT = process.argv[2] || join(ROOT, '.audit-tools', 'backlog-triage.jsonl');
```

`node scripts/shared/triage-backlog.mjs --help` therefore does not print help. It resolves
`--help` as the output path, runs the live-lane preflight, and starts sweeping all 111 backlog
entries into files literally named `--help` and `--help-coverage.json` in the repo root. Hit
during this run (2026-08-08); the sweep had to be killed and the two files removed before the
real sweep could start.

The same shape was hit before and fixed in exactly one place —
`scripts/check-gate-enumeration.mjs:22`, added 2026-07-30 in `6b8f8d7a`:

```js
const root = resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.cwd());
```

One script carries the guard. The others do not. That is the
[[fix-the-defect-class-not-the-named-instance]] shape, at two instances.

## What is NOT affected (checked, so the scope is not overstated)

- `scripts/check-doc-links.mjs:35` and `scripts/check-doc-code-citations.mjs:46` take
  `process.argv[2] ?? process.cwd()` with no guard, but both **throw and exit 1** on `--help`
  (the resolved directory does not exist). Loud, so not a silent-damage case — though they are
  loud by accident, not by design.
- `scripts/release-and-publish.mjs:22` is guarded by an `allowedBumps` allowlist.
- `scripts/remediate/generate-auditor-contract-fixture.mjs:23` — not exercised here.

So the silent-damage set is currently **one script**, and the near-miss set is two more.

## Why it matters more than a usability nit

`triage-backlog.mjs` is the leg-2 sweep. A mistyped invocation does not fail — it spends a full
lane sweep, writes untracked junk into the repo root where a later `git add -A` would catch it,
and leaves the real output file empty. The failure mode is "it looks like it worked".

## Proposed mechanism

Prefer removing the trap over guarding it: parse args instead of indexing them. The minimal
form, applied at every `process.argv[2]` path site —

```js
const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (process.argv.slice(2).some((a) => a === '-h' || a === '--help')) { printUsage(); process.exit(0); }
const OUT = positional[0] || <default>;
```

An unrecognized `--flag` should exit non-zero naming it, never fall through to a path.

A contract test under `tests/` can hold the class: for each script in a declared list, assert
`--help` exits 0 with usage on stdout and writes nothing. That list belongs in
`scripts/guard-reach-data.mjs`, which already registers check scripts as data — so a new script
with a positional path is reconciled rather than remembered.

**False-positive surface:** a script whose positional argument legitimately begins with `-`
(none here). A filename starting with `-` is already unusable across most CLI tooling.

## Patch

Not written. The change is small but touches five entrypoints and wants the
`guard-reach-data.mjs` registration decided first (is "scripts accept `--help`" a reach the
registry should claim, or a plain contract test?). That is a design call, so it is proposed
rather than pre-empted.
