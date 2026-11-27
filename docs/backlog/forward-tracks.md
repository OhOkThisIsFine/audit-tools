# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

**Track 2.5 — keep production-orphan detection beside knip.** The dated
[`slimdown-review-2026-07-28.md`](../reviews/slimdown-review-2026-07-28.md) is a historical lead set,
not a current deletion list; the provider and dispatch subgraphs it identified have since been retired.
Its surviving structural finding is that neither knip mode reports a whole module that is exported
through a barrel and otherwise referenced only by its own tests. Run the existing `npm run check:orphan-modules` production-reachability check alongside Knip,
then verify each candidate against current HEAD before deleting it. [[orphan-modules-are-invisible-to-both-knip-modes]]

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

- **Structured MCP submission beyond work-item results (owner, 2026-11-06).** Work-item
  `submit_result` covers both draws. Audit `submit_gate` supports `synthesis_narrative`,
  `critical_flow_fallback`, `intent_equivalence` (the current pending pair), and `edge_reasoning`,
  which accepts the object/array file forms; the other delivered lanes retain their own object
  schemas. Audit charter clarification also accepts partial or empty operator answers,
  reusing the file schema and asked-request check without applying answers. Bound design-contract
  reviews retain the independent-review declaration, live input checks and finding validation.
  **Remaining:** charter reviews, conceptual design-review and systemic-challenge lanes;
  operator answers (`analyzer_decisions` persists
  repository analyzer settings, while `analyzer_consent` records current-run consent).
  Remediate `submit_gate` supports operator triage decisions, mid-run clarification answers,
  and item-bound conformance reviews through their existing file validators. Negative review
  feedback is admitted without authorizing success; existing consumers retain freshness and
  independence checks. Clarification
  answers retain the strict bare-array shape and current paused-unit set. The remaining routes
  are not implemented. **Property:** each route uses the SAME validator as its file route and
  writes the bound path; none returns a step or prompt or advances the workflow. **Open:** whether
  sub-agents inherit the parent's MCP tools remains unverified across hosts, so file routes stay
  first-class.
