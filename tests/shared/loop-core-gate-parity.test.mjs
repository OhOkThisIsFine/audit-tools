/**
 * loop-core-gate-parity.test.mjs — the loop-core path list has ONE hand-edited
 * home, and every consumer provably sees it.
 *
 * The `.claude` hooks run as PreToolUse under plain node BEFORE any build, so
 * they cannot import `src/shared/loopCorePaths.ts`. They used to re-declare the
 * list, which put it in THREE places; a parity test held the invariant, so
 * nothing landed broken, but the discovery path was "edit two copies, find the
 * third when CI goes red". They now import a GENERATED sibling
 * (`.claude/hooks/loop-core-patterns.mjs`) produced from the TS source.
 *
 * What must hold, and why each half matters:
 *   - the generated module equals the source of truth. If it drifts, the gate
 *     silently runs against a different path set — narrowing it means loop-core
 *     commits stop requiring review attestation, with nothing to notice.
 *   - each hook actually CONSUMES it, rather than having re-grown a local copy
 *     that would shadow the import and re-open the drift by construction.
 */
import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { LOOP_CORE_PATTERNS } = await import("../../src/shared/index.ts");
const { LOOP_CORE_PATTERNS: GENERATED } = await import("../../.claude/hooks/loop-core-patterns.mjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, "..", "..");

const HOOKS = [".claude/hooks/pre-commit-gate.mjs", ".claude/hooks/attest-loop-core-review.mjs"];

test("the generated hook module equals the single-sourced LOOP_CORE_PATTERNS, in order", () => {
  expect(GENERATED).toEqual([...LOOP_CORE_PATTERNS]);
});

test.each(HOOKS)("%s imports the generated list and declares no copy of its own", async (hookRelPath) => {
  const src = await readFile(join(repoRoot, hookRelPath), "utf8");

  expect(
    src,
    `${hookRelPath} must import LOOP_CORE_PATTERNS from the generated sibling`,
  ).toMatch(/import\s*\{\s*LOOP_CORE_PATTERNS\s*\}\s*from\s*['"]\.\/loop-core-patterns\.mjs['"]/);

  // A re-grown local declaration would shadow the import and silently restore
  // the three-homes defect — the failure mode this whole mechanism removes.
  expect(
    /(?:const|let|var)\s+LOOP_CORE_PATTERNS\s*=/.test(src),
    `${hookRelPath} must not re-declare LOOP_CORE_PATTERNS — import the generated list instead`,
  ).toBe(false);
});

test("the generator's --check mode fails when the generated file is stale", async () => {
  // The check is what makes the invariant enforced rather than merely true
  // today, so it must actually be able to FAIL. Verified by feeding the renderer
  // a different list and confirming it does not match what is on disk.
  const { renderModule } = await import("../../scripts/shared/generate-loop-core-patterns.mjs");
  const onDisk = await readFile(join(repoRoot, ".claude", "hooks", "loop-core-patterns.mjs"), "utf8");
  expect(renderModule([...LOOP_CORE_PATTERNS])).toBe(onDisk);
  expect(renderModule(["src/shared/quota/"])).not.toBe(onDisk);
});
