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
  "check:guard-reach",
  // The generator census is also unconditional: any tracked add/delete/rename
  // can change whether a generator has a declared freshness authority.
  "check:generated-artifacts",
  // Production source is one side of the glossary reconciliation.
  "check:invariant-glossary",
] as const;
