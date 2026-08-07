# CI wall-clock: measured critique of a proposed plan, and the implementation brief that replaces it

Date: 2026-08-07 · Measured against `088bb6df`'s parent tree · Baseline: `.audit-tools-profile/publish-ci-latest.json` (run 31205859432, v0.39.1)

**This document is the single home for this work — deliberately.** It is written for an implementer
with no access to the conversation that produced it, and it is complete: nothing about this plan lives
in the backlog, in chat, or in another doc. The backlog carries a bare pointer here and no substance,
so there is no second copy to drift. §1 is the brief (what to do); §2 is the anti-brief (what was
proposed and why it is wrong — read it, or the refuted plan will be re-derived); §3–§4 are the evidence
behind both.

**Status:** T1–T3 + T5 landed 2026-08-07 (implemented outside this repo's agent loop; landed with
two repairs — `sequence.sequencer` must be the imported class, not a string path, and the committed
duration baseline must be COMPLETE, now generated via `npm run generate:shard-baseline` with a
census guard). **T4's top three targets landed later the same day**, each split with exact
test-count parity and a shared harness (splitting, not concurrency flags, per the protocol below):
`audit-code-wrapper.test.ts` (300.7s in the committed baseline) → five
`audit-code-wrapper-*.test.ts` files over `tests/audit/helpers/wrapper-harness.ts`;
`next-step.test.ts` (257.8s) → three `next-step-core-*.test.ts` files over
`tests/audit/helpers/next-step-harness.ts`; `pre-commit-gate-staged-snapshot.test.ts` (78.3s,
fully serial) → five `pre-commit-gate-*.test.ts` files over
`tests/shared/pre-commit-gate-harness.ts` (guard-reach rows updated per file). The committed
duration baseline was regenerated from a green full run on the split tree. **Post-split correction
to this brief's own scoping:** §3's top-3 were measured from the SHARD-1 ledger, but the committed
full-run baseline shows `tests/audit/audit-code-completion.test.ts` at ~335s — it sat in another
shard and is, and was, the true single-file floor. The three splits fixed the distribution above
the floor (former 300s/258s/78s monsters now spread across 13 files, largest fragment ~217s);
**the floor itself moves only when completion.test.ts is split**, same one-file-at-a-time protocol.
Remaining T4 queue, in floor order: `audit-code-completion.test.ts` (335s), the
`audit-code-wrapper-packets.test.ts` fragment (217s, split further if completion's split leaves it
dominant), the dispatch-worktree pair's shared fixture, and the separate `collectMs`
transform-caching look.

---

## 1. Implementation brief

### 1.0 Context an implementer needs

`audit-tools` is a single npm package with three workflows:

| Workflow | Jobs | What it runs |
|---|---|---|
| `.github/workflows/ci.yml` | 1 (`checks`) | `verify:checks` only. Node pinned via `CI_NODE_VERSION: "22.14.0"`. |
| `.github/workflows/audit-code-test-suite.yml` | 8 (`orchestration-tests`) | vitest suite, matrix 2 Node × 4 shards. |
| `.github/workflows/publish-package.yml` | 6 (`gate`, `test`×4, `publish`) | `verify:checks` + vitest 4 shards + publish. Node pinned via `RELEASE_NODE_VERSION: "22.14.0"`. |

`ci.yml` and `audit-code-test-suite.yml` both **skip on release-bump commits** (a `release: v<digit>`
message predicate), so the release commit is gated solely by `publish-package.yml`. The two PR-path
workflows are **complementary, not duplicates** — one runs the non-test gates, the other runs the suite.

Measured release job times: `gate` 83s · `test` shards 259/138/103/89s · `publish` 70s.
`publish` has `needs: [gate, test]`. So **real release wall-clock ≈ max(83, 259) + 70 ≈ 329s.**

### 1.1 Tasks, in order

Each task states the invariant it establishes, not just the edit.

---

**T1 — `criticalPathMs` must measure the dependency chain, not the biggest job.**

*Current:* `scripts/release-and-publish.mjs` computes it as a `reduce` taking `Math.max` over per-job
durations, feeding the `[release] critical-path` log line and the `criticalPathMs` field of
`.audit-tools-profile/publish-ci-latest.json`.

