import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * The eight conceptual-design finding categories the review prompt actually
 * emits. Canonical occurrence at HEAD is the `one of: …` enum string inside
 * `conceptualOutputFormat` (src/audit/orchestrator/designReviewPrompt.ts).
 */
const CANONICAL = [
  "fundamental_approach",
  "core_assumption",
  "structural_risk",
  "architecture_pattern",
  "design_simplification",
  "tool_opportunity",
  "integration",
  "missing_capability",
] as const;

function trackedTsSources(): string[] {
  return execSync('git ls-files "src/**/*.ts"', {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** A comment line that names 3+ canonical tokens is a hand copy of the set. */
function enumeratingCommentLines(
  file: string,
): { line: number; text: string; named: string[] }[] {
  const hits: { line: number; text: string; named: string[] }[] = [];
  const lines = readFileSync(resolve(REPO_ROOT, file), "utf8").split(/\r?\n/);
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    const isComment =
      trimmed.startsWith("*") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*");
    if (!isComment) return;
    const named = CANONICAL.filter((token) => text.includes(token));
    if (named.length >= 3) hits.push({ line: index + 1, text: trimmed, named });
  });
  return hits;
}

describe("conceptual finding categories are single-sourced", () => {
  it("no source comment re-enumerates the category set", () => {
    const offenders = trackedTsSources().flatMap((file) =>
      enumeratingCommentLines(file).map((hit) => ({ file, ...hit })),
    );
    const detail = offenders
      .map(
        (o) =>
          `${o.file}:${o.line} names ${o.named.length}/${CANONICAL.length} categories ` +
          `(missing: ${CANONICAL.filter((c) => !o.named.includes(c)).join(", ") || "none"})\n    ${o.text}`,
      )
      .join("\n  ");
    expect(
      offenders,
      offenders.length
        ? `A comment hand-copies the conceptual category set, so it drifts silently when the set changes.\n  ${detail}`
        : "",
    ).toEqual([]);
  });
});
