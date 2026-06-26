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
 *   3. Both orchestrators IMPORT the shared grounding/runner (audit-code the
 *      runner+allowlist+quote grounding; remediate-code the grounding-status
 *      total function for the G1 verify-before-fix path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES = resolve(__dirname, "../..");

const SHARED_SRC = join(REPO_PACKAGES, "src", "shared");
const AUDIT_SRC = join(REPO_PACKAGES, "src", "audit");
const REMEDIATE_SRC = join(REPO_PACKAGES, "src", "remediate");

const SHARED_ALLOWLISTED_EXEC = join(SHARED_SRC, "tooling", "allowlistedExec.ts");
const SHARED_FINDING_GROUNDING = join(SHARED_SRC, "validation", "findingGrounding.ts");

function read(path) {
  return readFileSync(path, "utf8");
}

function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL_SRC_FILES = [
  ...collectTsFiles(SHARED_SRC),
  ...collectTsFiles(AUDIT_SRC),
  ...collectTsFiles(REMEDIATE_SRC),
];

// ── Guard 1: single allowlisted runner + arg allowlist ────────────────────────

test("grounding-single-source/1a: shared owns the runner + the default-deny arg allowlist", () => {
  const src = read(SHARED_ALLOWLISTED_EXEC);
  assert.match(src, /export function isAllowedAnchorCommand\(/, "must export isAllowedAnchorCommand");
  assert.match(
    src,
    /export const runAllowlistedReadOnlyCommand/,
    "must export the read-only runner",
  );
  // The default-deny posture: a per-executable flag policy, not a bare command[0] check.
  assert.match(src, /ARG_POLICIES/, "must carry a per-executable argument policy map");
});

test("grounding-single-source/1b: no other src module declares its own anchor allowlist set", () => {
  // The prior fork declared ANCHOR_ALLOWLIST / GIT_READONLY_SUBCOMMANDS in
  // audit-code. They must now be imported from shared, never re-declared.
  const offenders = [];
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
  assert.deepEqual(
    offenders,
    [],
    `Only shared/src/tooling/allowlistedExec.ts may declare the anchor allowlist; re-declared in: ${offenders.join(", ")}`,
  );
});

test("grounding-single-source/1c: anchorGrounding does not spawn an inspection command itself", () => {
  // The runner is shared; audit-code's anchorGrounding must not carry its own
  // child_process spawn (the prior local defaultAnchorRunner is gone).
  const anchorGrounding = read(join(AUDIT_SRC, "validation", "anchorGrounding.ts"));
  assert.ok(
    !/from\s+["']node:child_process["']/.test(anchorGrounding),
    "anchorGrounding.ts must not import node:child_process — it uses the shared runAllowlistedReadOnlyCommand",
  );
  assert.match(
    anchorGrounding,
    /runAllowlistedReadOnlyCommand/,
    "anchorGrounding.ts must consume the shared runner",
  );
});

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
    assert.ok(src.includes(sym), `findingGrounding.ts must define: ${sym}`);
  }
});

test("grounding-single-source/2b: audit-code does not reimplement the grounding primitives", () => {
  // quoteGrounding.ts is now a thin re-export; designFindingGrounding.ts imports
  // the shared normalizeRepoPath. Neither may define its own implementation.
  const quote = read(join(AUDIT_SRC, "validation", "quoteGrounding.ts"));
  assert.ok(
    !/export\s+async\s+function\s+verifyFindingGrounding\s*\(/.test(quote),
    "quoteGrounding.ts must re-export verifyFindingGrounding from shared, not define it",
  );
  assert.match(quote, /audit-tools\/shared/, "quoteGrounding.ts must source the primitives from shared");

  // designFindingGrounding.ts now lives in shared (next to findingGrounding.ts)
  // so both orchestrators consume the single primitive with no cross-area import;
  // it imports normalizeRepoPath from the sibling shared module, never redefines it.
  const design = read(join(SHARED_SRC, "validation", "designFindingGrounding.ts"));
  assert.ok(
    !/function\s+normalizeRepoPath\s*\(/.test(design),
    "designFindingGrounding.ts must import normalizeRepoPath from shared, not define it",
  );
  assert.match(
    design,
    /normalizeRepoPath[^]*from\s+["']\.\/findingGrounding\.js["']/,
    "designFindingGrounding.ts must import normalizeRepoPath from the shared findingGrounding module",
  );
});

// ── Guard 3: both orchestrators import the shared grounding/runner ─────────────

test("grounding-single-source/3a: audit-code imports the shared runner + allowlist + quote grounding", () => {
  const anchorGrounding = read(join(AUDIT_SRC, "validation", "anchorGrounding.ts"));
  for (const sym of ["isAllowedAnchorCommand", "runAllowlistedReadOnlyCommand"]) {
    assert.ok(
      new RegExp(`${sym}[^]*from\\s+["']audit-tools/shared["']`).test(anchorGrounding),
      `anchorGrounding.ts must import ${sym} from shared`,
    );
  }
  const quote = read(join(AUDIT_SRC, "validation", "quoteGrounding.ts"));
  assert.match(
    quote,
    /verifyFindingGrounding[^]*from\s+["']audit-tools\/shared["']/,
    "quoteGrounding.ts must import verifyFindingGrounding from shared",
  );
});

test("grounding-single-source/3b: remediate-code reads finding.grounding via the shared total function (G1/INV-GND-02)", () => {
  // The structured-audit plan path and the implement prompt both consult the
  // shared verify-before-fix predicate so a missing grounding verdict is treated
  // as ungrounded (never silently trusted).
  const plan = read(join(REMEDIATE_SRC, "phases", "plan.ts"));
  const dispatch = read(join(REMEDIATE_SRC, "steps", "dispatch.ts"));
  for (const [label, src] of [
    ["remediate-code/src/phases/plan.ts", plan],
    ["remediate-code/src/steps/dispatch.ts", dispatch],
  ]) {
    assert.ok(
      /findingNeedsVerificationBeforeFix[^]*from\s+["']audit-tools\/shared["']/.test(src),
      `${label} must import findingNeedsVerificationBeforeFix from shared`,
    );
    assert.match(
      src,
      /findingNeedsVerificationBeforeFix\(/,
      `${label} must consult findingNeedsVerificationBeforeFix on the grounding path`,
    );
  }
});