*Defect:* that is max-of-jobs. It drops the 70s `publish` tail entirely, because `publish` runs *after*
`gate` and `test` rather than alongside them. The recorded 259s understates real wall-clock by ~21%.

*Target:* walk the workflow's `needs:` edges and compute the longest path. Any job reachable only
through a `needs` chain must contribute additively.

*Acceptance:* on a release matching the baseline above, the field reads ~329000, not ~259000.

*Why first:* every other task is judged by this number. Fixing it last means every intermediate
measurement is wrong.

---

**T2 — the per-shard timing ledgers must survive the run.**

*Current:* `vitest.config.ts` registers `scripts/shared/vitest-timing-reporter.mjs` as a reporter, and
`scripts/shared/run-vitest-gate.mjs` writes `.audit-tools-profile/vitest-shard{N}of{total}-latest.json`
containing a `slowest` array of `{file, ms, collectMs, runMs}`. **CI produces these on every run and
discards them** — the only `upload-artifact` steps across all three workflows are `if: failure()` and
upload npm logs.

*Target:* upload the vitest ledgers unconditionally (not `if: failure()`) from the sharded test jobs in
both `publish-package.yml` and `audit-code-test-suite.yml`.

*Acceptance:* a green run leaves a downloadable artifact containing one ledger per shard.

*Why:* T3 is impossible without this data, and it is currently being generated and thrown away.

---

**T3 — shard balance must be derived from measured duration, not from a path hash.**

*Current:* vitest 3.2.6's `BaseSequencer.shard()` maps each spec to `sha1(specPath)`, sorts by that
hash, and takes a contiguous slice. It is **duration-blind** and balances file *count* only. This is
the direct cause of the 259s/89s skew.

*Target:* a custom sequencer via vitest's `sequence.sequencer` config option, partitioning by recorded
duration (greedy longest-processing-time). Files with no recorded timing **must** fall back to the
inherited `super.shard()` behavior, so a newly added test file degrades to today's behavior rather than
being dropped or mis-assigned.

*Constraint:* the timing source must be committed data or a build input — not a lookup that reaches the
network or the local disk state of whoever runs it.

*Acceptance:* slowest and fastest shard within ~20% of each other on a full run.

*Bound — read this before estimating the gain:* see T4. T3 alone cannot beat ~157s.

---

**T4 — no single test file may dominate a shard.**

*This is the only task that changes the achievable floor, and the only one with real risk.*

*Mechanism:* vitest shards at **file** granularity, and runs tests within a file **serially** by
default (`vitest.config.ts` sets no `concurrent` or `sequence.concurrent`). Therefore **the slowest
shard can never be faster than the longest single test file — at any shard count, under any
partitioning strategy.**

*Measured (shard 1/4, 145 files, `wallSummedMs` 765.5s — see §3):*

| File | ms | % of shard |
|---|---|---|
| `tests/audit/audit-code-wrapper.test.ts` | 157,015 | **20.5%** |
| `tests/audit/next-step.test.ts` | 119,738 | **15.6%** |
| `tests/shared/pre-commit-gate-staged-snapshot.test.ts` | 75,085 | **9.8%** |

Top 3 = **46%** of the shard. Top 10 = **78%**. The other 135 files = 22%.

*Target:* bring the longest single file well under the T3-balanced shard time — by splitting each into
several files, or by marking genuinely independent cases `test.concurrent` / `describe.concurrent`.

*Risk, stated plainly:* these are spawn-heavy suites — wrapper CLI invocations, git staging snapshots,
git worktree creation. They are latency-bound rather than CPU-bound, which is *why* they should
parallelize well, but it also means they are the most likely place for shared-state collisions
(temp dirs, git index locks, `.audit-tools` state). This repo's standing test protocol already treats a
test that passes alone but fails in parallel as a hermeticity bug in the test.

*Therefore:* do these **one file at a time, red-green validated**, not as a bulk concurrency flag. A
file that cannot be made concurrent safely should be *split* instead — splitting is always safe because
separate files were already running in parallel.

