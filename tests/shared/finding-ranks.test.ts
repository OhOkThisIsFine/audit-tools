import { test, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── fault injection for the mid-walk stat ────────────────────────────────────
//
// The race the `walk` guard closes — a file listed by readdir and gone by the
// time statSync runs — cannot be produced from a synchronous walk by timing:
// there is no interleaving point to hit. So the fault is INJECTED at the stat
// call instead. The mock passes the real node:fs through untouched and throws
// only for the single path a test arms, so the REAL `walk` runs over a REAL
// directory and the guard under test is the one in the module's source.
//
// `vi.hoisted` because the factory runs before this file's own top-level
// bindings exist; anything the factory closes over must be hoisted with it.
type Fault = { path: string; error: Error } | null;
const fault = vi.hoisted(() => ({ stat: null as Fault, readdir: null as Fault }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realStat = actual.statSync as (...args: unknown[]) => unknown;
  const realReaddir = actual.readdirSync as (...args: unknown[]) => unknown;
  return {
    ...actual,
    statSync: ((path: unknown, ...rest: unknown[]) => {
      if (fault.stat && String(path) === fault.stat.path) throw fault.stat.error;
      return realStat(path, ...rest);
    }) as typeof actual.statSync,
    readdirSync: ((path: unknown, ...rest: unknown[]) => {
      if (fault.readdir && String(path) === fault.readdir.path) throw fault.readdir.error;
      return realReaddir(path, ...rest);
    }) as typeof actual.readdirSync,
  };
});

/** A synthetic errno fault with the `code` the guard's classifier reads. */
function errnoFault(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: injected by the walk guard's test`);
  error.code = code;
  return error;
}

const { severityRank, confidenceRank, severityCompare, SEVERITIES, CONFIDENCES } =
  await import("../../src/shared/types/lens.js");

test("severityRank is 1-based, critical=5..info=1, derived from SEVERITIES", () => {
  // The 1-based scale is load-bearing: remediate dispatch tiering compares the
  // rank against literal thresholds (critical === 5, low <= 2).
  expect(severityRank("critical")).toBe(5);
  expect(severityRank("high")).toBe(4);
  expect(severityRank("medium")).toBe(3);
  expect(severityRank("low")).toBe(2);
  expect(severityRank("info")).toBe(1);
  // No level ranks at 0 (the agentReflections off-by-one we collapsed).
  for (const s of SEVERITIES) expect(severityRank(s) >= 1, `${s} >= 1`).toBeTruthy();
});

test("severityRank is strictly monotonic over the canonical order", () => {
  // SEVERITIES is most-severe-first; each step down must strictly decrease.
  for (let i = 1; i < SEVERITIES.length; i++) {
    expect(severityRank(SEVERITIES[i - 1]) > severityRank(SEVERITIES[i]), `rank(${SEVERITIES[i - 1]}) > rank(${SEVERITIES[i]})`).toBeTruthy();
  }
});

test("confidenceRank is strictly monotonic, high=3..low=1", () => {
  expect(confidenceRank("high")).toBe(3);
  expect(confidenceRank("medium")).toBe(2);
  expect(confidenceRank("low")).toBe(1);
  for (let i = 1; i < CONFIDENCES.length; i++) {
    expect(confidenceRank(CONFIDENCES[i - 1]) > confidenceRank(CONFIDENCES[i]), `rank(${CONFIDENCES[i - 1]}) > rank(${CONFIDENCES[i]})`).toBeTruthy();
  }
});

test("severityCompare orders most-severe-first (critical before info)", () => {
  const shuffled: Array<(typeof SEVERITIES)[number]> = ["low", "critical", "info", "high", "medium"];
  const sorted = [...shuffled].sort((a, b) => severityCompare(a, b));
  expect(sorted).toEqual(["critical", "high", "medium", "low", "info"]);
  // Negative when the first arg is more severe; positive when less; 0 when equal.
  expect(severityCompare("critical", "info") < 0).toBeTruthy();
  expect(severityCompare("info", "critical") > 0).toBeTruthy();
  expect(severityCompare("high", "high")).toBe(0);
});

// ── Guard: no hand-copied severity/confidence rank table survives in src ───────
// The whole point of single-sourcing these in shared is that no package
// re-introduces its own literal `{ critical: 5, high: 4, ... }` table (the
// copies previously drifted: 0-based vs 1-based, inverted ordering). This guard
// fails if any src file outside lens.ts open-codes a severity rank literal.

const here = dirname(fileURLToPath(import.meta.url));
// tests/shared/ -> tests/ -> repo root
const repoRoot = join(here, "..", "..");
// The single-package layout (matching the siblings finding-identity-single-source
// and io-hash-primitives-single-source already scan). These pointed at the
// retired packages/*/src layout (TST-eb0de44d): readdirSync threw ENOENT, walk()
// swallowed it, zero files were scanned and the guard passed unconditionally.
const SRC_DIRS = [
  join(repoRoot, "src", "shared"),
  join(repoRoot, "src", "audit"),
  join(repoRoot, "src", "remediate"),
];
const CODE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;
// The single source of truth — the only file allowed to hold a rank literal.
const CANONICAL_FILE = join(repoRoot, "src", "shared", "types", "lens.ts");

/**
 * Every scannable file under `dir`.
 *
 * Deliberately NOT try/caught on readdir: a directory this guard cannot read is
 * a misconfigured scan root, not an empty one. Swallowing it is exactly how the
 * guard came to scan nothing while reporting success.
 *
 * The `statSync` beside it IS guarded, but only for ENOENT — a file that
 * disappears between the directory listing and the stat. That is a genuine
 * transient (a concurrent build cleaning `dist/`, an editor's temp file), and
 * letting it kill the guard is the CP-NODE-25 residual: the walk would throw
 * mid-scan and the suite would report a missing-file error instead of a verdict.
 * Every OTHER stat fault still propagates — a permission error is a real
 * problem with the scan, not a file that moved.
 *
 * Exported for the contract test, which drives both halves over a fixture tree.
 */
export function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(p).isDirectory();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (isDirectory) {
      // A directory that vanishes mid-walk is the same transient one level up.
      try {
        out = out.concat(walk(p));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    } else if (CODE_EXT.test(name)) out.push(p);
  }
  return out;
}

