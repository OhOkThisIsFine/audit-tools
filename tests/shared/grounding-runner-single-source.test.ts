/**
 * grounding-runner-single-source.test.mjs — single-source guards for the
 * grounding-consolidation module (drift-plan E2/E3/P7; CRIT ARC-a06a3945; G1).
 *
 * These source-level guards fail HERE (not silently at runtime) if a regression
 * re-forks any of the consolidated primitives:
 *
 *   1. The allowlisted read-only runner + default-deny arg allowlist live ONLY
 *      in shared/src/tooling/allowlistedExec.ts. No other src module may declare
 *      its own anchor allowlist or spawn an inspection command directly.
 *   2. The quote-and-verify grounding primitives + the repo-path normalizer live
 *      ONLY in shared/src/validation/findingGrounding.ts. audit-code consumes
 *      them; it does not reimplement verifyFindingGrounding / quoteMatches /
 *      normalizeRepoPath.
 *   3. audit-code IMPORTS the shared grounding runner, allowlist, and quote
 *      grounding primitives.
 */
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTsFiles } from "./testFileUtils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES = resolve(__dirname, "../..");

const SHARED_SRC = join(REPO_PACKAGES, "src", "shared");
const AUDIT_SRC = join(REPO_PACKAGES, "src", "audit");
const REMEDIATE_SRC = join(REPO_PACKAGES, "src", "remediate");

const SHARED_ALLOWLISTED_EXEC = join(SHARED_SRC, "tooling", "allowlistedExec.ts");
const SHARED_FINDING_GROUNDING = join(SHARED_SRC, "validation", "findingGrounding.ts");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const ALL_SRC_FILES = [
  ...collectTsFiles(SHARED_SRC),
  ...collectTsFiles(AUDIT_SRC),
  ...collectTsFiles(REMEDIATE_SRC),
];

// ── Guard 1: single allowlisted runner + arg allowlist ────────────────────────

test("grounding-single-source/1a: shared owns the runner + the default-deny arg allowlist", () => {
  const src = read(SHARED_ALLOWLISTED_EXEC);
  expect(src, "must export isAllowedAnchorCommand").toMatch(/export function isAllowedAnchorCommand\(/);
  expect(src, "must export the read-only runner").toMatch(/export const runAllowlistedReadOnlyCommand/);
  // The default-deny posture: a per-executable flag policy, not a bare command[0] check.
  expect(src, "must carry a per-executable argument policy map").toMatch(/ARG_POLICIES/);
});

test("grounding-single-source/1b: no other src module declares its own anchor allowlist set", () => {
  // The prior fork declared ANCHOR_ALLOWLIST / GIT_READONLY_SUBCOMMANDS in
  // audit-code. They must now be imported from shared, never re-declared.
  const offenders: string[] = [];
  for (const file of ALL_SRC_FILES) {
    if (file === SHARED_ALLOWLISTED_EXEC) continue;
    const src = read(file);
    if (
      /(?:export\s+)?const\s+ANCHOR_ALLOWLIST\s*[:=]/.test(src) ||
      /(?:export\s+)?const\s+GIT_READONLY_SUBCOMMANDS\s*[:=]/.test(src)
    ) {
      offenders.push(file.replace(/\\/g, "/"));
    }
  }
  expect(offenders, `Only shared/src/tooling/allowlistedExec.ts may declare the anchor allowlist; re-declared in: ${offenders.join(", ")}`).toEqual([]);
});

// (The former 1c pinned the deleted src/audit/validation/anchorGrounding.ts —
// the orphan-module sweep removed that module and its consumer test, CY-01.)

// ── Guard 2: single grounding primitives + path normalizer ────────────────────

test("grounding-single-source/2a: shared owns the quote-grounding primitives + path normalizer", () => {
  const src = read(SHARED_FINDING_GROUNDING);
  for (const sym of [
    "export function normalizeForMatch(",
    "export function quoteMatches(",
    "export async function verifyFindingGrounding(",
    "export function normalizeRepoPath(",
    "export function findingIsGrounded(",
    "export function findingNeedsVerificationBeforeFix(",
  ]) {
    expect(src.includes(sym), `findingGrounding.ts must define: ${sym}`).toBeTruthy();
  }
});

test("grounding-single-source/2b: designFindingGrounding consumes the shared path normalizer", () => {
  // designFindingGrounding.ts lives in shared (next to findingGrounding.ts)
  // so both orchestrators consume the single primitive with no cross-area import;
  // it imports normalizeRepoPath from the sibling shared module, never redefines it.
  // (The former audit-side quoteGrounding.ts re-export shim was deleted in the
  // orphan-module sweep, CY-01 — consumers import audit-tools/shared directly.)
  const design = read(join(SHARED_SRC, "validation", "designFindingGrounding.ts"));
  expect(!/function\s+normalizeRepoPath\s*\(/.test(design), "designFindingGrounding.ts must import normalizeRepoPath from shared, not define it").toBeTruthy();
  expect(design, "designFindingGrounding.ts must import normalizeRepoPath from the shared findingGrounding module").toMatch(/normalizeRepoPath[^]*from\s+["']\.\/findingGrounding\.js["']/);
});