*Secondary targets once the top 3 are handled:* `tests/remediate/dispatch-worktree-safety.test.ts` and
`tests/remediate/dispatch-worktree.test.ts` (79s combined, both create real git worktrees — candidates
for a shared fixture).

*Also visible in the data:* `collectMs` is 98s of 765s (**12.8%**) — pure TypeScript transform paid
before any assertion runs. Worth a separate look at transform caching; independent of T1–T4.

---

**T5 — one Node version across the whole pipeline: 22.14.0, with `engines` raised to `>=22`.**

**Settled by owner decision, 2026-08-07. Do not re-open either half.**

*Current asymmetry (the defect):* `audit-code-test-suite.yml` runs a
`node-version: ["20.19.2", "22.14.0"]` matrix (2 × 4 shards = 8 jobs). `ci.yml` and
`publish-package.yml` are both pinned to `22.14.0` via `CI_NODE_VERSION` / `RELEASE_NODE_VERSION`. So
the PR path covers Node 20 and 22, while the path that guards an actual publish covers only 22 — the
gate protecting the least reversible action is the weaker of the two.

*Target:*

| File | Change |
|---|---|
| `.github/workflows/audit-code-test-suite.yml` | Remove the `node-version` matrix axis and every reference to `matrix.node-version` (job name, `setup-node` input, the two `::error::` messages, the artifact name). Matrix becomes `shard: [1,2,3,4]` only — 8 jobs → 4. |
| `.github/workflows/ci.yml` | None. `CI_NODE_VERSION` stays `"22.14.0"`. |
| `.github/workflows/publish-package.yml` | None. `RELEASE_NODE_VERSION` stays `"22.14.0"`. |
| `package.json` | `"engines": {"node": ">=20"}` → `">=22"`. |

*The `engines` half is not optional.* Dropping the 20.19.2 axis while leaving `engines` at `>=20` would
ship a declared Node 20 floor with zero Node 20 coverage — that is the same defect this task exists to
remove, restated one level down. The two edits land together.

*Rejected alternative, recorded so it is not re-litigated:* standardizing on 20.19.2 and keeping
`engines: >=20` (tests the advertised floor, catches accidental use of post-20 APIs) was considered and
declined — 22.14.0 is already the pinned constant in all three workflows, and the repo has no external
consumers, so narrowing `engines` costs nothing.

*Acceptance:* `audit-code-test-suite.yml` runs 4 jobs; no workflow references Node 20; `engines` and the
pinned constants agree.

---

### 1.2 Explicitly do NOT do these

These were proposed, measured, and rejected. Full reasoning in §2.

| Rejected | Why |
|---|---|
| Raise the release shard count 4 → 6 | Does not separate the heavy cluster (§4), and dead-ends at the T4 floor. Reconsider **only after T4**, never before. |
| Add `--ignore-scripts` to `npm ci` in CI | Worth ~2s; breaks a live `postinstall` that the packaged smoke tests explicitly assert on. |
| Version-guard the `npm install -g npm@11.5.1` step | Worth 4s; the natural guard is a semver string-compare bug. |
| Split the smoke checks into their own jobs | The `gate` job has 176s of slack — gain is exactly zero, cost is two more jobs. |
| Share a prebuilt `dist/` artifact into `publish` | ~11s, likely net-negative after artifact round-trip, and weakens the publish provenance. |

One adjacent change **is** worth making, unrelated to the above: `audit-code-test-suite.yml` uses bare
`npm ci`, while the other two workflows use `npm ci --prefer-offline --no-audit --no-fund`. Align it.

### 1.3 Verification

```bash
npm run build && npm run check && npm run verify:checks
```

Suite timing changes (T3/T4) must be validated by a full sharded run, not a single shard — rebalancing
moves work between shards, so a per-shard improvement can hide a regression elsewhere. Compare
`.audit-tools-profile/publish-ci-latest.json` before and after, using the T1-corrected metric.

---

## 2. The rejected plan, and why each step fails

The plan proposed five steps. Its stated goal was to cut release wall-clock without losing gate
coverage. It also contained two premise errors that shaped everything downstream.

### 2.1 Premise error — the acceptance metric cannot see three of the plan's five steps