/**
 * Does `text` carry a hand-written severity rank table — an object literal
 * mapping the severity names to numbers, e.g.
 *   { critical: 5, high: 4, medium: 3, low: 2, info: 1 }
 *
 * KEY-ORDER-INDEPENDENT. The regex this replaces required the five keys in
 * exactly the source order (`critical, high, medium, low, info`) and a
 * comma-separated literal, so a table re-ordered, split across lines with a
 * comment between entries, or written with different quoting went undetected —
 * the CP-NODE-25 residual. What identifies a rank table is that the SAME object
 * literal carries all five severity names, each mapped to a number, in any
 * order and in either quote style.
 *
 * Exported for the contract test.
 */
export function findRankTableLiterals(text: string): string[] {
  const hits: string[] = [];
  // Every object literal, balanced-brace bounded, so entries of one table can
  // never be matched against entries of a neighbouring one.
  for (const literal of objectLiterals(text)) {
    const keys = new Set<string>();
    let hasNonNumeric = false;
    for (const m of literal.body.matchAll(/(?:^|[{,\s])["']?([A-Za-z_$][\w$]*)["']?\s*:\s*([^,}]+)/gu)) {
      keys.add(m[1]!);
      if (!/^\s*-?\d+\s*$/u.test(m[2]!)) hasNonNumeric = true;
    }
    const all = SEVERITY_NAMES.every((s) => keys.has(s));
    // A table of all five severities whose values are numbers — the fingerprint.
    // A shapes/registry entry that merely NAMES them (values are strings, calls,
    // or schema refs) is not a rank literal.
    if (all && !hasNonNumeric) hits.push(literal.text);
  }
  return hits;
}

/** The five severity names, read from the single source rather than re-spelled. */
const SEVERITY_NAMES: readonly string[] = SEVERITIES;

/** Every `{ … }` object literal in `text`, brace-balanced. */
function* objectLiterals(text: string): Generator<{ text: string; body: string }> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          yield { text: text.slice(i, j + 1), body: text.slice(i + 1, j) };
          i = j;
          break;
        }
      }
    }
  }
}

