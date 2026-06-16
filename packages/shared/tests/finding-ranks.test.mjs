import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { severityRank, confidenceRank, severityCompare, SEVERITIES, CONFIDENCES } =
  await import("../src/types/lens.ts");

test("severityRank is 1-based, critical=5..info=1, derived from SEVERITIES", () => {
  // The 1-based scale is load-bearing: remediate dispatch tiering compares the
  // rank against literal thresholds (critical === 5, low <= 2).
  assert.equal(severityRank("critical"), 5);
  assert.equal(severityRank("high"), 4);
  assert.equal(severityRank("medium"), 3);
  assert.equal(severityRank("low"), 2);
  assert.equal(severityRank("info"), 1);
  // No level ranks at 0 (the agentReflections off-by-one we collapsed).
  for (const s of SEVERITIES) assert.ok(severityRank(s) >= 1, `${s} >= 1`);
});

test("severityRank is strictly monotonic over the canonical order", () => {
  // SEVERITIES is most-severe-first; each step down must strictly decrease.
  for (let i = 1; i < SEVERITIES.length; i++) {
    assert.ok(
      severityRank(SEVERITIES[i - 1]) > severityRank(SEVERITIES[i]),
      `rank(${SEVERITIES[i - 1]}) > rank(${SEVERITIES[i]})`,
    );
  }
});

test("confidenceRank is strictly monotonic, high=3..low=1", () => {
  assert.equal(confidenceRank("high"), 3);
  assert.equal(confidenceRank("medium"), 2);
  assert.equal(confidenceRank("low"), 1);
  for (let i = 1; i < CONFIDENCES.length; i++) {
    assert.ok(
      confidenceRank(CONFIDENCES[i - 1]) > confidenceRank(CONFIDENCES[i]),
      `rank(${CONFIDENCES[i - 1]}) > rank(${CONFIDENCES[i]})`,
    );
  }
});

test("severityCompare orders most-severe-first (critical before info)", () => {
  const shuffled = ["low", "critical", "info", "high", "medium"];
  const sorted = [...shuffled].sort((a, b) => severityCompare(a, b));
  assert.deepEqual(sorted, ["critical", "high", "medium", "low", "info"]);
  // Negative when the first arg is more severe; positive when less; 0 when equal.
  assert.ok(severityCompare("critical", "info") < 0);
  assert.ok(severityCompare("info", "critical") > 0);
  assert.equal(severityCompare("high", "high"), 0);
});

// ── Guard: no hand-copied severity/confidence rank table survives in src ───────
// The whole point of single-sourcing these in shared is that no package
// re-introduces its own literal `{ critical: 5, high: 4, ... }` table (the
// copies previously drifted: 0-based vs 1-based, inverted ordering). This guard
// fails if any src file outside lens.ts open-codes a severity rank literal.

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> shared/ -> packages/ -> repo root
const repoRoot = join(here, "..", "..", "..");
const SRC_DIRS = [
  join(repoRoot, "packages", "shared", "src"),
  join(repoRoot, "packages", "audit-code", "src"),
  join(repoRoot, "packages", "remediate-code", "src"),
];
const CODE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;
// The single source of truth — the only file allowed to hold a rank literal.
const CANONICAL_FILE = join(repoRoot, "packages", "shared", "src", "types", "lens.ts");

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (CODE_EXT.test(name)) out.push(p);
  }
  return out;
}

test("no severity/confidence rank-table literal exists outside the shared single source", () => {
  // Detects an object literal that maps severity names to numbers, e.g.
  //   { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
  // tolerant of whitespace/newlines and a trailing comma. Confidence-only tables
  // ({ high: n, medium: n, low: n }) are a subset of severity detection's signal
  // but we anchor on `critical: <num>` adjacent to `high: <num>` which is the
  // unambiguous fingerprint of a copied severity table.
  const rankLiteral =
    /critical\s*:\s*\d+\s*,\s*high\s*:\s*\d+\s*,\s*medium\s*:\s*\d+\s*,\s*low\s*:\s*\d+\s*,\s*info\s*:\s*\d+/u;
  const hits = [];
  for (const srcDir of SRC_DIRS) {
    for (const file of walk(srcDir)) {
      if (file === CANONICAL_FILE) continue;
      const text = readFileSync(file, "utf8");
      if (rankLiteral.test(text)) {
        hits.push(file.slice(repoRoot.length + 1));
      }
    }
  }
  assert.equal(
    hits.length,
    0,
    "Severity rank tables are single-sourced in @audit-tools/shared " +
      "(severityRank/confidenceRank/severityCompare, derived from SEVERITIES/CONFIDENCES). " +
      "Do not re-introduce a literal rank table; import the shared functions instead.\n" +
      hits.join("\n"),
  );
});
