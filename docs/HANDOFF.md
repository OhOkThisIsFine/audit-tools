# HANDOFF — audit-tools

> Rolling cross-machine handoff: current state + the **ordered roadmap** of everything open. Durable
> how-to is in `CLAUDE.md`; full per-item detail in [`docs/backlog.md`](backlog.md); durable design in
> `spec/`. This handoff is the *sequencing* view — every open item appears once, in suggested order,
> with a pointer to its detail. Per-lap shipped detail is not narrated here (changelog creep — see git
> log); this doc is the **open-work roadmap** only.

## Live state

- On npm as `latest` (current version tracked in `package.json`, not pinned here). Last published:
  v0.30.55 (2026-07-01).
- **Uncommitted/unpublished as of this note:** this session's work — remediate A-8 hybrid quota wiring,
  audit-side quota-escalation parity (rate-limit evidence now threaded through `buildDispatchPool`, the
  `poolsOverride` A-8 branch, and `driveRollingAuditDispatch`), Windows spawn tree-kill
  (`spawnLoggedCommand.ts` `taskkill /T /F`) + PATHEXT-probe fallback for bare shim commands, and the
  knip dead-code candidate (slices 1+2 — consent-gated `knipCandidate`/`parseKnip`, joins via the existing
  generic `getExternalSignalPaths` seam, no new wiring needed). All suites green (audit 3376/0, remediate
  2103/0), `check`/`check:deadcode` clean.
- **Immediate next (two independent items):** (1) commit + ship the quota-parity/tree-kill/knip-slices-1+2
  work above (build/check/tests already verified green in-session); (2) a `remediate-code` run targeting
  knip slice 3 + the analyzer-registry proof tool (jscpd) + a consent-gate confirmation has its
  contract-authoring phase DONE and validated (6 adversarial repair rounds, all real defects — see
  `docs/backlog.md` → "Front-load broad prior-art search..." for the retrospective); no code written yet.
  Resume with a plain `/remediate-code` next session — state is fully on disk under
  `.audit-tools/remediation/`, next call dispatches the 3-node implementation DAG.
- Ethan runs live/rate-limited/deepening-capable runs routinely and reports back — this doc does not
  carry "needs live validation" reminders for code that's otherwise complete; treat anything below as
  code-complete unless it says otherwise.

## Cadence & standing rules (don't re-derive)

- **Risk-tier every lap** ([[risk-tier-loop-laps-cheap-vs-heavy]]): full adversarial contract pipeline only
  for risky/complex changes; trivial mechanical clusters run lean (one implementation agent → full-suite
  gate → ship). This is the *host workaround* until the self-scaling pipeline makes it the tool's own job.
- **Full friction walk every lap** ([[log-all-friction-categories-every-lap]]): log all three categories
  (ambiguous-direction / tool-should-decide / inefficient-feeding) to backlog + `open_observations`; don't
  trust the empty mechanical friction set.
- **Release:** `env -u CLAUDECODE npm run release:patch:publish`; recover a bad attempt with
  `gh release delete vX.Y.Z --cleanup-tag` + forward-bump. Run gate/test with `env -u CLAUDECODE`.
  Run `env -u CLAUDECODE npm run verify:release` locally before tagging (local pre-tag gate is only `check`).
- **Branch-strand trap (bit twice already):** a remediation run leaves you checked out on its
  worktree branch — commit/push docs from `main` (verify `git rev-parse --abbrev-ref HEAD`) or the commit
  strands off main.

---

## Suggested ordering — everything open, sequenced

Rationale: the **loop is the meta-tool**; making it cheaper, convergent, and safe has compounding leverage
on all downstream work, and is the "redesign before scheduled autonomy" the north star requires
([[autonomous-pipeline-capstone-spec]]). Loop-infra (T1–T3) is now COMPLETE end-to-end — nothing open on
those tracks. Remaining sequencing: cheap ergonomics (T4) → product/analysis tracks (T5) → deferred (T6).

### T4 — Remaining host-friction inventory
- Nothing open. All A/B/C/D items shipped (contract-pipeline host-friction inventory, phase-cut, boundary
  gates, merge-to-base). Selective-deepening convergence (both known loops) has a shipped code fix.

### T5 — Product / analysis forward tracks
1. **Dead-code analyzer (knip) — slice 3, graph cross-check.** Slices 1+2 shipped. Open: `graph_bundle.json`
   doesn't exist yet at knip's dispatch time (obligation ordering), so a cross-check against in/out-degree +
   entrypoint provenance can't happen inline. Two candidate designs recorded in
   [`docs/backlog.md`](backlog.md) — neither built yet.
2. **Deterministic analyzers — own-vs-acquire acquisition engine.** Only git-history mining and gitleaks
   secret scanning are fully acquired. The generic acquire-any-ecosystem-tool engine (capability-probe →
   run ephemerally → normalize via the existing adapter seam → degrade-to-empty) is not built; each
   additional analyzer today would still be one-off wiring, not a registry entry. See
   [`docs/backlog.md`](backlog.md) for the 3-part plan. *([[deterministic-analyzers-own-vs-acquire]])*
3. **Schema-enforced generation — CE-004 residual + broader semantic checks.** Emit-time constraint seam
   and the `total_lines` semantic gate (CE-009) are shipped. Open: the always-on conversation host
   advertises no API-level constraint mechanism (blocked on the provider, not our code), plus broader
   semantic-validity checks beyond `total_lines` are unbuilt candidates.
4. **Codebase-wide churn/context/enforce pass — remainder (C3/C5/C6/E4/E5).** Low-value or needs design
   intent first; not scheduled. Re-run the lens broadly if worthwhile later.

### T6 — Deferred / waiting (user-owned or low priority)
- A2 finding-quality oracle (needs a hand-labeled corpus); A7 release-time manual GUI checklist
  (Antigravity/OpenCode); provider `queryLimits` (revisit if a provider gains a proactive endpoint);
  headroom proxy final opt-in flip (Ethan's own decision, proxy already verified healthy); narrow staleness
  on prose-heavy artifacts (bounded semantic judgment, defer until churn is measured).
  *(full detail in `docs/backlog.md` → "Deferred / waiting")*

---

Each lap: pick the next item, **risk-tier it** (friction/ergonomic items → lean; anything touching the loop
core → full pipeline), ship, reinstall, **full friction walk**, update this ordering.
