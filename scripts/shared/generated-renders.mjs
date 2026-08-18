/**
 * Generated deliverable RENDERS — projections of machine contracts whose prose is
 * worker-authored audit content. Excluded from the all-tracked-markdown doc gates
 * (doc-links, memory-citations): a finding may legitimately QUOTE citation- or
 * link-shaped text (a finding about the link rewriter quotes `[t](../a(1).md)`;
 * a finding about the citation gate quotes its fixture's `(memory: live-note)`),
 * and those gates' promises cover documents a person authored, where a dangling
 * pointer re-asserts a deleted target's claim. Single-sourced here so every
 * all-tracked-md scanner excludes the same set.
 */
export const GENERATED_DELIVERABLE_RENDERS = new Set([
  ".audit-tools/audit-report.md",
  ".audit-tools/remediation-report.md",
]);

/** Filter for `git ls-files` output paths (normalizes separators). */
export const isGeneratedRender = (file) =>
  GENERATED_DELIVERABLE_RENDERS.has(file.replace(/\\/g, "/"));
