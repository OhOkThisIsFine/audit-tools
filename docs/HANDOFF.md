# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + **the immediate next step, and nothing else**.
> Durable how-to is in `CLAUDE.md`; per-item detail and the FULL open set in the split backlog
> [`docs/backlog/`](backlog/) (seek index: [`backlog.md`](backlog.md)); durable design in `spec/`.
> This doc is deliberately NOT an index of open work — it answers "what do I do next", and the
> backlog answers "what is open". The *Next* list is **generated** from the backlog
> (`scripts/shared/generate-handoff-roadmap.mjs`) and carries only entries pinned with `▶` there, so
> an item's text has exactly one home and the two cannot drift.
> **Shipped detail is `git log`, never this doc.**

## Live state

- **▶ NEXT: work the actionable backlog queue.** Start from the triage
  ([`backlog-triage-2026-07-25.md`](reviews/backlog-triage-2026-07-25.md)) — every open entry classified,
  regenerate with `node scripts/shared/triage-backlog.mjs`. Then use the SEEK INDEX in
  [`backlog.md`](backlog.md): each entry carries a `file:line` anchor, so read the index once and jump
  with an offset read instead of paging the file blind.
  ⚠ **The triage's verdicts are ADVISORY.** The lane over-flags `owner_decision_needed` (its hedge is
  "schedule a discussion"), and it cannot check HEAD. Verify a premise before working it — the same
  2026-07-25 walkthrough that found 15 of 21 nightly items already fixed also opened three triage
  entries whose premise was already fixed ([[backlog-prose-decays-verify-against-head]]).

- **⚠ Every owner call is ANSWERED — nothing is waiting on a decision.**
  Nightly-queue determinations live in `.claude/nightly-decisions.json`, settled by SUBJECT so they are
  never re-raised. The ledger now separates ANSWERED from DONE: `answer.mjs --list` reports both, and
  a determination leaves the list only via `--done <key> <ref>` naming the landing (or `--question`
  for a counter-question). Answers settled before that tracking began are `--settled` history and make
  no landing claim. **Two answered determinations remain UNEXECUTED** (both approved builds, each a
  full lap with a design pass first): the nightly/triage **premise probe** (`ea4e616f` — probe at
  creation AND presentation) and **guard reach as declared data** (`ec64d159` — the
  check:doc-manifest manifest-as-data shape over every guard).
  Two remain owner-OWNED and no lap can close them: the **A7 GUI host checklist** (a human at
  Antigravity / OpenCode / VS Code) and the **dogfood run** below.
  ⚠ Two decision traps to read before building: the per-site pinning gate's diff-derived site list does
  NOT solve its second property (expected-failing test names are still author-supplied, so a naive build
  relocates the claim instead of removing it); and contract-pipeline (b) narrows the
  whole-artifact-rewrite invariant, so it must be scoped to rejections naming specific fields.

- **The dogfood self-audit is the OWNER's, in a separate conversation, after the code fixes land.**
  14 `⬇ LIVE-run watch` entries are blocked only on evidence from it (9 in `open-bugs.md`, 5 in
  `forward-tracks.md`). A lap lands what it can WITHOUT
  the run and must not start one: a commit mid-run re-stales the planning chain and regresses it to
  `charter_extraction`. Recipe is in the collapsed section below.

- **⚠ A credential is NAMED, never pasted — inline `api_key` is retired on both declaration shapes.**
  A config carrying one is REFUSED at validation with an actionable message; that refusal is the
  load-bearing half, because the validator ignores unknown keys and a merely-deleted field would leave
  a pasted key silently dropped and the source launching keyless. Old ledger state carrying an
  `::inline:<hash>` credential segment stays readable as opaque history — never reject that prefix.

- **⚠ `reviewed_clean` is a hard contract on every zero-finding `AuditResult`.** An empty `findings`
  array is REFUSED unless the result also sets `reviewed_clean: true`, and the flag is refused ALONGSIDE
  findings. A worker or fixture written against the older contract fails validation — that is the gate,
  not a regression. A contract sweep must therefore grep the TYPE across the whole repo: the
  `reviewed_clean` sweep globbed `tests/**`, went green four ways locally, and failed release CI on two
  producers in `scripts/`.