test("no severity/confidence rank-table literal exists outside the shared single source", () => {
  const hits: string[] = [];
  let scanned = 0;
  let canonicalVisited = false;
  for (const srcDir of SRC_DIRS) {
    for (const file of walk(srcDir)) {
      scanned += 1;
      // The canonical file is counted as VISITED before being skipped, so the
      // exemption is bound to SET MEMBERSHIP rather than to the file merely
      // existing on disk. `existsSync` alone asserted nothing: the walk could
      // stop covering src/shared/types and the exemption would still "hold"
      // while the scan silently lost the one file whose absence matters most
      // (CP-NODE-25 residual).
      if (file === CANONICAL_FILE) {
        canonicalVisited = true;
        continue;
      }
      const text = readFileSync(file, "utf8");
      for (const literal of findRankTableLiterals(text)) {
        hits.push(`${file.slice(repoRoot.length + 1)}: ${literal.replace(/\s+/gu, " ")}`);
      }
    }
  }
  // A scan over zero files reports zero hits forever. Assert the guard reached
  // real source, and that the canonical file it exempts is one the walk ACTUALLY
  // covered.
  expect(scanned > 0, `the rank-literal scan visited no files under ${SRC_DIRS.join(", ")}`).toBeTruthy();
  expect(
    canonicalVisited,
    `CANONICAL_FILE was not reached by the walk: ${CANONICAL_FILE} — the exemption is asserting ` +
      `membership in a set the scan no longer covers`,
  ).toBe(true);
  expect(hits.length, "Severity rank tables are single-sourced in audit-tools/shared " +
      "(severityRank/confidenceRank/severityCompare, derived from SEVERITIES/CONFIDENCES). " +
      "Do not re-introduce a literal rank table; import the shared functions instead.\n" +
      hits.join("\n")).toBe(0);
});

test("the rank-literal detector is key-order-independent and quoting-independent", () => {
  // The CP-NODE-25 residual: the prior regex matched ONE key order and one
  // comma-separated shape, so a re-inlined table in any other order passed.
  for (const spelling of [
    "{ critical: 5, high: 4, medium: 3, low: 2, info: 1 }",
    "{ info: 1, low: 2, medium: 3, high: 4, critical: 5 }",
    "{ 'critical': 5,\n  'high': 4,\n  'medium': 3,\n  'low': 2,\n  'info': 1 }",
    "{ high: 4, critical: 5, info: 1, medium: 3, low: 2 }",
  ]) {
    expect(findRankTableLiterals(spelling).length, spelling).toBeGreaterThan(0);
  }
  // A schema-ish entry naming the same keys with NON-numeric values is not a
  // rank table — flagging it would make the guard a noise source.
  expect(
    findRankTableLiterals(
      "{ critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' }",
    ),
  ).toEqual([]);
  // Two SEPARATE literals that each hold part of the table are not one table:
  // the balanced-brace bound keeps entries from being matched across literals.
  expect(
    findRankTableLiterals("{ critical: 5, high: 4 }, { medium: 3, low: 2, info: 1 }"),
  ).toEqual([]);
});

// ── the mid-walk ENOENT guard (CP-NODE-25 residual) ───────────────────────────

test("walk survives an entry that disappears between the listing and the stat", async () => {
  // The residual: an unguarded `statSync` beside the (already guarded)
  // `readdirSync` meant a file vanishing mid-walk — a concurrent `clean-dist`,
  // an editor's temp file — killed the guard with a raw ENOENT instead of
  // returning a verdict. The suite then reported a missing file, not a finding.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "rank-walk-"));
  try {
    writeFileSync(join(dir, "present.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "vanished.ts"), "export const b = 2;\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.ts"), "export const c = 3;\n");

    // readdir just listed it; stat cannot see it any more. Exactly the race.
    fault.stat = { path: join(dir, "vanished.ts"), error: errnoFault("ENOENT") };
    const files = walk(dir);
    expect(files.some((f) => f.endsWith("present.ts")), "the healthy sibling still scans").toBe(true);
    expect(files.some((f) => f.endsWith("nested.ts")), "the healthy subtree still scans").toBe(true);
    expect(files.some((f) => f.endsWith("vanished.ts")), "the vanished entry is skipped").toBe(false);

    // The other call site: the stat saw a directory, and the DIRECTORY is gone
    // by the time the recursion lists it — the same transient one level up, at
    // the `readdirSync` inside the recursive call rather than at the stat.
    fault.stat = null;
    fault.readdir = { path: join(dir, "sub"), error: errnoFault("ENOENT") };
    const withoutSub = walk(dir);
    expect(withoutSub.some((f) => f.endsWith("nested.ts")), "the vanished subtree is skipped").toBe(false);
    expect(withoutSub.some((f) => f.endsWith("present.ts")), "its sibling is unaffected").toBe(true);
  } finally {
    fault.stat = null;
    fault.readdir = null;
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walk still propagates a NON-ENOENT stat failure — a real fault is not a transient", async () => {
  // The guard is scoped to ENOENT on purpose. Widening it to a bare catch would
  // turn a permission error (a genuinely broken scan) into a silent skip, which
  // is the inert-guard shape this whole file exists to prevent.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "rank-walk-fault-"));
  try {
    writeFileSync(join(dir, "locked.ts"), "export const a = 1;\n");
    fault.stat = { path: join(dir, "locked.ts"), error: errnoFault("EACCES") };
    expect(() => walk(dir)).toThrow(/EACCES/);
  } finally {
    fault.stat = null;
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});
