// sites-pinned: tests/shared/source-test-ownership.test.ts
// Source → test OWNERSHIP evidence split, kept APART by construction: EXECUTION
// REACH and BEHAVIOURAL EVIDENCE. Both consumers — the `check:source-test-ownership`
// gate (`scripts/check-source-test-ownership.mjs`) and the pin obligations
// (`reconcilePinObligations` in `scripts/shared/derived-file-preflight.mjs`) —
// share this module so the two "does this test reach this source" answers cannot
// drift (O11).
//
// ── THE TWO EVIDENCE CLASSES ─────────────────────────────────────────────────
//
//   REACH — does this test EXECUTE the subject? Established by ACTUAL EXECUTION
//     COVERAGE: the test is RUN in isolation under the repository's real coverage
//     tooling (`@vitest/coverage-v8`, the V8 runtime profiler), and the subject's
//     coverage record is inspected for a line that was actually exercised at
//     runtime. `executionReached` is the pure decision; `runCoverageForTest`
//     is the spawner `check:source-test-ownership` calls. The O36 backlog item
//     named the fix — "the expected-failing test name must be DERIVED, and reach
//     has to be established by EXECUTION, not by the author's word" — and the
//     previous static proxy (transitive import closure + disk-path-literal scan)
//     did NOT meet that spec: it said so itself, and it could not tell a test
//     that IMPORTS the subject but NEVER runs it from one that does. A static
//     import edge is a lead, not execution.
//
//   BEHAVIOURAL EVIDENCE — does the test ASSERT on a symbol the subject DECLARES?
//     Derived STATICALLY from the subject's declared exports and the test's
//     binding + use (`subjectExports`, `bindings`, `assertsBehavior`), because
//     import-name / call-site provenance — "which string in a test came from
//     which source symbol" — is the undecidable class the acquired-analyzer
//     boundary already declares. Reach is necessary but not sufficient: a test
//     that executes the subject but asserts on none of its exports has reach and
//     no behavioural proof, and is refused distinctly.
//
// Both halves are deliberately coarse. A NAMED export is the evidence floor,
// never a claim that the assertion mirrors the exact changed behaviour.
// Author-supplied names and import relationships are never advertised as proof
// of a specific assertion.

import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
// Vitest's entry is resolved through the real require so a bare `vitest/vitest.mjs`
// specifier maps into THIS checkout's node_modules, never a global.
const requireFromRoot = createRequire(join(REPO_ROOT, "package.json"));

// ── EXECUTION REACH: the runtime half ────────────────────────────────────────
//
// How the subject's coverage record is found and read. V8 coverage (vitest's
// `coverage-final.json`, the merged output of `@vitest/coverage-v8`) keys each
// record by the source's ABSOLUTE file URL/path; the subject is matched by its
// repo-relative path suffix. `text://` entries are files loaded directly from
// a user source string (virt:test / inline modules) — never a tracked subject —
// and nothing without `s`/`map` can prove a line ran.

/**
 * Whether a SINGLE coverage record proves the subject EXECUTED at runtime: at
 * least one declared line (statement/literal) carries a positive hit count.
 * Pure — driven against fixture records without touching vitest or the tree.
 *
 * The `.mjs`/global-execution nuance is handled by the parent (`runCoverageForTest`),
 * not here: a `.mjs` subject may execute entirely at import time (guard-reach data
 * is a top-level array literal), which V8 reports as covered lines with no function
 * counts, while a `.ts` subject reports its runtime function calls the same way.
 * A record whose line map has ANY positive count is execution reach in both cases;
 * a record with only zero-count lines is "loaded but never executed".
 *
 * @param {Record<string, number> | undefined} statementMapAndCounts a record shaped like
 *   `{ "<line>": <count> }` — the subject's coverage entry under `coverage-final.json`
 *   (the `s` statement-count map)
 * @param {number} [minCount] the count that separates "executed" from "registered but never run" (default 1)
 * @returns {boolean}
 */