The plan's acceptance target was "`criticalPathMs` drops from ~259000 to ~170000–190000." Per T1,
`criticalPathMs` is max-of-jobs. Steps 3 and 5 touch only the `publish` job; step 4 touches only the
`gate` job. **None of the three can move that number**, whether or not they work. The plan proposed
changes and then chose a metric structurally incapable of scoring them.

### 2.2 Premise error — "duplicate but different gates"

The plan described `ci.yml` and `audit-code-test-suite.yml` as running "duplicate but different gates."
They are complementary (§1.0), and both skip on release commits. The real finding in that area runs the
*opposite* direction — the release gate is weaker than the PR gate — and became T5.

### 2.3 Step 1 (4 → 6 shards) — capped, and for a reason the plan did not identify

The plan's rationale was that raising the shard count would fix the "235s worst shard vs 138/103/89"
skew. It does not fix it; it only trims the tail. See §4 for the algorithm and the replication.

The honest accounting, using total shard test time 488s and per-shard fixed overhead ~24s
(setup + checkout + node + install + build):

| Scenario | Slowest test job |
|---|---|
| Today (4 shards, hash-skewed) | 259s |
| Perfect balance at 4 shards | 488/4 + 24 = ~146s |
| Perfect balance at 6 shards | 488/6 + 24 = ~105s |

Two things follow. First, **~78% of the achievable gain is in fixing the balance at the shard count
already in use** — the plan picked the 22% lever. Second, **both of those figures are unreachable**,
because they sit below the ~157s single-file floor established in T4; the plan had no concept of that
floor.

In fairness: 4 → 6 *does* reduce the worst shard, by stripping ~48 light files off its tail, landing
somewhere near ~170–180s — roughly the plan's stated target. So the plan's *number* is plausibly
reachable. But it is the end of the sharding road rather than a first step: 8 shards buys essentially
nothing more, and the same result is available at 4 shards via T3 without adding two jobs (each costing
~24s of setup and one more independent flake surface).

### 2.4 Step 2 (`--ignore-scripts`) — wrong on facts, payoff, and rationale

Three independent problems:

- **The flags are mostly already present.** `publish-package.yml` and `ci.yml` already use
  `--prefer-offline --no-audit --no-fund`. The only new flag proposed is `--ignore-scripts`.
- **The payoff is ~2s.** `cache: npm` is already configured on `actions/setup-node` in all three
  workflows; measured "Install dependencies" steps are 2–3s, against a ~329s wall clock.
- **The rationale is false.** The plan asserted "none of these jobs require package postinstall
  behavior for correctness." `package.json` defines `postinstall`, `prepack`, and `prepublishOnly`.
  `scripts/postinstall.mjs` deploys host assets and mutates the consuming repo's `.gitignore`. Three
  dependencies carry install scripts (`esbuild` ×2, `fsevents`), and vitest's toolchain runs on esbuild.
  Most directly: `scripts/remediate/smoke-packaged-remediate-code.mjs` explicitly sets
  `npm_config_dangerously_allow_all_scripts` so postinstall *does* run, then asserts the deployed
  command file exists and matches source. Postinstall is product surface under test here.

### 2.5 Step 3 (guard the npm upgrade) — 4s, bought with a publish-path hazard

Measured cost of the `Upgrade npm for trusted publishing` step: **4s** of a 70s job. The plan's stated
assumption was "npm 11.x+ is required for trusted-publish behavior." Trusted publishing requires
**≥ 11.5.1** specifically; 11.0–11.4 do not support it, so a guard written against "11.x" admits
versions that cannot publish. Worse, the natural shell implementation string-compares, and
`11.10.0 < 11.5.1` lexically — so the guard skips the upgrade on a *newer* runner. That is a
correctness hazard on the least reversible step in the pipeline, for four seconds.

### 2.6 Step 4 (split the smoke checks out) — provably zero gain

The plan sized this from `.audit-tools-profile/verify-checks-latest.json`, a **local win32 run**
(122.1s total, `smoke:packaged-audit-code` 76.1s). The CI number is the `gate` job: 70s for
`verify:checks`, 83s for the whole job — running in parallel with a 259s `test` job, i.e. **176s of
slack**. Splitting it removes nothing from the critical path, adds two jobs each paying ~15–20s of
setup, and adds two more `needs` edges before `publish`. The plan concedes the point itself
("lets the heaviest `test` shard remain the real critical driver"), which is an admission of zero gain.

