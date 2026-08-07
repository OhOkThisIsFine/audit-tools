# Adversarial critique — "Reduce publish/test wall-clock while preserving gate quality"

Date: 2026-08-07 · Reviewed against HEAD `c260479a` · Baseline: `publish-ci-latest.json` (run 31205859432, v0.39.1)

**Verdict: the plan's one load-bearing step (4→6 shards) is empirically refuted; steps 2–5 target ~20s
of a ~329s wall clock, two of them carry real regression risk, and the acceptance metric it proposes
structurally cannot measure three of its own five steps.** The actual dominant lever — duration-aware
shard partitioning — is never considered, and the repo already has the measurement infrastructure for
it, unused.

---

## 0. Two premise errors before any step

### 0.1 The acceptance metric is not wall-clock, and is blind to half the plan

`criticalPathMs` is computed in [`scripts/release-and-publish.mjs`](../../scripts/release-and-publish.mjs)
(the `perJob` reduction feeding the `[release] critical-path` log line) as:

```js
const criticalPathMs = perJob.reduce((max, j) => Math.max(max, j.ms), 0);
```

That is **max-of-jobs, not the longest dependency chain.** The publish workflow's job graph is:

- `gate` (83s) and `test` (matrix, max 259s) — no `needs`, run in parallel
- `publish` — `needs: [gate, test]`, 70s

So real release wall-clock ≈ `max(83, 259) + 70` = **~329s**, not 259s. `criticalPathMs` silently
drops the entire 70s publish tail.

Consequence for the plan: **steps 3 and 5 only touch the `publish` job, and step 4 only touches the
`gate` job — none of the three can move `criticalPathMs` at all.** The plan proposes changes and then
picks a metric that is structurally incapable of registering them. Its own acceptance checkpoint would
score them as zero-effect regardless of whether they worked.

Fix before anything else: make the profiler compute a real critical path over `needs` edges, or the
whole exercise is being steered by the wrong number.

### 0.2 "Duplicate but different gates" is not accurate

The summary claims `ci.yml` and `audit-code-test-suite.yml` "run duplicate but different gates." They
are **complementary, not duplicate**:

- `ci.yml` → one job, no matrix, runs `verify:checks` only (non-test gates + build + smokes)
- `audit-code-test-suite.yml` → 2 Node versions × 4 shards = 8 jobs, runs the vitest suite

Also, both **skip on release-bump commits** (`release: v<digit>` predicate), so on the release commit
they do not run at all — the release path is gated solely by `publish-package.yml`. The plan's caution
about "PR/commit cost explosion" is therefore guarding a path that is already inert at release time.

The real finding hiding here, which the plan misses, is an **asymmetry in the opposite direction**: the
PR path tests Node 20.19.2 **and** 22.14.0, while the release path tests only the runner default. The
release gate is *weaker* than the PR gate. That is a quality question worth an explicit decision, and
it is nowhere in the plan.

---

## 1. Step 1 (4→6 shards) — empirically refuted

This is the only step aimed at the actual driver, and it does not work, for a mechanical reason.

### How vitest actually shards

`BaseSequencer.shard()` (vitest 3.2.6, `node_modules/vitest/dist/chunks/coverage.DfSpMS-b.js:3457-3470`):

```js
const shardSize  = Math.ceil(files.length / count);
const shardStart = shardSize * (index - 1);
const shardEnd   = shardSize * index;
return [...files]
  .map(spec => ({ spec, hash: hash("sha1", specPath, "hex") }))
  .sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0)
  .slice(shardStart, shardEnd)
```

Partitioning is a **contiguous slice of a fixed sha1-of-path ordering**. It is **duration-blind** and
**count-balanced only**. Two facts follow:

1. Changing `count` does not reshuffle the ordering — it only moves the cut points.
2. Therefore any cluster of slow files that is *adjacent in hash order* **stays together** unless a cut
   happens to land between them. With 578 files and 5 interior cuts, the odds of splitting any given
   adjacent pair are ~1%.

### The cluster demonstrably does not split

