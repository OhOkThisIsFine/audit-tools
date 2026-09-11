// The EXPECTED src-reach pre-commit leg set — the hand-written literal the
// pinning suites assert the derivation against. ONE copy, imported by both
// consumers (precommit-leg-derivation + attest-derived-file-preflight): the
// duplicate literal was updated in one file and discovered shard-by-shard in
// CI when the second copy went red (backlog 2026-08-29). Deliberately
// hand-written, never derived from the guard registry: the pin exists to catch
// the derivation changing, so deriving it here would make both assertions
// tautologies.
export const EXPECTED_SRC_REACH_LEG_IDS = [
  "check:tests",
  // Unconditional, like check:guard-reach below: a control byte can enter any
  // tracked file, so no narrower trigger is honest. It became a leg on
  // 2026-09-05 after a delegated lane wrote raw 0x1A bytes into a doc — the
  // write-time hook only sees writes made through this agent's own tools, so
  // every local gate passed and release CI caught it on main.
  "check:control-bytes",
  "check:shared-primitives",
  "check:orphan-modules",
  // P27: the per-site pinning gate's scan set includes `src/**/*.ts`, so a
  // src-only staged set is exactly what it exists to judge. It rides the
  // `reach` phase like the others: it refuses on the staged diff, which is
  // the object the commit is about to create.
  //
  // ORDER IS THE REGISTRY'S, NOT A CHOICE MADE HERE. `buildPreCommitLegs`
  // emits legs in `GUARDS` row order (registry order within each phase), and
  // P27 files `check:sites-pinned` and `check:contract-sites` in the
  // `scripts/`-governance stretch of that array — after `check:orphan-modules`
  // and BEFORE the two unconditional gates `check:guard-reach` /
  // `check:generated-artifacts`. The list below is therefore the derived
  // order verbatim; it is a pin on the derivation, never a second authority
  // that could outvote it. Move a gate row and this literal moves with it.
  "check:sites-pinned",
  // P27 fix round 3: the pre-build twin's freshness gate. Its `files` reach is
  // the union of the REACH rows citing it, and both of the twin's SOURCES are
  // src-reachable — `src/audit/contracts/workerSchemas.ts` (whose
  // CONTRACT_SCHEMA_PRODUCERS names the schema files the twin projects) is
  // claimed by the contract-sites row, and `PINNED_PATHS`' own scan set
  // includes `src/**/*.ts`. A src-only staged set can therefore stale the twin
  // (`CONTRACT_SCHEMA_PRODUCERS` is edited in that very file), so this leg is
  // part of the derived src-reach set — sitting, in registry order, after
  // `check:sites-pinned` and BEFORE the two unconditional gates below.
  "check:guard-reach-paths",
  // The generator census is also unconditional: any tracked add/delete/rename
  // can change whether a generator has a declared freshness authority.
  "check:guard-reach",
  "check:generated-artifacts",
  // Production source is one side of the glossary reconciliation.
  "check:invariant-glossary",
] as const;
