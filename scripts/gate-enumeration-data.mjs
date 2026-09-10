// Where the GENERATED gate enumeration lives, and how each consumer wants it
// shaped.
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
// So the list is GENERATED from package.json's real step order — membership,
// order and rendering all derived, nothing hand-maintained.
// `scripts/check-gate-enumeration.mjs` renders every registered target between
// markers and byte-compares (`--write` regenerates).
//
// WHAT USED TO BE HERE, AND WHY IT IS GONE. This module also held a per-step
// human description map, and the gate FAILED THE BUILD when a step had no entry
// (ceremony review 2026-08-29; backlog 2026-08-27). The one registered target
// renders step NAMES alone, so no description ever reached a reader: it was
// write-only data that every new gate step had to pay for, and it was itself
// one of the five separate homes registering a single gate required. The
// property the backlog entry states is "a human description is held only where
// a named consumer renders it" — and there is no consumer that needs one, so
// the description is not held. The enumeration now derives from the executable
// step list alone. A failing gate's own `fix` string (on its GUARDS row) is the
// rendered per-gate text, printed by the pre-commit leg at the moment it is
// actionable.

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