Replicating the exact algorithm against the current 578 tracked test files, tracking the 9 files the
repo's own `verify:guards` script excludes as heavy/flaky (`audit-code-completion`, `audit-code-wrapper`,
`audit/next-step`, `seam-host-only-next-step`, `next-step-implement-dispatch`,
`next-step-pipeline-dispatch`, `*-e2e`):

| N | Shard holding the top cluster | Cluster contents |
|---|---|---|
| **4** | shard **1**/4 (3 heavy) | `audit/next-step`, `audit/audit-code-wrapper`, `remediate/hybrid-nim-e2e` |
| **6** | shard **2**/6 (3 heavy) | **identical three files** |
| **8** | shard **2**/8 (3 heavy) | **identical three files** |

Shard 1/4 carrying the densest heavy cluster matches the observed 235s worst shard. Going to 6 — or
even 8 — **keeps all three of those files in one shard.** The only thing 4→6 buys is removing ~48 of the
*other* ~145 light files from that shard's tail.

So the plan's core mechanism does not address the skew by *separating* the cluster it names as the
target. It reduces the worst shard only by stripping light files off its tail — which, per the direct
measurement in §8, converges on a hard floor it cannot cross. See §8 for the corrected numbers.

### The plan's own target is not derivable from its mechanism

Total shard test time = 235 + 109 + 78 + 66 = **488s**. Per-shard fixed overhead ≈ 24s
(setup 1 + checkout 2 + node 5-7 + install 3 + build 9-11).

| Scenario | Slowest test job |
|---|---|
| Today (4 shards, skewed) | 259s |
| **Perfect balance at 4 shards** | 488/4 + 24 = **~146s** |
| Perfect balance at 6 shards | 488/6 + 24 = **~105s** |

**~78% of the total achievable gain (259→146) comes from fixing the skew at the shard count you already
have. Only the remaining ~22% (146→105) comes from adding shards.** The plan picks the small lever and
skips the large one — and its stated target of 170–190s sits between the two with no derivation
connecting it to the change being made.

Cost side, unaccounted for: 6 shards means 2 more jobs × ~24s of setup/install/build, plus `globalSetup`
runs once per shard. That is ~48s more runner time and two more independent chances to hit a flake, in
exchange for an unbounded outcome.

---

## 2. The lever the plan missed — duration-aware partitioning

