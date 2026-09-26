#!/usr/bin/env node
// sites-pinned: tests/shared/source-test-ownership.test.ts
// Source → test OWNERSHIP gate: verifies, for each row of the single-sourced
// `SOURCE_TEST_OWNERSHIP` map, that each bound test actually EXECUTES the subject
// and ASSERTS on what the subject declares — two evidence classes kept apart.
//
// WHY THIS EXISTS. Two pinning mechanisms — the per-site `// sites-pinned:`
// declaration and the PINS subject graph — bind a SOURCE to a test NAME. A name
// is the author's word about their own work: the gates measured "the named test
// exists" (tracked + declares `test(...)`), never "the named test EXECUTES this
// code". This gate closes that gap over the DECLARED ownership map
// (`SOURCE_TEST_OWNERSHIP`, the single home for product-source → test ownership
// shared by both consumers) by VERIFYING, for each row, two evidence classes the
// backlog (O11 / O36) demanded be kept separate:
//
//   1. REACH — does the test EXECUTE the subject? Established by RUNNING the test
//      in isolation under the repository's real coverage tooling
//      (`@vitest/coverage-v8`) and inspecting the subject's own coverage record
//      for a line that actually ran. This is EXECUTION coverage, not a static
//      import-closure / disk-path proxy: a test that IMPORTS the subject but
//      never runs it produces an all-zero line map and is REFUSED as
//      `missing-reach: never-executes`; a test that neither imports nor executes
//      it produces NO record at all and is REFUSED as `missing-reach: unrelated`.
//
//   2. BEHAVIOURAL EVIDENCE — does the test ASSERT on anything the subject
//      DECLARES? Derived statically from the subject's declared exports and the
//      test's binding + use (`assertsBehavior`). A test that executes the subject
//      but binds none of its exports, or binds one and never uses it, has reach
//      and no proof the changed behaviour is pinned. REFUSED as
//      `missing-behaviour`.
//
// The two refusals are DISTINCT so a reader is told which half of the pin is
// missing, never handed one "bad test" verdict folding an unrelated test together
// with an under-asserting one.
//
// ── WHY REACH IS RUNTIME, NOT STATIC ─────────────────────────────────────────
// The O36 backlog item ("the per-site pinning gate's name binding is
// author-supplied") demanded the expected-failing test name be DERIVED and reach
// established by EXECUTION. The prior `classifyOwnership` static proxy said so
// itself while still shipping an import-closure + disk-path scan as the gate's
// reach verdict — an author-supplied import relationship wearing a mechanical
// check's clothes, which is exactly the relocation O36 bans. Runtime coverage is
// the direct method: it proves a line of the subject ran under the test, so an
// imports-but-never-executes binding fails here the same way an unrelated one
// does (differently-diagnosed).
//
// ── THE STATED, DELIBERATE CEILING ───────────────────────────────────────────
// Behavioural evidence is still a static reading: line-level coverage proves the
// subject EXECUTED, not that a specific assertion mirrors the exact changed
// behaviour — import/name provenance is the undecidable class the
// acquired-analyzer boundary already declares. An author-supplied test NAME is
// therefore never advertised here as proof of an assertion. What this gate adds
// is the mechanical DEDUPLICATION between "executes" and "asserts" so neither is
// silently taken to imply the other.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SOURCE_TEST_OWNERSHIP } from "./shared/source-test-ownership-data.mjs";
import { assertsBehavior, runCoverageForTest, subjectExports } from "./shared/source-test-reach.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const tracked = new Set(
  execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: repoRoot, windowsHide: true })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean),
);

const readText = (rel) => readFileSync(join(repoRoot, rel), "utf8");

