# Forward tracks

> Design-level directions and in-flight tracks — not yet bounded defects.
>
> Part of the split backlog — index: [`docs/backlog.md`](../backlog.md).
> A living to-do list, not a status log. Remove an entry once it ships; record durable
> contracts and rationale in project memory or `CLAUDE.md`, never "where the code is today".

## Open tracks

- **Governance consolidation retains explicit scope limits.** The executable gate catalog, backlog corpus, document pins, shared vocabulary, outcome evaluation and graph reachability are consolidated. Snapshot retention stays consumer-specific. A validation-receipt cache and a universal execution/mutation-certification gate are deliberately omitted without demonstrated value. Source-to-test declarations provide navigation, not behavioral proof. Remaining specific test-replica claims require independent evidence rather than another generic certification subsystem.


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

- **Shared orchestration retains deliberate consumer policies.** Run-directory and prompt-binding mechanisms are shared. Remediation has no consumer graceful cap from which to derive another engine bound, and no measured defect justifies changing obligation granularity. Preserve these non-goals until new evidence warrants revisiting them.