export function recordReached(statementMapAndCounts, minCount = 1) {
  if (!statementMapAndCounts || typeof statementMapAndCounts !== "object") return false;
  return Object.values(statementMapAndCounts).some((c) => Number(c) >= minCount);
}

/**
 * Whether an executed test file's merged coverage proves the SUBJECT executed.
 * Pure — the merged coverage is injected so the contract test drives fixture
 * maps (including the "imported but never executed" case) without a real run.
 *
 * @param {Record<string, {s?: Record<string, number>} | undefined>} mergedCoverage
 *   coverage-final.json shape: absolute path → `{ s: { line: count } }` statement record
 * @param {string} subjectPath repo-relative subject path (`src/…` / `scripts/…`)
 * @param {number} [minCount]
 * @returns {{reached: boolean, hasRecord: boolean}}
 */
export function executionReached(mergedCoverage, subjectPath, minCount = 1) {
  const wanted = norm(subjectPath);
  let hasRecord = false;
  for (const [key, record] of Object.entries(mergedCoverage)) {
    if (String(key).startsWith("text://")) continue; // an inline/virtual module, never a tracked subject
    if (!norm(key).endsWith(wanted)) continue;
    hasRecord = true;
    if (recordReached(record?.s, minCount)) return { reached: true, hasRecord: true };
  }
  return { reached: false, hasRecord };
}

/**
 * Run ONE bound test in isolation under V8 coverage and read the subject's
 * executed-line evidence. This is the runtime answer to "does this named test
 * execute this source" — import closure and disk-path literals are never
 * consulted here, because an import that is never exercised leaves a zero-count
 * line map.
 *
 * `--coverage.include=<subject>` narrows coverage to exactly the subject so the
 * report contains one record to inspect (and the probe stays fast); v8 counts
 * are still global-execution real, so a test that merely imports the subject and
 * never runs it yields an all-zero record and is refused as never-executes.
 *
 * @param {string} subjectPath repo-relative subject path
 * @param {string} testPath repo-relative test file path
 * @param {{reportOnFailure?: boolean}} [opts]
 * @returns {{reached: boolean, hasRecord: boolean, exit: number | null, testFailed: boolean, diagnostics: string}}
 */
export function runCoverageForTest(subjectPath, testPath, opts = {}) {
  const reportOnFailure = opts.reportOnFailure !== false; // default: evidence survives a failed pin test too
  const reportsDir = mkdtempSync(join(tmpdir(), "src-test-ownership-"));
  const dirArg = (reportsDir).replace(/\\/g, "/");
  const vitestEntry = requireFromRoot.resolve("vitest/vitest.mjs");
  const args = [
    vitestEntry,
    "run",
    testPath,
    "--coverage.enabled",
    "--coverage.provider=v8",
    "--coverage.include=" + norm(subjectPath),
    "--coverage.reporter=json",
    "--coverage.reportOnFailure=" + String(reportOnFailure),
    "--coverage.reportsDirectory=" + dirArg,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true, // INV-WH — a console child from a windowless parent pops a window
    maxBuffer: 64 * 1024 * 1024,
  });
  const exit = result.status ?? (result.error ? 1 : 0);
  const testFailed = exit !== 0;
  let diagnostics = "";
  let reached = false;
  let hasRecord = false;
  const finalPath = join(reportsDir, "coverage-final.json");
  if (existsSync(finalPath)) {
    let merged;
    try {
      merged = JSON.parse(readFileSync(finalPath, "utf8"));
    } catch (err) {
      diagnostics = `coverage report unreadable: ${/** @type {any} */ (err)?.message ?? err}`;
    }
    if (merged) {
      const verdict = executionReached(merged, subjectPath, 1);
      reached = verdict.reached;
      hasRecord = verdict.hasRecord;
    }
  } else if (testFailed && reportOnFailure) {
    diagnostics =
      "coverage was not written for the failed run — the coverage provider is unavailable " +
      "(`@vitest/coverage-v8` not installed) or the run crashed before reporting";
  }
  rmSync(reportsDir, { recursive: true, force: true });
  return { reached, hasRecord, exit, testFailed, diagnostics };
}

