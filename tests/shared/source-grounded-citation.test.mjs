/**
 * source-grounded-citation.test.mjs — B3 shared path-grounding primitives.
 *
 * Pins the shared layer of the source-grounded-citation module (INV-B3-1/2/6):
 *   - normalizeRepoPath must strip a leading `./` ONLY, never a dotfile-dir dot.
 *   - resolveBasenameToTrackedPath grounds a UNIQUE bare basename, never an
 *     ambiguous (>1-match) one, and never a basename matching nothing.
 *   - groundDesignFinding (and thus the M-B3 gate, which delegates to it)
 *     inherits both: dotfile-dir exact membership + unique-basename resolution,
 *     while a hallucinated path stays ungrounded (monotonic widening).
 */
import { test, expect } from "vitest";
import {
  normalizeRepoPath,
  isBareBasename,
  resolveBasenameToTrackedPath,
  groundDesignFinding,
} from "audit-tools/shared";

function finding(paths) {
  return {
    id: "F-1",
    title: "t",
    category: "c",
    severity: "medium",
    confidence: "high",
    lens: "security",
    summary: "s",
    affected_files: paths.map((path) => ({ path })),
    evidence: ["e"],
  };
}

// ── INV-B3-1: no dotfile-dir strip in shared normalizer ───────────────────────

test("INV-B3-1 POSITIVE: normalizeRepoPath preserves a dotfile-dir leading dot", () => {
  // Only a leading './' is stripped; the dot of `.claude` / `.github` survives so
  // the path stays identical to its `git ls-files` form for exact membership.
  expect(normalizeRepoPath(".claude/hooks/friction-stop-gate.mjs")).toBe(
    ".claude/hooks/friction-stop-gate.mjs",
  );
  expect(normalizeRepoPath("./.claude/x.mjs")).toBe(".claude/x.mjs");
});

test("INV-B3-1 NEGATIVE: normalizeRepoPath does NOT strip the leading dot of a dotfile dir", () => {
  // A regression that stripped the dot would yield 'github/workflows/ci.yml' and
  // silently un-ground every dotfile citation.
  expect(normalizeRepoPath(".github/workflows/ci.yml")).toBe(
    ".github/workflows/ci.yml",
  );
  expect(normalizeRepoPath(".github/workflows/ci.yml")).not.toBe(
    "github/workflows/ci.yml",
  );
});

test("INV-B3-1 POSITIVE: a finding citing a dotfile path grounds by exact membership", () => {
  const corpus = new Set([".claude/hooks/friction-stop-gate.mjs"]);
  const verdict = groundDesignFinding(
    finding([".claude/hooks/friction-stop-gate.mjs"]),
    corpus,
  );
  expect(verdict.status).not.toBe("ungrounded");
  expect(verdict.status).toBe("grounded");
});

// ── INV-B3-2: bare basename resolves to a UNIQUE tracked full path ────────────

test("isBareBasename distinguishes a bare name from nested / dotfile paths", () => {
  expect(isBareBasename("advance.ts")).toBe(true);
  expect(isBareBasename("src/audit/orchestrator/advance.ts")).toBe(false);
  expect(isBareBasename(".claude/hooks/x.mjs")).toBe(false);
  expect(isBareBasename("a\\b.ts")).toBe(false);
  expect(isBareBasename("")).toBe(false);
});

test("INV-B3-2 POSITIVE: a unique bare basename resolves to its tracked full path", () => {
  const corpus = new Set(["src/audit/orchestrator/advance.ts", "src/other/x.ts"]);
  expect(resolveBasenameToTrackedPath("advance.ts", corpus)).toBe(
    "src/audit/orchestrator/advance.ts",
  );
  // …and grounds through groundDesignFinding (shared authority the gate uses).
  const verdict = groundDesignFinding(finding(["advance.ts"]), corpus);
  expect(verdict.status).toBe("grounded");
});

test("INV-B3-2 NEGATIVE: an ambiguous bare basename does NOT silently ground", () => {
  const corpus = new Set([
    "src/audit/orchestrator/advance.ts",
    "src/remediate/steps/advance.ts",
  ]);
  expect(resolveBasenameToTrackedPath("advance.ts", corpus)).toBeUndefined();
  const verdict = groundDesignFinding(finding(["advance.ts"]), corpus);
  expect(verdict.status).toBe("ungrounded");
});

// ── INV-B3-6: hallucination signal preserved (monotonic widening) ─────────────

test("INV-B3-6 NEGATIVE: a hallucinated basename / path stays ungrounded", () => {
  const corpus = new Set(["src/audit/orchestrator/advance.ts"]);
  expect(resolveBasenameToTrackedPath("doesnotexist.ts", corpus)).toBeUndefined();
  expect(groundDesignFinding(finding(["doesnotexist.ts"]), corpus).status).toBe(
    "ungrounded",
  );
  expect(groundDesignFinding(finding(["made/up/dir/x.ts"]), corpus).status).toBe(
    "ungrounded",
  );
});
