// sites-pinned: tests/audit/orchestrator-remediation.test.ts, tests/audit/question-planning.test.ts
import type { ReviewQuestion, ReviewSourceRef } from "../../shared/types/reviewQuestion.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";

const RULE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const RULE_EVIDENCE_PREFIX = "project-rule:";

export function isProjectRulePath(path: string): boolean {
  return RULE_NAMES.some(name => path === name || path.endsWith("/" + name));
}

/** Admit only contract documents for the ancestor directories of this subject. */
export function applicableProjectRulePaths(
  refs: readonly ReviewSourceRef[],
  allowed: (path: string) => boolean,
): string[] {
  const files = new Set<string>();
  for (const { path } of refs) {
    const segments = path.split("/").slice(0, -1);
    for (let i = 0; i <= segments.length; i++) {
      const directory = segments.slice(0, i).join("/");
      for (const name of RULE_NAMES) {
        const candidate = directory ? directory + "/" + name : name;
        if (allowed(candidate)) files.add(candidate);
      }
    }
  }
  return [...files].sort(compareCodeUnits);
}

// A shortlist only, not an interpreter for Markdown or repo instructions.
const ruleTopics: Record<string, RegExp> = {
  architecture: /\b(?:architecture|boundary|layers?|dependencies|coupling|ownership|shared|module)\b/i,
  behavior: /\b(?:invariant|behavior|retry|state|input|validation|data integrity|error)\b/i,
  config_deployment: /\b(?:configuration|release|publish|deploy|environment|build|workflow)\b/i,
  operability: /\b(?:operator|observability|logs?|diagnostics|recovery|resume|handoff)\b/i,
  performance: /\b(?:latency|cache|bandwidth|allocation|performance|throughput|resource|budget)\b/i,
  security: /\b(?:security|trust|authoriz\w*|secrets?|sensitive|permissions?|credentials?)\b/i,
  tests: /\b(?:tests?|coverage|fixture|assertion|harness|flakiness|sharding)\b/i,
};

export function projectRuleExcerpts(lines: readonly string[]) {
  let fenced: string | undefined;
  let heading = "";
  const candidates: { lens: string; ref: Omit<ReviewSourceRef, "path">; excerpt: string; exception: boolean }[] = [];
  for (const [index, line] of lines.entries()) {
    const fence = /^\s{0,3}([~`]{3,})/.exec(line)?.[1];
    if (fence && [...fence].every(token => token === fence[0])) {
      if (!fenced) fenced = fence;
      else if (fenced[0] === fence[0] && fence.length >= fenced.length) fenced = undefined;
      continue;
    }
    if (fenced) continue;
    const title = /^#{1,6}\s+(.+)/.exec(line)?.[1];
    if (title) { heading = title; continue; }
    const text = /^\s*(?:[-*+]\s+|\d+\.\s+)?(.+)$/.exec(line)?.[1]?.trim();
    if (!text || text.length > 420 || !/\b(?:must|should|never|only|always|require\w*|except|unless|prefer|do not)\b/i.test(text)) continue;
    const exception = /\b(?:except|unless|does not apply|not required)\b/i.test(text);
    for (const [lens, pattern] of Object.entries(ruleTopics)) {
      if (pattern.test(heading + " " + text)) {
        candidates.push({ lens, ref: { start_line: index + 1 }, excerpt: text, exception });
      }
    }
  }
  // Give each lens its own small shortlist. Include an exception when found.
  return Object.keys(ruleTopics).flatMap(lens => candidates.filter(candidate => candidate.lens === lens)
    .sort((a, b) => Number(b.exception) - Number(a.exception) || a.ref.start_line! - b.ref.start_line!)
    .slice(0, 2));
}

export function projectRuleEvidenceKey(lens: string, digest: string): string {
  return RULE_EVIDENCE_PREFIX + lens + ":" + digest;
}

export function projectRuleMatchesLens(evidenceId: string, lens: ReviewQuestion["lens"]): boolean {
  return !evidenceId.startsWith(RULE_EVIDENCE_PREFIX) || evidenceId.startsWith(RULE_EVIDENCE_PREFIX + lens + ":");
}


/** Scope a candidate by its own directory, not by the question's whole file set.
 * Prefer the nearest applicable guidance for the same subject only if the
 * narrower text actually resolves it; do not infer precedence between peers.
 */
export function projectRuleScopeNote(path: string): string {
  const slash = path.lastIndexOf("/");
  const subtree = slash < 0 ? "repository root (all in-scope paths)"
    : path.slice(0, slash) + "/ (that subtree only)";
  return "Applies to " + subtree + ". Consider nearest applicable guidance for each affected path; " +
    "if applicable texts disagree without clearly stated precedence, report the conflict rather than assume an override.";
}