/**
 * Resolve one source → test binding to its two evidence verdicts. Reach is the
 * injected `resolveReach` (runtime coverage in production; scripted in tests);
 * behavioural evidence is pure over the injected subject/test texts.
 *
 * @param {{source: string, test: string, subjectText: string, testText: string,
 *          resolveReach: (subject: string, test: string) => {reached: boolean, hasRecord: boolean, testFailed?: boolean, diagnostics?: string}}} input
 * @returns {{verdict: 'ok'|'unrelated'|'never-executes'|'no-behaviour'|'unverifiable', asserted: string[]}}
 */
export function classifyBinding({ source, test, subjectText, testText, resolveReach }) {
  const { reached, hasRecord, testFailed, diagnostics } = resolveReach(source, test);
  if (diagnostics && !hasRecord) return { verdict: "unverifiable", asserted: [] };
  if (!reached) {
    if (!hasRecord) {
      // No coverage record → the test never loaded the subject at all. Unrelated.
      return { verdict: "unrelated", asserted: [] };
    }
    if (testFailed) {
      // The subject loaded (record exists) but the run went red before anything
      // executed, and no executed line was observed. Never-executes (or the
      // assertion failed before the subject ran). The green run is what grants
      // reach; the red run is advisory, never a false pass.
      return { verdict: "never-executes", asserted: [] };
    }
    // A green run whose subject record is entirely zero-count: loaded, never run.
    return { verdict: "never-executes", asserted: [] };
  }
  const asserted = assertsBehavior(testText, subjectExports(subjectText));
  if (asserted.length === 0) {
    return { verdict: "no-behaviour", asserted: [] };
  }
  return { verdict: "ok", asserted };
}

/**
 * The runtime reach resolver the production gate uses: run THIS test in isolation
 * under V8 coverage and read the subject's executed-line evidence. Coverage is
 * scoped to the subject, so a test bound to two subjects needs two measurements.
 */
export function ownRuntimeReachResolver(makeProps = {}) {
  return (source, test) =>
    runCoverageForTest(source, test, { reportOnFailure: makeProps.reportOnFailure });
}

/**
 * Reconcile the ownership map against the tracked tree. For each bound test it
 * verifies, through the injected `resolveReach`, that the test EXECUTES the
 * subject (runtime coverage) and ASSERTS on a declared export — two SEPARATE
 * diagnostics. Pure over the injected `rows`/`trackedSet`/`readTextFn`/`resolveReach`
 * so the contract test drives every refusal against fixture inputs without
 * touching the real tree.
 *
 * @param {{source: string, tests: string[], what: string}[]} rows
 * @param {Set<string>} trackedSet
 * @param {(p: string) => string} readTextFn
 * @param {(subject: string, test: string) => {reached: boolean, hasRecord: boolean, testFailed?: boolean, diagnostics?: string}} resolveReach
 * @returns {{errors: string[], advisory: string[], reachable: number, total: number, unverifiable: number}}
 */
