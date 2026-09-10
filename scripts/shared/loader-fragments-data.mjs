// Canonical loader-instruction fragments, declared as DATA so the shipped
// loader assets can be reconciled against them mechanically.
//
// WHY THIS EXISTS (minor-bugs: "The remediate loader pair restates what the
// audit pair now single-sources", 2026-08-23). The four shipped loader assets
// (`skills/<tool>/<tool>.prompt.md` and `skills/<tool>/SKILL.md`, both pairs)
// had drifted into FOUR near-copies of the same instruction: the "Read the
// returned JSON only far enough…" paragraph appeared in all four with wording
// differences ("the current prompt" vs "the prompt"), and the
// `--input` / `--guidance-file` argument rule was stated twice inside the
// remediate pair alone. All of them ship (`skills/**`), so an npm reader sees
// every copy as authoritative.
//
// PROPERTY TO HOLD, on TWO axes — they are different questions and a fragment
// answers whichever one applies to it:
//
//   1. WITHIN a loader pair (a tool's prompt body + its SKILL.md): each
//      instruction has ONE full statement and the other asset POINTS at it.
//      A second full statement inside one tool is the drift this catches.
//   2. ACROSS the two tools: a rule that both tools genuinely share is ONE
//      fragment rendered into BOTH loader bodies — not a copy in one and a
//      cross-reference in the other, which is what the target-directory rule
//      had become (`--root` resolves identically for both bins, so both bodies
//      must state it, in the same words).
//
// So a fragment declares the assets that carry its text `verbatimIn` (one, for
// axis 1; several, for axis 2) and, optionally, `pointers` — assets that must
// NAME the asset holding the statement and must NOT restate it.
//
// A property of the tree, so it is enforced by a contract check
// (`scripts/check-loader-fragments.mjs`, wired into verify:checks) rather than
// by an instruction to remember. This module is the single place the fragment
// TEXT is authored; the assets embed it and the check reconciles them.

/**
 * The phrase every pointer must carry: it names the home asset and says the
 * statement lives there. Deliberately a PHRASE, not a whole sentence — the
 * pointer must read naturally in the surrounding prose ("This rule…" /
 * "The target-directory rule…"), and pinning a fixed lead-in forced phrasing
 * that read as nonsense beside a pointer's own home.
 */
export function pointerPhrase(home) {
  return `one full statement in \`${home}\``;
}

const AUDIT_PROMPT = "skills/audit-code/audit-code.prompt.md";
const AUDIT_SKILL = "skills/audit-code/SKILL.md";
const REMEDIATE_PROMPT = "skills/remediate-code/remediate-code.prompt.md";
const REMEDIATE_SKILL = "skills/remediate-code/SKILL.md";

export const LOADER_FRAGMENTS = [
  {
    id: "read-prompt-path",
    // Axis 2: universal. The same contract in every loader asset, so it is
    // stated in full in all four — drifted wording here is a silent divergence
    // in what a host is permitted to read.
    verbatimIn: [AUDIT_PROMPT, AUDIT_SKILL, REMEDIATE_PROMPT, REMEDIATE_SKILL],
    text:
      "Read the returned JSON only far enough to find `prompt_path`, then read and " +
      "follow only that prompt. Do not inspect workload, result, schema, or state files " +
      "unless the current prompt directs you to them.",
  },
  {
    id: "target-directory",
    // Axis 2: BOTH bins resolve `--root` identically, so both loader bodies
    // state the rule, in the same words. Each tool's SKILL points at its own
    // body rather than restating it (axis 1).
    verbatimIn: [AUDIT_PROMPT, REMEDIATE_PROMPT],
    pointers: [
      { path: AUDIT_SKILL, home: AUDIT_PROMPT },
      { path: REMEDIATE_SKILL, home: REMEDIATE_PROMPT },
    ],
    // Tool-neutral by design: it renders into both bodies verbatim, so naming
    // one bin would be wrong in the other.
    text:
      "run from inside the target repository; every command resolves that repository's " +
      "root from the working directory on its own, so normal usage passes no `--root`. " +
      "Pass the user-supplied target directory with `--root <path>` only when running " +
      "from outside that repository.",
  },
  {
    id: "input-and-guidance",
    // Axis 1: remediate-only. The prompt body is the one full statement; the
    // SKILL points at it. (The audit pair has no equivalent rule.)
    verbatimIn: [REMEDIATE_PROMPT],
    pointers: [{ path: REMEDIATE_SKILL, home: REMEDIATE_PROMPT }],
    text:
      "pass an existing path with `--input <path>`; write conversational feedback to a " +
      "temporary file and pass it with `--guidance-file <path>`.",
  },
];

/** Repo-relative paths of every asset any fragment is reconciled against. */
export function loaderFragmentAssets(fragments = LOADER_FRAGMENTS) {
  const paths = new Set();
  for (const fragment of fragments) {
    for (const path of fragment.verbatimIn ?? []) paths.add(path);
    for (const pointer of fragment.pointers ?? []) paths.add(pointer.path);
  }
  return [...paths].sort();
}

/**
 * Collapse whitespace so a markdown paragraph compares equal however it is
 * wrapped across lines. Line breaks in these assets are presentation only.
 *
 * @param {string} text
 */
export function normalizeFragmentText(text) {
  return text.replace(/\s+/g, " ").trim();
}
