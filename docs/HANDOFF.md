# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of what is open. Durable
> how-to is in `CLAUDE.md`; per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This is the *sequencing* view — every open item appears once, in suggested order, with a
> pointer to its detail. **Shipped detail is `git log`, never this doc.**

## Live state

- **Current version = `package.json`** (authoritative).
- **Tree is green and published.** The dispatch/quota fix cluster, unified-routing collapse, and the
  proxy-contract swap all shipped.
- **⚠ Stale-worktree trap:** ALWAYS `git fetch audit-tools main && git log HEAD..audit-tools/main`
  before starting a lap — a worktree can branch behind main and must fast-forward + re-read
  HANDOFF/backlog first.
- **Local env:** npm 12 blocks dependency install scripts by default and can emit object-shaped
  `npm pack --json`. Smokes are fixed, but read `docs/backlog.md` → *Durable traps* before any manual
  `npm install -g` / packaged-install work.
- **Offload lane changed:** `llm-worker-tools` (`llm read`/`llm write`) is RETIRED. Bulk recon goes
  direct to the local LiteLLM proxy — see `~/.claude/CLAUDE.md` → *Offload lane*. The proxy must be
  running; there is no standalone fallback.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial pipeline only for
  risky/complex changes; trivial mechanical clusters run lean. Tool-enforced via the risk-tier → Dial
  A/B fold, not host discretion.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three
  categories (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog +
  `open_observations`. Mechanically backstopped by step-boundary capture, an in-run per-category gate,
  and a session-end Stop-hook.
- **Release:** `npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run `npm run verify:release` locally before
  tagging — the local pre-tag gate is only `check`.
- **End every lap by checking CI on `main`.** `ci` and `audit-code-test-suite` were red for ~a dozen
  laps while every lap reported "green": the pre-commit hook gates only `npm run check`, and laps
  verified with build + check + vitest — none of which include `verify:checks`. The per-workflow runs
  endpoint (`gh api "repos/…/actions/workflows/<wf>.yml/runs?per_page=3"`) is the reliable one; the
  generic `gh run list` has been flaky ([[lap-green-must-match-ci-evidence]]). A local "N failed" must
  be resolved to NAMED files before being waved at as the known-flaky baseline.
- **Branch-strand trap (bit twice):** a remediation run leaves you checked out on its worktree branch —
  commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit strands.
- **Never pass `isolation: "worktree"` to the Agent tool** when dispatching a remediate-code/audit-code
  implement node — the dispatch plan already names the correct worktree; a second one strands the
  subagent's edits where `accept-node` can't see them.
- **Loop-core** (`src/shared/dispatch/`, `src/shared/quota/`, `intakeExecutors.ts`, `dispatch.ts`,
  `marshal.ts`, `steps/nextStep.ts`, `costRank.ts`) → green + independent review + attestation required.

---

## ▶ IMMEDIATE NEXT

**1. Account metering — the COOLDOWN axis was never migrated.** The budget axis is closed and verified
by execution; the cooldown fold still uses the older per-source derivation, so budget and cooldown now
answer "which account is this?" two different ways. A 429 on one model still fails to throttle its
siblings for the motivating cases (inline-credential sources, proxy-fronted sources). Detail +
the two traps that make the obvious fix wrong: `docs/backlog.md` → *Open bugs*, and
[[account-metering-closed-producer-decides-partition]]. **Do not reopen the budget half.**

**2. `wip/capability-evidence` — decide its fate.** Review-blocked across four rounds, pushed, NOT on
main, and now the source of stale-looking backlog entries because every symbol it introduces is absent
from HEAD. Green was never the blocker. Six properties must hold before it lands (backlog entry has
them). Read the review before touching it, and do not re-implement from the plan:
[`capability-evidence-implementation-review-2026-07-18.md`](reviews/capability-evidence-implementation-review-2026-07-18.md).
Owner decisions already settled — injection at the `CapacityPool` constructors not the admission loop;
the host pool is not a special case; headless unrankable models go to an LLM ranker (not a recorded
fail-open), with LLM provenance kept out of the operator's raw capability order; an active cooldown
grants one.

**3. Re-dogfood a conversation-first self-audit through the live proxy.** Validates the two above plus
the proxy track's leftovers (dispatch under a real wave, quota behavior at the proxy). Launch recipe
below.

**4. Gate-0 priority-order UX** (Track 3) — two named owner calls, see backlog.

---

## Open tracks

**Track 1 — LiteLLM proxy.** Stood up and validated 2026-07-18 (config at
`~/.audit-code/litellm-config.yaml`; record in
[`litellm-proxy-live-validation-2026-07-18.md`](reviews/litellm-proxy-live-validation-2026-07-18.md)).
**Remaining:** dispatch through the proxy under a real audit wave, and quota/rate behavior at the
proxy — both fold into the re-dogfood above.

**Track 2 — Ranker contract.** A separate project, not audit-tools code. The *producer* now exists and
is validated live (NIM roster joined to OpenRouter `agentic_index` → LiteLLM `model_info`), and the
consuming seam already ingests it — so this needed **zero audit-tools code change**. What remains is a
contract question, not a build: where a ranks artifact lives and how audit-tools reads it, such that
swapping, starting, or removing the ranker changes zero audit-tools source. Still hand-run, not a
refreshed pipeline.

**Track 3 — Gate-0 operator-confirmed priority order.** The machinery exists end-to-end; what is
missing is prompt clarity plus a fallback when no ranks exist. Two open owner calls: whether a
suggested fallback order lists every pool or only the capable-and-above tiers, and how an
operator-confirmed order composes with λ (the cost↔speed bias).

**G-series — closed as a sequence.** Do not reopen G4/G5/G6 as laps. Two slivers survive on their own
merits and are backlog-tracked: the **G6 read-path unification** (audit and remediate still read their
session config from disjoint paths, so policy rides the confirmation artifact rather than the intent)
and **G5's lies-reachably quarantine**. Records:
[`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) ·
[`g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).

**WAITING (gated, not next): D-66/67 slice-3** — heartbeat / merge-time ownership gate on the
LONG-lived execution claims. Delicate, focused-lap, **live-run-gated**: only pursue if a real
cooperative run shows the probe window actually bites. Its own blocker is a real design question —
long claims are held across out-of-process worker runs with no looping parent, so who beats the
heartbeat during that span is undecided. ([[rolling-lifecycle-unify-full-unification-wrong]] governs:
full unification is the WRONG endpoint.)

---

<details><summary>Reusable launch recipe for a maximal-coverage validation run</summary>

**Where.** A Claude Code conversation at the **primary `C:\Code\audit-tools` checkout, branch `main`,
clean tree — never a lap worktree** (slash workflows run the GLOBAL bin, so worktree state is
irrelevant, but scratch/artifacts must land on main's tree). Verify the global bins are current
(`audit-code --version` == `package.json` on main). Target: audit-tools itself is fine and has a
pending clean self-audit on record; if a genuinely LARGER metered target is available, prefer it —
**size is what forces the quota wall**, and a small target validates none of the wall items. On
audit-tools, compensate with a deep ceiling so the frontier is large.

**Configure first.** Source pools are declared **off-repo** in `~/.audit-code/sources-declared.json` —
start from `examples/catalog/sources-declared.json`. Include a NIM entry (operator-supplied endpoint /
model / key env, never hardcoded) and the **opencode-free** entry, which exercises arbitrage Phase-0
declared-free routing plus the cost-drift demotion if a free tier ever bills. Codex needs nothing — the
CLI is auto-detected. No `--root`/provider/model flags anywhere; a needed manual flag is a bug — report
it, don't work around it.

⚠ **Export the key env vars in the shell that launches the IDE.** A lane is admitted only if the process
can PROVE reach — a key env var pointing at an unset variable is dropped with a reason, by design. If a
pool is missing from Gate-0, that is the mechanism working; check the env, not the config.

**Launch.** `/audit-code`. At the interactive Gate-0, confirm the priced roster shows host + codex +
NIM + opencode-free; accept the proposed lens set; pick a deep ceiling. Then let it run — **do not
rescue it at the wall; the failure modes ARE the data.** Resume after the quota window resets.

**Mid-run, uniquely valuable:** open a **second IDE session** on the same repo mid-wave and start a
step. That is the only live check for the lease-TTL fix ([[host-path-quota-enforcement]]) and the
multi-IDE concurrent-admitter model — the second admitter must see the account's cap still held while
the first wave is in flight. It is also the run that would show whether D-66/67 slice-3 is worth doing.

**Watch:** `docs/backlog.md` → *Live-validation guide*; each item's ⬇ Live-run watch line is the
authoritative pass/fail.

**Fail-signal protocol:** any wedge needing `force-synthesis`, a crash at the wall, orphaned
`deepening:*` tasks, a silently-skipped analyzer, or a missing friction event → one line under backlog
*Open bugs* before moving on.

**After the run:** hand-label the findings into `corpus/<run-id>.labels.json` — one labeled run is the
only thing blocking the A2 finding-quality oracle.

**What this run canNOT cover:** clippy/rubocop live spawn (needs a Rust/Ruby repo + toolchain — none on
this box); Copilot/Antigravity quota endpoints (need those IDEs running); the gated e2es (creds + env
vars, runnable any time).

</details>

---

## Suggested ordering — rationale

The **loop is the meta-tool**; making it cheaper, convergent, and safe compounds on all downstream work
([[autonomous-pipeline-capstone-spec]]). With the code tracks closed, the live-validation run IS the
current loop-improvement work — it gates "redesign before scheduled autonomy" advancing to the
scheduled audit→remediate→PR capstone.

Everything else open is in [`backlog.md`](backlog.md), which is the per-item detail of record:
*Open bugs / frictions* (fixable defects), *Forward tracks* (design-level directions), *Deferred /
waiting* (blocked on data or environment), *Durable traps* (standing environment reference).

**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Backlog prose decays: a
2026-07-19 classification pass found ~21% of entries were already shipped, stale, or describing code
that lives only on an unmerged branch.

⚠ **Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

Each lap: pick the next item, **risk-tier it**, ship, reinstall, **full friction walk**, update this
ordering.