// ── BEHAVIOURAL EVIDENCE: the static, bounded half ───────────────────────────

/**
 * The subject's DECLARED exports — the names a test could assert on. Extracted
 * from the subject source so a test binding one name has BEHAVIOURAL evidence and
 * a test binding none has only reach (executing the file for a side effect or an
 * unrelated symbol).
 */
export function subjectExports(text) {
  const names = new Set();
  for (const re of [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const m of text.matchAll(re)) names.add(m[1]);
  }
  return [...names];
}

/**
 * The named bindings a file's import clauses introduce: `{ a, b as c }` binds
 * `a` (remote `a`, local `a`) and `c` (remote `b`, local `c`); a default import
 * binds the default name; `* as ns` binds `ns`. Aliases are respected — the
 * `X as XImpl` wrapper pattern binds `XImpl` AND records its remote `X`, so the
 * behavioural check can map an aliased use back to the subject's export.
 */
export function bindings(text) {
  /** @type {{local: string, remote: string}[]} */
  const out = [];
  const addClause = (clause) => {
    for (const part of clause.split(",")) {
      const trimmed = part.trim().replace(/^type\s+/, "");
      if (!trimmed) continue;
      const seg = trimmed.split(/\s+as\s+/);
      const local = (seg.pop() ?? "").trim();
      // Without an `as`, the remote (imported) name IS the local name.
      const remote = (seg[0] ?? local).trim();
      if (local) out.push({ local, remote });
    }
  };
  for (const m of text.matchAll(/import\s+\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) addClause(m[1]);
  for (const m of text.matchAll(/import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*\{([^}]*)\})?\s*from\s*["'][^"']+["']/g)) {
    out.push({ local: m[1], remote: "default" });
    if (m[2]) addClause(m[2]);
  }
  for (const m of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*["'][^"']+["']/g)) {
    out.push({ local: m[1], remote: "*" });
  }
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*["'][^"']+["']/g)) addClause(m[1]);
  for (const m of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*["'][^"']+["']/g)) {
    out.push({ local: m[1], remote: "*" });
  }
  return out;
}

/**
 * Whether the test ASSERTS on one of the subject's DECLARED exports: it binds the
 * export's name (directly or aliased) AND USES that bound local outside its own
 * import clause — a call, an `expect` operand, a spread, a comparison. Reach
 * (now execution reach) is necessary but not sufficient, so this is the
 * BEHAVIOURAL half, reported separately from reach: a test that executes the
 * subject only for a side effect (or binds a name it never exercises) has reach
 * and no behavioural proof.
 */
export function assertsBehavior(testText, subjectExportsList) {
  const declared = new Set(subjectExportsList);
  const asserted = [];
  // The corpus a bound name must be USED in is the source with every import AND
  // re-export statement removed — a name appearing only in its own import clause
  // is bound-but-never-exercised, which is reach without behavioural proof.
  const body = testText.replace(
    /(?:import\s+(?:[^'"]*?\sfrom\s+)?["'][^"']+["'];?|export\s+(?:\{[^}]*\}|\*)\s*from\s*["'][^"']+["'];?|=\s*await\s+import\s*\(\s*["'][^"']+["']\)\s*;?)/g,
    "",
  );
  for (const { local, remote } of bindings(testText)) {
    // A binding asserts on the subject when EITHER its local name is a subject
    // export (`import { GUARDS }` then `GUARDS...`), or its REMOTE name is — the
    // `GUARDS as LIVE_GUARDS` alias, which must map back to the export.
    const names = declared.has(local) ? local : declared.has(remote) ? remote : null;
    if (!names) continue;
    if (new RegExp(`\\b${escapeRe(local)}\\b`).test(body)) asserted.push(names);
  }
  return [...new Set(asserted)];
}

function escapeRe(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
