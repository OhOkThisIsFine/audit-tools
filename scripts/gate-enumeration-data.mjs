// The human-readable gloss for every step of the release gate, HELD AS DATA.
//
// WHY THIS EXISTS. `package.json`'s `verify:checks` / `verify:release` are the
// real gate. The ship skill (`.claude/skills/ship/SKILL.md`) restates that list
// in prose as an inline sentence — and a prose restatement maintained BY HAND
// goes silently stale on every new gate step, with nothing failing until a
// human diffs it.
//
// That is not hypothetical: on 2026-07-29 the nightly review added a missing
// `check:doc-links` row to the glossed-bullet copy then in release.md (since
// folded into the ship skill, the flow's one home) and missing `doc-links` +
// `nightly-routine-prompt` rows to the ship skill, recording that the latter
// "now matches package.json in exact order". It stopped matching the next day,
// when `check:guard-reach` landed in a commit that had no reason to know any
// prose restatement existed.
//
// So the list is GENERATED from package.json's real step order, and this module
// supplies only the one thing package.json cannot: what each step means to a
// human. `scripts/check-gate-enumeration.mjs` renders every registered target
// between markers and byte-compares (`--write` regenerates). A step present in
// package.json with no gloss here is a BUILD FAILURE — adding a gate step forces
// you to name it once, in one place, and every rendered copy follows.
//
// This is the same shape as `scripts/doc-manifest-data.mjs` and the README
// philosophy block: one source, rendered per consumer, parity-gated. CLAUDE.md's
// rule is "One brief, two consumers — never a second copy".

/** @type {Record<string, string>} */
export const STEP_GLOSS = {
  // verify:checks steps, glossed. Order is NOT declared here — it is read from
  // package.json, so this map can never disagree with the gate about sequence.
  "check:control-bytes": "raw control-byte gate",
  "check:version-gates": "version-gate scan",
  "check:guard-reach": "guard wiring/reach reconciliation",
  "check:ci-trigger-paths": "CI trigger-path parity (derived from guard-reach)",
  "check:offload-lanes": "offload-lane registry reconciliation",
  "check:loop-core-patterns": "loop-core pattern-list drift check",
  "check:constitutional-doc-paths": "constitutional-doc-path parity",
  "check:runtime-artifact-names": "runtime artifact-name set parity",
  "check:executor-producers": "executor→artifact producer-table parity",
  "check:cli-surface": "installer-verb surface parity in the shipped product page",
  "check:deadcode": "dead-code export gate",
  "check:lint": "curated lint gate (eslint, zero-tolerance)",
  "check:dup": "duplication ratchet (jscpd)",
  "check:depgraph": "dependency-graph rules (dependency-cruiser)",
  "check:doc-manifest": "doc-manifest reconciliation gate",
  "check:doc-links": "relative-link resolution gate",
  "check:doc-code-citations": "backticked repo-path citation gate",
  "check:gate-enumeration": "gate-enumeration parity (this list)",
  "check:philosophy-brief": "README philosophy-brief parity",
  "check:readme-sample-report": "README sample-report render parity",
  "check:nightly-routine-prompt": "nightly scheduler-prompt parity",
  "check:handoff-roadmap": "HANDOFF roadmap parity",
  "check:backlog-index": "backlog seek-index parity",
  "check:memory-citations": "memory-citation check",
  "check:backlog-budget": "backlog size-budget gate",
  "check:backlog-status": "backlog status-token gate",
  "check:backlog-line-numbers": "backlog line-number-citation gate",
  "check:tests": "test-tree typecheck",
  build: "TypeScript typecheck",
  "verify:hosts": "host-install verification (audit)",
  "verify:remediate-hosts": "host-install verification (remediate)",
  "pack:smoke": "single-tarball pack smoke",
  "smoke:packaged-audit-code": "packaged-install smoke (audit-code)",
  "smoke:packaged-remediate-code": "packaged-install smoke (remediate-code)",

  // verify:release adds these on top of verify:checks.
  "scripts/shared/run-vitest-gate.mjs": "full automated test suite (vitest)",
  "smoke:linked-audit-code": "linked-install smoke (audit-code)",
  "smoke:linked-remediate-code": "linked-install smoke (remediate-code)",
};

/** Where a generated enumeration lives, and how that consumer wants it shaped. */
export const ENUMERATION_TARGETS = [
  {
    file: ".claude/skills/ship/SKILL.md",
    marker: "gate-enumeration",
    // A compact inline sentence: this doc is read while shipping, not studied.
    render: (steps) =>
      `\`verify:checks\` = ${steps.map((s) => `\`${s}\``).join(" + ")}`,
  },
];