### 2.7 Step 5 (share `dist/` into publish) — ~11s, and it weakens the publish invariant

Bounded by the publish job's `Build dist for packing` step: 11s of ~329s. `upload-artifact` +
`download-artifact` typically costs 5–15s round trip, so the net is plausibly zero or negative — and
per §2.1 it is invisible to the plan's own metric.

Unraised by the plan: `npm publish --ignore-scripts` means `prepack` does **not** run at publish time,
so the tarball is exactly whatever is in `dist/` at that moment. Today that is built in-job from the
checked-out commit. Consuming a downloaded artifact means the published bytes were produced by a
different job — losing the "built from this checkout, in this job" property on the one artifact that
reaches users, for a ~3% saving.

---

## 3. Evidence: direct measurement of shard 1/4

Command: `node scripts/shared/run-vitest-gate.mjs --shard=1/4`, win32/cpu16.
Ledger: `.audit-tools-profile/vitest-shard1of4-latest.json`.

**145 files · 1,910 passed / 0 failed / 6 skipped · `wallSummedMs` 765,530ms · `collectMs` 97,995ms.**
(`wallSummedMs` sums per-file time across parallel workers; it is not wall clock.)

| File | ms | % of shard |
|---|---|---|
| `tests/audit/audit-code-wrapper.test.ts` | 157,015 | 20.5% |
| `tests/audit/next-step.test.ts` | 119,738 | 15.6% |
| `tests/shared/pre-commit-gate-staged-snapshot.test.ts` | 75,085 | 9.8% |
| `tests/audit/next-step-narrative.test.ts` | 64,530 | 8.4% |
| `tests/remediate/dispatch-worktree-safety.test.ts` | 40,098 | 5.2% |
| `tests/remediate/dispatch-worktree.test.ts` | 39,376 | 5.1% |
| `tests/audit/finalization-cycle-guard.test.ts` | 34,745 | 4.5% |
| `tests/shared/nightly-routine-prompt-gate.test.ts` | 25,304 | 3.3% |
| `tests/audit/worker-run-command.test.ts` | 23,797 | 3.1% |
| `tests/remediate/accept-node-loop-core-guard.test.ts` | 19,917 | 2.6% |

Top 3 = 45.9%. Top 10 = 78.3%. Remaining 135 files = 21.7%.

## 4. Evidence: the shard algorithm, and why more shards do not separate the cluster

`BaseSequencer.shard()` in vitest 3.2.6 (bundled under `node_modules/vitest/dist/`) does:

```js
const shardSize  = Math.ceil(files.length / count);
const shardStart = shardSize * (index - 1);
const shardEnd   = shardSize * index;
return [...files]
  .map(spec => ({ spec, hash: hash("sha1", specPath, "hex") }))
  .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  .slice(shardStart, shardEnd)
```

A contiguous slice of a **fixed** sha1-of-path ordering. Two consequences:

1. Changing `count` does not reshuffle the ordering — it only moves the cut points.
2. Files adjacent in hash order therefore stay in the same shard unless a cut lands between them. With
   578 files and 5 interior cuts, the chance of splitting any given adjacent pair is ~1%.

Replicating the algorithm exactly over the 578 currently-tracked test files, and tracking the 9 files
the repo's own `verify:guards` script excludes as heavy/flaky:

| N | Shard holding the top cluster | Contents |
|---|---|---|
| 4 | shard 1/4 | `audit/next-step`, `audit/audit-code-wrapper`, `remediate/hybrid-nim-e2e` |
| 6 | shard 2/6 | **identical three files** |
| 8 | shard 2/8 | **identical three files** |

Shard 1/4 holding the densest cluster matches the observed 259s worst shard, and §3 confirms two of
those three files are in fact the top two by duration.

**Method note:** the `verify:guards` exclusion list is a *flake* list, not a duration list — it was used
as a proxy for cluster identification, and §3's direct measurement was run to replace it. The structural
argument (contiguous slicing of a fixed hash order keeps adjacent files together as N changes) holds
regardless of which files happen to be slow.
