# P39 — a generator-parity gate registered `preCommit: false` lets a stale tracked render land

Leg 3 (recurring-problem solutions). **Proposal only — nothing in this directory is applied.**

## The trap

A gate whose job is *"this tracked file is a render of those sources; regenerate it"* only
protects the tree if it runs at commit. `scripts/guard-reach-data.mjs` states that per gate as
the `preCommit` flag, and `scripts/shared/derived-file-preflight.mjs` derives the commit-gate leg
set from it (P34). One gate row declares a regenerate-shaped `fix:` and still sets
`preCommit: false`:

```
check:runtime-artifact-names   preCommit: false
  fix: "runtime-artifact-names.generated.mjs is stale — run node scripts/shared/generate-runtime-artifact-names.mjs"
```

Every other generator-parity gate is `'reach'`: `check:doc-manifest`, `check:philosophy-brief`,
`check:nightly-routine-prompt`, `check:handoff-roadmap`, `check:backlog-index`,
`check:gate-enumeration`, `check:ci-trigger-paths`, `check:memory-citations`,
`check:offload-lanes`. The one exception is the one that burned a release.

## Recurrence evidence

Counted, not asserted. Three records, two distinct dates, one class — *a derived tracked artifact
goes stale because the gate that would catch it does not run where the staleness is created*.

1. **2026-08-20** — `docs/backlog/open-bugs.md`, entry *"A src deletion that changes the derived
   runtime-artifact-name set lands through a green commit gate"*. Deleting the
   `validateDispatchArtifacts` family removed the last source mention of `dispatch-plan.json`;
   the tracked render lagged. Green at commit, red only in the full suite's drift test and the
   pre-tag `verify:checks`. Cost: one failed full-suite run plus the regen commit `85609eb7`.
2. **2026-08-20** — `docs/backlog/open-bugs.md`, the nightly/HANDOFF entry: writing the nightly
   queue desyncs `docs/HANDOFF.md`'s generated live-status block. Same class, different half —
   here the gate row's reach IS correct (`.audit-tools/nightly/open-items.json` is a REACH row
   citing `check:handoff-roadmap`), and the gap is that the nightly run contract never
   regenerates. That half is NOT this proposal; it is named here only to establish the class.
3. **P19 (4 records / 3 dates)** — the attestation-voided-by-regeneration saga, which is why
   `derived-file-preflight.mjs` exists at all. The mechanism was built; this row was left outside
   it.

## Mechanism

Two parts. Part 1 fixes the instance; part 2 makes the class unrepresentable — which is the half
that matters, because part 1 alone is the "remember to set the flag" that this repo bans.

### Part 1 — register the gate's real reach

`scripts/shared/generate-runtime-artifact-names.mjs` already exports its input set as declared
data:

```js
export const RUNTIME_NAME_SOURCES = [
  { file: "src/audit/io/artifacts.ts", rules: ["artifactConstructors"] },
  ... 13 entries ...
];
```

So the reach is DERIVED, never hand-listed: flip the gate row to `preCommit: 'reach'` and add a
REACH row whose `files` are those 13 declared paths plus the generator and its render. Importing
the generator into the registry is safe — its CLI body is guarded by an
`import.meta.url === pathToFileURL(process.argv[1]).href` check, so importing never writes.

### Part 2 — a contract test that forbids the shape

`tests/shared/generator-gates-run-at-commit.test.ts`: for every `GUARDS` row with
`kind === 'gate'` whose `fix` is regenerate-shaped, assert `preCommit !== false`. A new
generator-parity gate registered outside the commit gate is then a red build, and the test states
its own reason when it fires.

The regenerate-shaped predicate is the honest limit of this proposal: it keys on the `fix` prose
(`/regenerat|generate-|--write|is stale/i`). A future gate whose `fix` avoids all four tokens
passes. Stating that here rather than claiming full coverage — a partly-enforced trap is not a
closed one.

## What it would have caught

Commit `efd3c849` (`fix: drop the two contract-version constants the deadcode gate named`) staged
`src/remediate/steps/types.ts`, which is not in `RUNTIME_NAME_SOURCES`; the *earlier* deletion of
the `validateDispatchArtifacts` family is the one that moved the derived set. Under part 1 that
commit's gate leg runs `check:runtime-artifact-names`, fails with the stated fix, and the
regeneration lands in the same commit instead of as the follow-up `85609eb7`.

## False-positive surface

- **Cost.** The gate is a single `--check` parse of 13 TypeScript files under plain node. It joins
  a `'reach'` leg set that already runs nine comparable checks, and only for commits that stage
  one of those 13 paths. Not the `test:doc-contract` class the preflight module deliberately
  excludes.
- **Churn.** The 13 paths are loop-core-adjacent and change often, so the leg will fire regularly.
  That is the point, not a defect — every firing is a real stale render.
- **Import risk.** Part 1 makes `guard-reach-data.mjs` import the generator. If that module ever
  gains a side effect at import time, the registry executes it. Mitigation: copy the declared
  paths through a re-export rather than importing the whole generator, if the owner prefers the
  weaker coupling.

## Patch and tests

- `PATCH.md` — the exact edits for both parts.
- Tests belong under `tests/`; Vitest excludes `.claude/**`, so a test beside a hook never runs.
- Red-green: the test is red at HEAD (one offender: `check:runtime-artifact-names`) and green
  after part 1. That ordering is the validation — do not land part 2 first and call it passing.