- **⚠ The per-node token estimate is WIRED and has NO live evidence yet.** It is the first change that
  makes the `no_capable_pool` resumable pause reachable in real use. On the next real frontier an
  unplaceable node must reach a RESUMABLE pause naming the real cause — never `empty_pool`, never a
  terminal strand. A large node that now refuses everywhere is the honest estimate working; check the
  pool's declared `context_tokens` before calling it a regression.

- **⚠ Regenerating the price snapshot INVERTS host tier cost order — still live.** `npm run update-models`
  rewrites the flat table, whose entry for a colliding id is the CHEAPEST across providers by
  construction, so `claude-opus-4-8` ranks below haiku and cost-first routing at λ=0 sends every packet
  to Opus. The service→vendor-id mapping is a PREREQUISITE, not a follow-up. Do NOT "fix" it by editing
  `cost-rank.test.ts`'s expectations — they encode real list prices and are what caught it.

- **A2 oracle corpus is funded, not deferred** — the mechanical answer to per-lane result quality.
  Corpus is SMALL, PUBLIC, PINNED git repos, never labeled self-audit runs. SPEC in
  [`forward-tracks.md`](backlog/forward-tracks.md).

- **Current version = `package.json`** (authoritative): v0.34.41, live on npm. HEAD sits AHEAD of the
  tag, and that is the normal resting state — docs, specs, tests and hooks land without a release. Read
  "nothing pending" off the DIFF, not off the commit count:
  `git diff --name-only $(git describe --tags --abbrev=0 --match 'v*')..HEAD -- src/ package.json`
  empty ⇒ nothing publishable. A bare "released to HEAD" claim here went false the moment the next docs
  commit landed, which is the class of status line this doc is not supposed to carry.

**Per-release shipped detail is `git log` and the `docs/reviews/` records — deliberately not restated
here.** This section had twice grown into version-by-version narration, which is the changelog creep this
doc's own header forbids. Durable traps belong in
[`durable-traps.md`](backlog/durable-traps.md), durable design in project memory, durable how-to in
`CLAUDE.md` — if a bullet here is none of those three and is not the immediate next step, delete it.

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
- **CI on `main` is checked BY THE CLOSEOUT GATE, not by remembering.** The gate names any workflow
  whose latest completed run failed (`scripts/shared/ciRedWorkflows.mjs` holds the verdict; the hook
  makes the call). The rule used to live here as an instruction and failed twice anyway — red for ~a
  dozen laps once, and again 2026-07-25 when `ci` stayed green across three commits while
  `audit-code-test-suite`, the only workflow that runs vitest, was red
  ([[lap-green-must-match-ci-evidence]]). **A green local suite does not clear a red workflow** — the
  pre-commit hook gates `check`, and laps verify build + check + vitest, none of which is
  `verify:checks`. A local "N failed" must still be resolved to NAMED files before being waved at as
  the known-flaky baseline.
  ⚠ The gate fails OPEN — no `gh`, no auth, no network, or a 503 all read as "cannot tell", so silence
  from it is not evidence of green. Neither `gh` endpoint is dependably up: try BOTH before concluding
  anything. The per-workflow form (`actions/workflows/<wf>.yml/runs`) was the reliable one until
  2026-07-19, when it began returning 503 while `actions/runs?per_page=N` (filter by `head_sha`
  yourself) answered immediately.
- **Never pass `isolation: "worktree"` to the Agent tool** when dispatching a remediate-code/audit-code
  implement node — the dispatch plan already names the correct worktree; a second one strands the
  subagent's edits where `accept-node` can't see them.
- **Loop-core** → green + independent review + attestation required. The authoritative list is the
  `LOOP_CORE_PATTERNS` array in `src/shared/loopCorePaths.ts` (16 entries), from which
  `.claude/hooks/loop-core-patterns.mjs` is generated and both gate hooks import it. **Read the
  array, never a copy** — the paraphrase that used to sit here named 7 of the 16 and included files
  that are not canonical entries, which under-states which commits need attestation.
