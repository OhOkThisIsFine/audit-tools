/**
 * loop-core-gate-parity.test.mjs — the loop-core path set AND its membership
 * predicate have ONE hand-edited home, and every consumer provably sees them.
 *
 * The `.claude` hooks run as PreToolUse under plain node BEFORE any build, so
 * they cannot import `src/shared/loopCorePaths.ts`. They used to re-declare the
 * list, which put it in THREE places; a parity test held the invariant, so
 * nothing landed broken, but the discovery path was "edit two copies, find the
 * third when CI goes red". They now import a GENERATED sibling
 * (`.claude/hooks/loop-core-patterns.mjs`) produced from the TS source — which
 * carries BOTH the pattern list and the `isLoopCorePath` predicate, so the
 * matching SEMANTICS cannot fork either (each hook used to re-implement the
 * predicate as a local `pinsLoopCore` copy).
 *
 * What must hold, and why each half matters:
 *   - the generated module equals the source of truth. If it drifts, the gate
 *     silently runs against a different path set — narrowing it means loop-core
 *     commits stop requiring review attestation, with nothing to notice.
 *   - each hook actually CONSUMES the generated predicate, rather than having
 *     re-grown a local copy that would shadow the import and re-open the drift
 *     by construction.
 *   - the generated predicate returns the SAME verdicts as the TS one — the
 *     byte-check pins the template, the behavioral probe pins the semantics.
 */
import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOP_CORE_PATTERNS, isLoopCorePath } from "../../src/shared/index.js";
import {
  LOOP_CORE_PATTERNS as GENERATED,
  isLoopCorePath as generatedIsLoopCorePath,
} from "../../.claude/hooks/loop-core-patterns.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, "..", "..");

const HOOKS = [".claude/hooks/pre-commit-gate.mjs", ".claude/hooks/attest-loop-core-review.mjs"];

test("the generated hook module equals the single-sourced LOOP_CORE_PATTERNS, in order", () => {
  expect(GENERATED).toEqual([...LOOP_CORE_PATTERNS]);
});

test.each(HOOKS)("%s imports the generated predicate and declares no copy of its own", async (hookRelPath) => {
  const src = await readFile(join(repoRoot, hookRelPath), "utf8");

  expect(
    src,
    `${hookRelPath} must import isLoopCorePath from the generated sibling`,
  ).toMatch(/import\s*\{[^}]*\bisLoopCorePath\b[^}]*\}\s*from\s*['"]\.\/loop-core-patterns\.mjs['"]/);

  // A re-grown local declaration would shadow the import and silently restore
  // the three-homes defect — the failure mode this whole mechanism removes.
  expect(
    /(?:const|let|var)\s+LOOP_CORE_PATTERNS\s*=/.test(src),
    `${hookRelPath} must not re-declare LOOP_CORE_PATTERNS — import the generated list instead`,
  ).toBe(false);

  // Same rationale for the PREDICATE: a local `pinsLoopCore` (the historical
  // shadow copy) or a re-declared `isLoopCorePath` forks the matching semantics
  // out from under the byte-equality check.
  expect(
    /(?:function|const|let|var)\s+(?:pinsLoopCore|isLoopCorePath)\s*[(=]/.test(src),
    `${hookRelPath} must not declare a local loop-core predicate — import isLoopCorePath instead`,
  ).toBe(false);
});

// (The tracked-render byte-parity assertion that lived here was F8's named
// redundancy: check:loop-core-patterns asserts the same bytes at commit and in
// verify:checks, so the test duplicated the gate it was titled after.)

test("the generated predicate agrees with the TS isLoopCorePath over a derived probe corpus", () => {
  // Derived mechanically from the pattern list itself (plus a handful of fixed
  // negatives), so the corpus cannot rot when the list changes. Covers: each
  // pattern verbatim, children + nested children under every "/" pattern, the
  // prefix-sibling near miss, exact-match near misses, win32 backslashes, and
  // a leading "./".
  const probes: string[] = [];
  for (const pattern of LOOP_CORE_PATTERNS) {
    probes.push(pattern);
    if (pattern.endsWith("/")) {
      probes.push(pattern + "child.ts");
      probes.push(pattern + "nested/deeper.ts");
      // Shares the directory name as a string prefix but is NOT under the dir.
      probes.push(pattern.slice(0, -1) + "Sibling.ts");
    } else {
      probes.push(pattern + ".bak");
    }
    probes.push(pattern.replace(/\//g, "\\"));
    probes.push("./" + pattern);
  }
  probes.push(
    "src/remediate/steps/nextStepHelpers.ts", // real-tree prefix sibling of steps/nextStep.ts
    "src/shared/io/jsonIo.ts",
    "docs/backlog.md",
    "tests/shared/loop-core-paths.test.ts",
    "",
  );

  for (const p of probes) {
    expect(
      generatedIsLoopCorePath(p),
      `generated predicate disagrees with the TS source for ${JSON.stringify(p)}`,
    ).toBe(isLoopCorePath(p));
  }

  // The corpus must exercise BOTH verdicts, or agreement proves nothing.
  expect(probes.some((p) => isLoopCorePath(p))).toBe(true);
  expect(probes.some((p) => !isLoopCorePath(p))).toBe(true);
});
