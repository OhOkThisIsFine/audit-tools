// Single source of truth for the "constitutional" doc set — the normative
// documents that define what this project IS, rather than describing what its
// code currently DOES.
//
// WHY THIS EXISTS. `docs/doc-review-guidelines.md` already SAYS these must never
// be silently rewritten to match code ("goals docs are normative — never
// silently rewritten to match code", "Policy & conventions untouchable",
// "**No — escalate-only**"). A label is not a refusal: commit 6fc2e453 rewrote
// `spec/remediate/remediation-goals.md` anyway, inside a 9-file doc-review sweep,
// and nothing stopped it. Per `CLAUDE.md`'s auditor-agnostic-robustness rule —
// whatever CAN be enforced in tooling must be — the label is now backed by a
// mechanical refusal: `.claude/hooks/pre-commit-gate.mjs` blocks a commit whose
// staged set touches one of these paths unless an explicit, staged-tree-bound
// override record exists (`scripts/attest-constitutional-doc-change.mjs`).
//
// This mirrors `loopCorePaths.ts` deliberately: one canonical list here, a
// generated `.mjs` sibling the pre-build hooks can import
// (`scripts/shared/constitutional-doc-paths.generated.mjs`), and a `--check`
// parity gate (`npm run check:constitutional-doc-paths`) so the two can never
// drift. Edit HERE; the generator and the parity check follow.
//
// HOW THE LIST IS DERIVED — never guessed. Every entry is a path the doc
// manifest itself marks normative or escalate-only:
//   • `CLAUDE.md`, `AGENTS.md` — the manifest's *instruction / policy* row:
//     "Policy & conventions untouchable", "**No — escalate-only.**"
//   • `docs/project-philosophy.md`, `docs/documentation-philosophy.md` — the two
//     rubric sources every judgement in the doc-review routine measures against.
//   • `docs/doc-review-guidelines.md` — "This file is **excluded from its own
//     review**… the routine reads it, never rewrites it."
//   • `spec/audit/audit-goals.md`, `spec/remediate/remediation-goals.md` — named
//     *normative goals docs* ("never silently rewritten to match code").
//   • the rest of `spec/audit/*` — the manifest's *package docs (audit)* row
//     calls them "the normative `spec/audit/*`".
//     EXCEPT `spec/audit/*.generated.md`: a whole-file generator render (e.g.
//     `scripts/shared/generate-executor-producers.mjs`) is a projection of code,
//     never a normative statement. It is edited by re-running its generator, so
//     the refusal buys nothing and would demand an owner override on every edit
//     to the registry it renders. Protect that registry, not its render — and
//     the generator REFUSES a `*.generated.md` entry, so this is not a rule
//     someone has to remember.
// The list is deliberately NOT padded out to cover `spec/` wholesale: an
// over-broad refusal trains the override into a reflex, and an override that is
// always used has stopped signalling anything.
//
// Entries are EXACT repo-relative paths (no directory prefixes — over-capture is
// the specific failure mode here). Paths compare with forward slashes (win32
// backslashes are normalized first), so the set is OS-agnostic.

/**
 * The canonical constitutional doc path list. Exact repo-relative paths, sorted
 * by content (path-sort) so the serialized order is stable and the parity
 * comparison is deterministic.
 */
export const CONSTITUTIONAL_DOC_PATHS: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/doc-review-guidelines.md",
  "docs/documentation-philosophy.md",
  "docs/project-philosophy.md",
  "spec/audit/artifact-contract.md",
  "spec/audit/audit-goals.md",
  "spec/audit/dependency-map.md",
  "spec/audit/entrypoint-contract.md",
  "spec/audit/executor-catalog.md",
  "spec/audit/orchestration-policy.md",
  "spec/remediate/remediation-goals.md",
];

/** Normalize a repo-relative path to forward slashes, no leading "./". */
function normalizeRepoRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Whether a repo-relative path names a constitutional doc. Exact match only —
 * a doc is constitutional because it was deliberately listed, never because it
 * happens to sit under a protected directory.
 */
export function isConstitutionalDocPath(path: string): boolean {
  return CONSTITUTIONAL_DOC_PATHS.includes(normalizeRepoRelPath(path));
}