- **G-series — closed as a sequence.** Do not reopen G4/G5/G6 as laps. Two slivers survive on their
  own merits and are backlog-tracked (the G6 read-path unification and G5's lies-reachably
  quarantine); they appear in the roadmap below like any other entry. Records:
  [`dispatch-fork-assessment-2026-07-16.md`](reviews/dispatch-fork-assessment-2026-07-16.md) ·
  [`g4-g5-g6-premise-check-2026-07-16.md`](reviews/g4-g5-g6-premise-check-2026-07-16.md).
- **Backlog budget:** run `node scripts/check-backlog-budget.mjs` for the live figures; the two open
  defects in its ratchet are tracked in [`open-bugs.md`](backlog/open-bugs.md).

---

## ▶ Next — the immediate work only

**Standing priority: stabilize audit-tools before A2.** The active track is **runtime-loop
defects**, not the A2 oracle corpus. A2 is funded and its SPEC is intact
([`forward-tracks.md`](backlog/forward-tracks.md)) — it is simply not the current track.

<!-- BEGIN GENERATED ROADMAP — scripts/shared/generate-handoff-roadmap.mjs — DO NOT EDIT BY HAND -->

> **This list is GENERATED from [`docs/backlog/`](backlog/) — do not hand-edit it.**
> It is the IMMEDIATE NEXT work only, never the full open set. Prefix an entry's bold title with
> `▶` in the backlog file that owns it and it appears here; empty means nothing is
> pinned, which is a statement rather than an omission.
> **Every open item lives in [`docs/backlog/`](backlog/)**, reachable by the seek index in
> [`backlog.md`](backlog.md) — this block is not a second index of it.
> Every line is a POINTER: the backlog entry's own title, verbatim, and a link to the file that
> holds its spec. Nothing here restates a spec, so this list and the backlog cannot drift.
> Regenerate: `node scripts/shared/generate-handoff-roadmap.mjs` (`--check` gates it in
> `verify:checks` and at commit). 1 pinned item(s).

### ▶ Next up — pinned in the backlog

- ▶ ⬇ LIVE-run watch ONLY — the per-node token estimate is WIRED (2026-07-25, loop-core). · [`open-bugs.md`](backlog/open-bugs.md)

<!-- END GENERATED ROADMAP -->

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

**Watch:** [`docs/backlog.md`](backlog.md) → *Live-validation guide*; each item's ⬇ Live-run watch line is the
authoritative pass/fail.

**Fail-signal protocol:** any wedge needing `force-synthesis`, a crash at the wall, orphaned
`deepening:*` tasks, a silently-skipped analyzer, or a missing friction event → one line under backlog
*Open bugs* before moving on.

**After the run:** findings may optionally be hand-labeled as large-target calibration data — the
A2 oracle corpus itself is pinned public repos (see backlog *Deferred / waiting*), not labeled runs.

**What this run canNOT cover:** clippy/rubocop live spawn (needs a Rust/Ruby repo + toolchain — none on
this box); Copilot/Antigravity quota endpoints (need those IDEs running); the gated e2es (creds + env
vars, runnable any time).

</details>

---

## Suggested ordering — rationale

The **loop is the meta-tool**; making it cheaper, convergent, and safe compounds on all downstream work
([[autonomous-pipeline-capstone-spec]]).

Per-item detail of record is the split backlog — index: [`backlog.md`](backlog.md). The roadmap above
links every section it draws from; [`durable-traps.md`](backlog/durable-traps.md) is standing
reference, not queued work, which is why it has no roadmap group.

**Verify a queued item's PREMISE against HEAD before opening a lap on it** — a spec's decomposition is a
lead, not a work order ([[grep-the-writers-before-believing-inheritance]]). Backlog prose decays: a
2026-07-19 classification pass found ~21% of entries were already shipped, stale, or describing code
that lives only on an unmerged branch.

⚠ **Deliberate, still current:** autonomous auto-confirm is scoped to the DELTA case only — a first-time
confirmation (no artifact at all) still pauses for the operator even under `autonomous_mode`.

Each lap: pick the next item, **risk-tier it**, ship, reinstall, **full friction walk**, then
regenerate the roadmap (`node scripts/shared/generate-handoff-roadmap.mjs`) — re-prioritise by moving
the entry inside its backlog file, never by re-wording the list.
