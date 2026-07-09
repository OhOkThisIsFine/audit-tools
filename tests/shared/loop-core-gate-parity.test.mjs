import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { LOOP_CORE_PATTERNS } = await import("../../src/shared/index.ts");

const HERE = dirname(fileURLToPath(import.meta.url));

// Extract the inline `const LOOP_CORE_PATTERNS = [ ... ];` array literal from a
// hook's text, tolerating trailing commas + single/double quotes + comments.
async function extractHookPatterns(hookRelPath) {
  const src = await readFile(join(HERE, "..", "..", hookRelPath), "utf8");
  const match = src.match(/const LOOP_CORE_PATTERNS = \[([\s\S]*?)\];/);
  expect(match, `${hookRelPath} must declare a literal LOOP_CORE_PATTERNS array`).toBeTruthy();
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim()) // strip line comments
    .filter(Boolean)
    .join("")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// ── anti-drift guard: the .mjs hooks can't import the TS source, so they
// re-declare LOOP_CORE_PATTERNS. Pin each inline copy byte-equal (order +
// contents) to the single source of truth so they can never diverge. ──────────

test("pre-commit-gate.mjs LOOP_CORE_PATTERNS stays in parity with the source of truth", async () => {
  const hookPatterns = await extractHookPatterns(".claude/hooks/pre-commit-gate.mjs");
  expect(hookPatterns, "hook list must equal the single-sourced LOOP_CORE_PATTERNS").toEqual([
    ...LOOP_CORE_PATTERNS,
  ]);
});

test("attest-loop-core-review.mjs LOOP_CORE_PATTERNS stays in parity with the source of truth", async () => {
  const hookPatterns = await extractHookPatterns(".claude/hooks/attest-loop-core-review.mjs");
  expect(hookPatterns, "producer list must equal the single-sourced LOOP_CORE_PATTERNS").toEqual([
    ...LOOP_CORE_PATTERNS,
  ]);
});