`BaseSequencer.shard()` is `async so it can be extended by other sequelizers` (vitest's own comment).
Vitest supports `sequence.sequencer` in config. A custom sequencer that partitions by **recorded
duration** (greedy longest-processing-time) instead of by hash turns the 259s worst shard into ~146s
**with zero additional jobs** — roughly 2.4× the gain of the plan's step 1, at lower runner cost.

The timing data required already exists and is already being produced:

- `vitest.config.ts` registers `./scripts/shared/vitest-timing-reporter.mjs`
- `run-vitest-gate.mjs` writes `.audit-tools-profile/vitest-shard{N}of{total}-latest.json`,
  including a `slowest` array of `{file, ms, collectMs, runMs}`

**CI produces these ledgers on every run and then throws them away** — the only `upload-artifact` steps
in all three workflows are `if: failure()` and upload npm logs. Making the ledger upload unconditional
is a ~2-line change that unlocks the entire duration-aware approach.

Sequenced properly:

1. Upload the per-shard vitest ledgers unconditionally.
2. Commit a merged `tests/timings.json` (or regenerate periodically).
3. Add a custom sequencer doing LPT partitioning against it, falling back to `super.shard()` when a file
   has no recorded timing (new files degrade to today's behavior — no cliff).
4. *Then*, if still warranted, revisit shard count with real balance in hand.

This also fits the repo's standing rule that a correctness property must be mechanically enforced rather
than left to chance — hash-lottery balance is precisely the "works because we got lucky" shape the
project bans.

Secondary, cheaper lever also missed: `vitest.config.ts` sets **no** `pool`, `poolOptions`, `maxWorkers`,
`fileParallelism`, or `isolate`. Defaults apply (`forks`, isolated). Tuning `poolOptions.forks.maxForks`
to the runner's core count, or evaluating `pool: 'threads'`, is a within-shard lever that compounds with
partitioning. Flag: `isolate: false` would be a genuine hermeticity risk given this repo's history — do
not take it without measurement.

Third lever missed: `npm run build` (9–11s) runs in **every** test shard plus `gate` plus `publish`. The
plan applies build-artifact sharing only to `publish` (1 occurrence, 11s) and misses the 4–6 shard
occurrences where the same idea is worth 4–6×.

---

## 3. Step 2 (`--ignore-scripts` on `npm ci`) — wrong on facts, wrong on payoff, and risky

Three separate problems.

**(a) The flags are mostly already there.** The plan presents this as switching install lines to
`npm ci --ignore-scripts --prefer-offline --no-audit --no-fund`. But `publish-package.yml` and `ci.yml`
**already use** `--prefer-offline --no-audit --no-fund`. The only new flag is `--ignore-scripts`. (Only
`audit-code-test-suite.yml` uses bare `npm ci` — a real inconsistency the plan didn't isolate, worth
fixing on its own merits.)

**(b) The payoff is ~2 seconds.** With `cache: npm` already set on `actions/setup-node@v5` in all three
workflows, the measured "Install dependencies" steps are **2–3s**. Against a ~329s wall clock this is
under 1%, and in the `test` job it is not even on the critical path relative to the 235s test run.

**(c) The stated rationale is false.** The plan asserts "none of these jobs require package postinstall
behavior for correctness." The repo has:

```json
"postinstall": "node scripts/postinstall.mjs",
"prepack":     "npm run build",
"prepublishOnly": "npm run verify:release",
```

`scripts/postinstall.mjs` is not a no-op — it deploys host assets (`~/.claude/commands/`, `~/.codex/skills/`,
OpenCode/Antigravity manifests) and calls `ensureArtifactGitignore`, which **mutates the consuming repo's
`.gitignore`**. Additionally, three dependencies carry `hasInstallScript`: `esbuild`,
`vite/node_modules/esbuild`, and `fsevents` — and vitest's toolchain runs on esbuild.

Postinstall behavior is *product surface under test here*: `smoke-packaged-remediate-code.mjs` explicitly
sets `npm_config_dangerously_allow_all_scripts: "true"` so postinstall runs, then asserts
`~/.claude/commands/remediate-code.md` was deployed and its content matches source. Globally disabling
scripts at the repo root diverges CI from the install path the product actually ships.

**Recommendation: drop step 2.** Optionally keep the unrelated, genuinely correct half — align
`audit-code-test-suite.yml` to the same `--prefer-offline --no-audit --no-fund` the other two use.

---

## 4. Step 3 (guard the npm upgrade) — 4s, and the guard is the classic semver bug

Measured cost of `Upgrade npm for trusted publishing`: **4s** out of a 70s publish job, ~1.2% of wall
clock. The current line is already `npm install -g npm@11.5.1 --ignore-scripts`.

The plan's assumption 1 states "assume `npm 11.x+` is required for trusted-publish behavior." **This is
wrong in a way that makes the proposed guard dangerous.** Trusted publishing requires npm **≥ 11.5.1**
specifically; 11.0–11.4 do not support it. A guard written against "11.x" admits versions that cannot
publish.

Worse, the natural shell implementation is a string comparison, and `11.10.0 < 11.5.1` lexically — so a
naive guard skips the upgrade on a runner that is *newer* and then either fails the publish or silently
falls back to a different auth path. This is a 4-second saving bought with a correctness hazard on the
one step in the pipeline that is hardest to roll back.

**Recommendation: drop step 3.** The pinned install is deterministic and cheap; it is not the problem.

---

## 5. Step 4 (split smoke checks into separate jobs) — provably zero wall-clock gain

The plan's baseline for this step comes from `verify-checks-latest.json`, which is a **local win32 run**
(122.1s total, `smoke:packaged-audit-code` 76.1s). The corresponding CI measurement is the `gate` job:
`Verify release checks (non-test gate)` = **70s**, whole job = **83s**.

`gate` runs in parallel with `test` (259s). It has **176s of slack.** Splitting its 76s smoke step into
separate jobs:

- removes nothing from the critical path (the critical path is `test` → `publish`),
- **adds** two new jobs each paying ~15–20s of checkout/node/install setup,
- adds two more `needs` edges to `publish`, i.e. two more independent failure/flake surfaces before the
  publish step.

The plan concedes this itself — "lets the heaviest `test` shard remain the real critical driver" — which
is an admission that the step's gain is zero. It is a strict cost.

**Recommendation: drop step 4.** If `gate` ever becomes the critical path (it would need to exceed 259s),
revisit then.

---

## 6. Step 5 (share `dist/` artifact into publish) — ~11s, and it weakens the publish invariant

Gain is bounded by the publish job's `Build dist for packing` step: **11s** of a ~329s wall clock (~3%),
and — per §0.1 — invisible to the metric the plan proposes to judge it by. `actions/upload-artifact` +
`download-artifact` typically costs 5–15s round trip, so the **net gain is plausibly zero or negative.**

Correctness note the plan doesn't raise: `npm publish --ignore-scripts` (line 234) means **`prepack` does
not run** at publish time, so the tarball contains exactly whatever is in `dist/` at that moment. Today
that is built in-job from the checked-out commit. Consuming a downloaded artifact instead means the
published bytes were produced by a *different* job — losing the "built from this checkout, in this job"
property on the one artifact that reaches users. For a ~3% saving that is a bad trade.

If build-sharing is wanted, apply it where it repeats — the 4–6 test shards (§2) — not to the single
publish build.

---

## 7. What a corrected plan looks like

Ordered by (gain × confidence) ÷ risk:

| # | Change | Est. wall-clock | Risk |
|---|---|---|---|
| 1 | Fix `criticalPathMs` to walk `needs` edges — measure the real 329s | 0 (unblocks everything) | none |
| 2 | Upload per-shard vitest ledgers unconditionally | 0 (unblocks #3) | none |
| 3 | **Duration-aware custom sequencer (LPT), keep 4 shards** | **259 → ~146s** | low — hash fallback for untimed files |
| 4 | Build once, share `dist/` across test shards | ~10s + runner minutes | low |
| 5 | Tune `poolOptions.forks.maxForks` to runner cores | measure first | low |
| 6 | Revisit shard count *after* balance is real | ~146 → ~105s | adds 2 jobs |
| 7 | Align `audit-code-test-suite.yml` npm ci flags with the others | ~1s | none |
| — | ~~Steps 2, 3, 4, 5 as written~~ | ~20s combined | two carry real hazards |

Open decision for the owner: the release path tests one Node version while the PR path tests two (§0.2).
Either is defensible; the current split is probably unintentional.

## 8. Direct measurement of shard 1/4 — and a correction to §1 and §2

The proxy used in §1 was the `verify:guards` exclusion list, which is a **flake list, not a duration
list**. It has now been replaced with a real measurement: `run-vitest-gate.mjs --shard=1/4` on
win32/cpu16, ledger `.audit-tools-profile/vitest-shard1of4-latest.json`.

**Result: 145 files, 1,910 passed / 0 failed / 6 skipped, `wallSummedMs` 765,530ms,
`collectMs` 97,995ms.** (`wallSummedMs` is summed per-file time across parallel workers, not wall
clock.)

| File | ms | % of shard |
|---|---|---|
| `tests/audit/audit-code-wrapper.test.ts` | 157,015 | **20.5%** |
| `tests/audit/next-step.test.ts` | 119,738 | **15.6%** |
| `tests/shared/pre-commit-gate-staged-snapshot.test.ts` | 75,085 | **9.8%** |
| `tests/audit/next-step-narrative.test.ts` | 64,530 | 8.4% |
| `tests/remediate/dispatch-worktree-safety.test.ts` | 40,098 | 5.2% |
| `tests/remediate/dispatch-worktree.test.ts` | 39,376 | 5.1% |
| `tests/audit/finalization-cycle-guard.test.ts` | 34,745 | 4.5% |
| `tests/shared/nightly-routine-prompt-gate.test.ts` | 25,304 | 3.3% |
| `tests/audit/worker-run-command.test.ts` | 23,797 | 3.1% |
| `tests/remediate/accept-node-loop-core-guard.test.ts` | 19,917 | 2.6% |

**Top 3 = 45.9%. Top 10 = 78.3%. The remaining 135 files = 21.7%.** Concentration confirmed, and two of
the top three (`audit-code-wrapper`, `next-step`) are exactly the cluster §1 predicted stays co-located
at every N.

### The correction: sharding has a floor, and both §1 and §2 understated it

**Vitest shards at *file* granularity, and runs the tests inside a file serially by default** (no
`sequence.concurrent` / `test.concurrent` in `vitest.config.ts`). Therefore:

> **The slowest shard can never be faster than the single longest test file — at any shard count, under
> any partitioning strategy.**

`audit-code-wrapper.test.ts` is ~157s of serial single-worker time (154.8s of it `runMs`). That is a
hard floor of ~157s for whichever shard holds it.

This forces two revisions to what I wrote above:

- **§1 was too harsh.** 4→6 does yield a real reduction — not by splitting the cluster, but by stripping
  ~48 light files off the heavy shard's tail. Extrapolating, shard 2/6 would land somewhere near
  **~170–180s**, i.e. roughly the plan's stated 170–190s target. The plan's *number* is plausibly
  reachable. Its *reasoning* still does not derive it, and more importantly this is the **end** of the
  sharding road, not a first step: 8 shards would buy essentially nothing more, because the floor is
  already in sight.
- **§2 was too optimistic.** The "perfect balance at 4 shards → ~146s" figure is **below the ~157s
  single-file floor and therefore unreachable.** Duration-aware partitioning at 4 shards converges to
  the same ~157–175s that 6 hash-shards reach — but without adding two jobs. That is still the better
  trade, just for a smaller margin than §2 claimed.

### The lever that actually breaks the floor

Neither the plan nor my §2 addresses the thing that dominates: **three files are 46% of the shard.**
Sharding cannot subdivide a file; only the file's own structure can.

1. **Split or parallelize the top 3.** `audit-code-wrapper.test.ts` (157s), `next-step.test.ts` (120s),
   `pre-commit-gate-staged-snapshot.test.ts` (75s). Either split each into several files (immediately
   shardable and independently schedulable) or mark independent cases `test.concurrent` /
   `describe.concurrent`. These are spawn-heavy suites — wrapper CLI invocations, git staging snapshots
   — so they are latency-bound, not CPU-bound, and should parallelize well. **This is the only change
   that gets the suite below ~157s.**
2. The `dispatch-worktree*.test.ts` pair (79s combined) creates real git worktrees — a known-expensive
   fixture and a candidate for a shared setup.
3. `collectMs` is 98s of 765s (**12.8%**) — pure TS transform overhead, paid before any assertion runs.
   Worth a look at transform caching independently of everything above.

### Revised priority ladder (supersedes §7's table where they differ)

| # | Change | Est. effect on slowest shard | Risk |
|---|---|---|---|
| 1 | Fix `criticalPathMs` to walk `needs` edges (§0.1) | 0 — unblocks honest measurement | none |
| 2 | Upload per-shard vitest ledgers unconditionally | 0 — unblocks #3/#4 | none |
| 3 | **Split / `concurrent`-ify the top 3 hotspot files** | **breaks the ~157s floor — the only step that does** | medium — must preserve hermeticity |
| 4 | Duration-aware sequencer at 4 shards | 235 → ~157–175s, no new jobs | low |
| 5 | Build once, share `dist/` across shards | ~10s | low |
| 6 | 4→6 shards | subsumed by #3+#4; only worth it after the floor is broken | adds 2 jobs |
| — | ~~Plan steps 2, 3, 4, 5~~ | ~20s combined | two carry real hazards |

Note the ordering inversion against the original plan: its step 1 becomes item **6**, worth doing only
*after* the hotspot files are broken up — otherwise it buys a one-time ~60s and then dead-ends.