export function reconcileSourceTestOwnership(rows, trackedSet, readTextFn, resolveReach) {
  const errors = [];
  const advisory = [];
  let reachable = 0;
  let total = 0;
  let unverifiable = 0;
  /** @type {Map<string, string>} path → text, for a shared readText cache */
  const textCache = new Map();
  const read = (p) => {
    if (!textCache.has(p)) textCache.set(p, readTextFn(p));
    return /** @type {string} */ (textCache.get(p));
  };
  /** @type {Map<string, {source: string, test: string, testFailed?: boolean}[]>} test file → bindings */
  const byTest = new Map();
  // First pass: shape + resolution of every source/tracked binding, collecting
  // the pairs to run reach on.
  for (const row of rows) {
    if (!trackedSet.has(row.source)) {
      errors.push(`SOURCE_TEST_OWNERSHIP names ${row.source}, which is NOT a tracked file.`);
      continue;
    }
    if (!Array.isArray(row.tests) || row.tests.length === 0) {
      errors.push(`SOURCE_TEST_OWNERSHIP binds ${row.source} to NO test — an obligation that obliges nothing.`);
      continue;
    }
    try {
      read(row.source);
    } catch {
      errors.push(`SOURCE_TEST_OWNERSHIP binds ${row.source}, which could not be read.`);
      continue;
    }
    for (const test of row.tests) {
      if (!trackedSet.has(test)) {
        errors.push(`SOURCE_TEST_OWNERSHIP binds ${row.source} to ${test}, which is NOT a tracked file.`);
        continue;
      }
      let testText;
      try {
        testText = read(test);
      } catch {
        errors.push(`SOURCE_TEST_OWNERSHIP binds ${row.source} to ${test}, which could not be read.`);
        continue;
      }
      total += 1;
      const bucket = byTest.get(test) ?? [];
      bucket.push({ source: row.source, test });
      byTest.set(test, bucket);
      textCache.set(`__text:${test}`, testText);
    }
  }

  // Second pass: resolve REACH once per source/test pair, then fold the
  // per-binding verdicts. Each coverage run instruments only its source.
  const reachCache = new Map();
  for (const [test, bindingsList] of byTest) {
    const testText = read(`__text:${test}`);
    for (const binding of bindingsList) {
      const key = `${binding.source}\0${test}`;
      if (!reachCache.has(key)) reachCache.set(key, resolveReach(binding.source, test));
      const reach = reachCache.get(key);
      const { verdict } = classifyBinding({
        source: binding.source,
        test,
        subjectText: read(binding.source),
        testText,
        resolveReach: () => reach,
      });
      if (verdict === "ok") {
        reachable += 1;
        continue;
      }
      if (verdict === "unrelated") {
        errors.push(
          `${binding.source} → ${test}: that test never EXECUTES the subject (no coverage record for it) — ` +
            `a pin to a test that does not run the code pins nothing. (missing-reach: unrelated)`,
        );
      } else if (verdict === "never-executes") {
        errors.push(
          `${binding.source} → ${test}: the test LOADS the subject but never EXECUTES a line of it ` +
            `(a red run with no executed line observed) — importing without executing pins nothing. ` +
            `(missing-reach: never-executes)`,
        );
      } else if (verdict === "no-behaviour") {
        reachable += 1;
        errors.push(
          `${binding.source} → ${test}: the test EXECUTES the subject but asserts on none of its exports — ` +
            `reach without a behavioural assertion is not proof the pin means anything. (missing-behaviour)`,
        );
      } else {
        unverifiable += 1;
        errors.push(
          `${binding.source} → ${test}: reach could not be determined (${reach.diagnostics ?? "no coverage report"}) — ` +
            `the binding is NOT verified and cannot pass.`,
        );
      }
    }
  }

  // Advisory: a bound test that RAN RED is surfaced even where reach still holds,
  // so a failing pin is never silent.
  for (const [test, bindingsList] of byTest) {
    for (const binding of bindingsList) {
      const reach = reachCache.get(`${binding.source}\0${test}`);
      if (!reach?.testFailed) continue;
      errors.push(
        `${binding.source} → ${test}: the owning test FAILED when run in isolation; ` +
          `a failing test cannot certify the source's behaviour.`,
      );
    }
  }

  return { errors, advisory, reachable, total, unverifiable };
}

function main() {
  // Reach runs are ~1-2s each; the map is curated (a handful of test files).
  const resolveReach = ownRuntimeReachResolver();
  const { errors, advisory, reachable, total } = reconcileSourceTestOwnership(
    SOURCE_TEST_OWNERSHIP,
    tracked,
    readText,
    resolveReach,
  );

  for (const line of advisory) console.log(`  ⚠ ${line}`);

  if (errors.length > 0) {
    console.error("✗ source-test-ownership check failed:\n\n" + errors.join("\n\n") + "\n");
    process.exit(1);
  }
  console.log(
    `✓ source-test-ownership: ${SOURCE_TEST_OWNERSHIP.length} source(s) map to ${total} owning ` +
      `test(s); ${reachable} executed their subject and syntactically used a declared export ` +
      `(runtime execution coverage + static name-use check; this does not prove assertion sensitivity).`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
