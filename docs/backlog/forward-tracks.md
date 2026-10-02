# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

- **Leads from the Open Code Review comparison (2026-10-01).** [`open-code-review-comparison-2026-10-01.md`](../reviews/open-code-review-comparison-2026-10-01.md) has three open leads: a diff-scoped `audit-code` draw, a PR-comment render of `audit-findings.json`, and per-path lens targeting. The lead that derives line numbers from the quote shipped. The owner rejected the reflection step (a host step that drops weak findings) on 2026-10-02: recall comes first, and an `ungrounded` mark already shows a weak finding without dropping it. **Property:** each open lead ships with its tests or is recorded as rejected with the reason.

- **Salvage the archived recovery-reconciliation work (2026-10-01).** A Codex worktree held 268 uncommitted changes written on `72437f1e`, before #12–#14. It is archived and verified in the main checkout under `.audit-tools/recovery/2026-10-01/` (its README states how to restore), and `stash@{0}` keeps a copy. Its remediate lifecycle layer and the paths that edit files #14 deleted are obsolete. Candidates with no counterpart on `main`: a performance profiler, `directedReachability`, `retiredArgs`, `collectFiles`, Prompt Contract v1 primitives, `reviewSnapshotStore`, `ignoredRootLogs`, `producerBoundary`, a source-test-ownership gate, and 8 audit tests. **Property:** each candidate is either ported against current `main` with its tests, or recorded as rejected with the reason — the source-test gate must answer the governance track below, which treats source-to-test declarations as navigation, not proof. Then the archive and the stash can go.
- **Governance consolidation retains explicit scope limits.** The executable gate catalog, backlog corpus, document pins, shared vocabulary, outcome evaluation and graph reachability are consolidated. Snapshot retention stays consumer-specific. A validation-receipt cache and a universal execution/mutation-certification gate are deliberately omitted without demonstrated value. Source-to-test declarations provide navigation, not behavioral proof. Remaining specific test-replica claims require independent evidence rather than another generic certification subsystem.



**Track 2.5 — keep production-orphan detection beside knip.** The dated
[`slimdown-review-2026-07-28.md`](../reviews/slimdown-review-2026-07-28.md) is a historical lead set,
not a current deletion list; the provider and dispatch subgraphs it identified have since been retired.
Its surviving structural finding is that neither knip mode reports a whole module that is exported
through a barrel and otherwise referenced only by its own tests. Periodically run a relative-import
graph check for production files whose only consumers are tests, then verify each candidate against
current HEAD before deleting it. [[orphan-modules-are-invisible-to-both-knip-modes]]

---



## Forward tracks


- **Deterministic analyzers: own-vs-acquire engine.** **Open:** clippy/rubocop landed fixture-only (no
  Rust/Ruby repo → live spawn unvalidated). *(Mutation testing was
  considered and dropped 2026-07-03: it doesn't fit the acquire+scan model — Stryker must run the full
  test suite per mutant and needs a per-repo test-runner config we don't own, so it either no-ops or is
  its own subsystem. Not an analyzer-registry add. Re-file as a scoped forward track only if a lightweight
  mutation signal appears.)* **Forward constraint:** any future proposal channel for analyzer ids
  beyond the static registry must route through the same `admitSpawn` chokepoint. (The
  consent-token-never-persisted half is pinned mechanically by
  `tests/shared/consent-token-not-persisted.test.ts`.) [[deterministic-analyzers-own-vs-acquire]]
  - **⬇ Live-run watch** (audit a **Rust** repo for clippy / a **Ruby** repo for rubocop, with the per-run
    consent token so the gate admits the non-default tool): the tool must actually **spawn and normalize**
    output into leads (cargo-clippy / bundle-rubocop), not skip. FAIL = "skipped" status when the ecosystem
    is present + consent given, or a parse that drops all output. (No Rust/Ruby toolchain on the box →
    install `rustup` / `ruby`+`bundler` first, or point at a repo that vendors them.)

- **CI wall-clock: shard balance and the single-file floor.** Pointer only — the brief, the measurements,
  the settled owner decisions and the rejected alternatives are ALL in
  `docs/reviews/ci-wallclock-plan-critique-2026-08-07.md`, which is deliberately the single home for this
  work. Nothing is restated here, so there is no second copy to drift. Implementation assigned outside
  this repo's agent loop by the owner 2026-08-07. [[vitest-shard-is-hash-based-and-file-atomic]]




- **Shared orchestration retains deliberate consumer policies.** Run-directory and prompt-binding mechanisms are shared. Remediation has no consumer graceful cap from which to derive another engine bound, and no measured defect justifies changing obligation granularity. Preserve these non-goals until new evidence warrants revisiting them.


- **The ship pipeline stops before the steps that finish it, and the remainder is agent prose (2026-08-27, from the philosophy audit).** `scripts/release-and-publish.mjs` ends at registry visibility; global reinstall, the allowed postinstall lifecycle scripts and both binary smokes live in `.claude/skills/ship/SKILL.md` as instructions an agent must remember and execute — the host-remembering shape the auditor-agnostic rule bans, applied to the project's own pipeline-ownership rule. There is also no single resumable record spanning the phases, so a stall part-way is recovered by hand. **Property:** one idempotent command owns gated ref verification, exactly-once tag/release/publish creation, delayed release observation, registry verification, reinstall with allowed lifecycle scripts, and smoke checks of both global binaries and the installed host assets — resuming only its observation and completion phases and never retrying a destructive creation. The observation half already has its own entry (the await-run timeout shorter than a release-event delivery delay); fix it inside this command rather than beside it. YAML critical-path profiling moves out of release correctness into best-effort reporting.
