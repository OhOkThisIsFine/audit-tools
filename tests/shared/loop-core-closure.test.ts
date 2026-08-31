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
import {
  buildImporterGraph,
  collectSourceModules,
  evaluateClosure,
} from "../../scripts/shared/loopCoreClosure.mjs";
import { declaredExclusions } from "../../scripts/shared/loopCoreClosureData.mjs";
import { isLoopCorePath } from "../../src/shared/loopCorePaths.js";

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
  const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const modules = collectSourceModules(root);
  const verdict = evaluateClosure({
    modules,
    importers: buildImporterGraph(root, modules),
    isLoopCorePath,
    declared: declaredExclusions(),
  });

  expect(verdict.undeclared).toEqual([]);
  expect(verdict.staleDeclarations).toEqual([]);
});
