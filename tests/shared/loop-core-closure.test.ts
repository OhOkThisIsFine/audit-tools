/**
 * The loop-core set's reach must be a property of the module graph, not of the
 * refactorer noticing (`docs/backlog/open-bugs.md`).
 *
 * `quarantineSubmissionFile` moved out of `src/audit/cli/nextStepHelpers.ts`
 * (loop-core, then and now) into the new `src/audit/cli/foldTransaction.ts` at
 * `b4a3eb4a`, which took the fold's one core write boundary out of attestation
 * coverage silently. The rule: a module whose EVERY importer is loop-core is
 * reachable only through loop-core, so it is loop-core — or it says, as data
 * with a reason, why it is not.
 *
 * The first case below is the historical escape, reduced to its graph shape.
 */
import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOSURE_CLAIMS,
  buildImporterGraph,
  checkDeclaredClaims,
  collectSourceModules,
  evaluateClosure,
} from "../../scripts/shared/loopCoreClosure.mjs";
import {
  LOOP_CORE_CLOSURE_EXCLUSIONS,
  declaredExclusions,
} from "../../scripts/shared/loopCoreClosureData.mjs";
import { isLoopCorePath } from "../../src/shared/loopCorePaths.js";

const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** A throwaway src/ tree with the given modules, for claim-derivation cases. */
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "loop-core-claims-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const CORE = new Set(["core/step.ts", "core/helpers.ts"]);
const fakeIsCore = (p: string) => CORE.has(p);

function graph(edges: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(edges).map(([target, from]) => [target, new Set(from)]));
}

test("a module imported ONLY by loop-core is reported when it is neither in the set nor declared", () => {
  // The b4a3eb4a shape: a new module, one importer, and that importer is core.
  const verdict = evaluateClosure({
    modules: ["core/step.ts", "core/helpers.ts", "moved/fold.ts"],
    importers: graph({ "moved/fold.ts": ["core/helpers.ts"] }),
    isLoopCorePath: fakeIsCore,
    declared: new Map(),
  });

  expect(verdict.undeclared).toEqual([
    { module: "moved/fold.ts", importers: ["core/helpers.ts"] },
  ]);
});

test("a declared module is accepted, and one consumer outside loop-core is enough to exempt it", () => {
  const declared = evaluateClosure({
    modules: ["core/step.ts", "moved/fold.ts"],
    importers: graph({ "moved/fold.ts": ["core/step.ts"] }),
    isLoopCorePath: fakeIsCore,
    declared: new Map([["moved/fold.ts", "a stated reason"]]),
  });
  expect(declared.undeclared).toEqual([]);

  // A consumer outside the set means the module is not reachable ONLY through
  // loop-core, so the rule does not claim it at all.
  const shared = evaluateClosure({
    modules: ["core/step.ts", "elsewhere/cli.ts", "shared/util.ts"],
    importers: graph({ "shared/util.ts": ["core/step.ts", "elsewhere/cli.ts"] }),
    isLoopCorePath: fakeIsCore,
    declared: new Map(),
  });
  expect(shared.undeclared).toEqual([]);
});

test("a declaration that no longer describes the tree is itself an error", () => {
  // Otherwise the data list rots into prose: rows accumulate that once meant
  // something and now assert nothing.
  const verdict = evaluateClosure({
    modules: ["core/step.ts", "shared/util.ts", "elsewhere/cli.ts"],
    importers: graph({ "shared/util.ts": ["core/step.ts", "elsewhere/cli.ts"] }),
    isLoopCorePath: fakeIsCore,
    declared: new Map([["shared/util.ts", "stale — it has a non-core consumer now"]]),
  });

  expect(verdict.staleDeclarations).toEqual(["shared/util.ts"]);
});

test("an orphan module is left to check:orphan-modules, not claimed here", () => {
  // Two gates on one property is the duplication this repo bans.
  const verdict = evaluateClosure({
    modules: ["core/step.ts", "orphan/nobody.ts"],
    importers: graph({}),
    isLoopCorePath: fakeIsCore,
    declared: new Map(),
  });

  expect(verdict.undeclared).toEqual([]);
});

test("the real tree satisfies the closure rule", () => {
  // The gate script runs this in verify:checks; asserting it here as well keeps
  // the rule red at the same place every other contract test is.
  const modules = collectSourceModules(REPO_ROOT);
  const verdict = evaluateClosure({
    modules,
    importers: buildImporterGraph(REPO_ROOT, modules),
    isLoopCorePath,
    declared: declaredExclusions(),
  });

  expect(verdict.undeclared).toEqual([]);
  expect(verdict.staleDeclarations).toEqual([]);
});

// ── the declared reason is CHECKED, not inherited from the measurement ────────
// The 25 rows the gate landed with (2026-08-30) recorded what the tree MEASURED
// that night; their reason strings were prose the gate could not read, so a row
// stayed green after the shape it described had changed underneath it. Each row
// now carries a claim drawn from a closed vocabulary, re-derived from the
// module's own source and its in-src transitive import closure.

test("a 'pure' row whose module reaches node I/O through an import is refused", () => {
  // Transitive, not just direct: the module itself imports no builtin, and the
  // classification is still false.
  const root = fixtureTree({
    "src/a.ts": 'import { helper } from "./b.js";\nexport const a = () => helper();\n',
    "src/b.ts": 'import { writeFileSync } from "node:fs";\nexport const helper = () => writeFileSync("x", "y");\n',
  });
  try {
    const failures = checkDeclaredClaims(root, new Map([["src/a.ts", "pure"]]));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain("node I/O is reachable");
    expect(failures[0]?.actual).toBe("reads-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 'reads-only' row whose module performs its own write is refused", () => {
  const root = fixtureTree({
    "src/a.ts":
      'import { writeFile } from "node:fs/promises";\nexport const a = () => writeFile("x", "y");\n',
  });
  try {
    const failures = checkDeclaredClaims(root, new Map([["src/a.ts", "reads-only"]]));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain("mutating filesystem call");
    expect(failures[0]?.actual).toBe("mutates");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a 'mutates' row whose write is gone is refused — the argument outlived its subject", () => {
  const root = fixtureTree({
    "src/a.ts": 'import { readFileSync } from "node:fs";\nexport const a = () => readFileSync("x", "utf8");\n',
  });
  try {
    const failures = checkDeclaredClaims(root, new Map([["src/a.ts", "mutates"]]));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain("no mutating filesystem call");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown claim name is refused rather than silently accepted", () => {
  // The vocabulary is closed: a free-text claim would put the prose back.
  const root = fixtureTree({ "src/a.ts": "export const a = 1;\n" });
  try {
    const failures = checkDeclaredClaims(root, new Map([["src/a.ts", "no persisted state"]]));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.detail).toContain("is not a known claim");
    expect(failures[0]?.detail).toContain(CLOSURE_CLAIMS.join(", "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the claims are a partition — every declared row states exactly one, and it re-derives", () => {
  // Asserted against the SHIPPED data, so a row cannot be added with a
  // placeholder claim or a claim nothing checks.
  expect(LOOP_CORE_CLOSURE_EXCLUSIONS.length).toBeGreaterThan(0);
  for (const row of LOOP_CORE_CLOSURE_EXCLUSIONS) {
    expect(CLOSURE_CLAIMS, `${row.module} has claim '${row.claim}'`).toContain(row.claim);
  }
  expect(checkDeclaredClaims(REPO_ROOT, declaredExclusions())).toEqual([]);
});
