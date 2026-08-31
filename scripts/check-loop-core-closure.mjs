#!/usr/bin/env node
// Gate: the loop-core set's reach is a property of the module graph.
//
// A module whose EVERY importer is loop-core is reachable only through
// loop-core, so it belongs in `LOOP_CORE_PATTERNS` — or it states, as data with
// a reason, why it does not. The rule and its history live in
// `scripts/shared/loopCoreClosure.mjs`; today's declared set lives in
// `scripts/shared/loopCoreClosureData.mjs`.
//
//   npm run check:loop-core-closure
//
// Plain node, no build step: it reads the GENERATED predicate the two pre-build
// hooks read, so the gate and the hooks can never disagree about membership.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImporterGraph,
  collectSourceModules,
  evaluateClosure,
} from "./shared/loopCoreClosure.mjs";
import { declaredExclusions } from "./shared/loopCoreClosureData.mjs";
import { isLoopCorePath } from "../.claude/hooks/loop-core-patterns.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const modules = collectSourceModules(repoRoot);
const importers = buildImporterGraph(repoRoot, modules);
const { undeclared, staleDeclarations } = evaluateClosure({
  modules,
  importers,
  isLoopCorePath,
  declared: declaredExclusions(),
});

let failed = false;

if (undeclared.length > 0) {
  failed = true;
  console.error(
    `loop-core closure: ${undeclared.length} module(s) are reachable ONLY through loop-core but are ` +
      `neither in the set nor declared:`,
  );
  for (const { module, importers: consumers } of undeclared) {
    console.error(`  - ${module}\n      imported only by: ${consumers.join(", ")}`);
  }
  console.error(
    `\nA symbol that moves out of a loop-core file must not leave attestation coverage silently — ` +
      `that is the defect this gate exists for.\nFix, choosing deliberately:\n` +
      `  • the module IS core   → add it to LOOP_CORE_PATTERNS in src/shared/loopCorePaths.ts, then ` +
      `run \`node scripts/shared/generate-loop-core-patterns.mjs\`\n` +
      `  • the module is NOT    → add a row with its reason to ` +
      `scripts/shared/loopCoreClosureData.mjs`,
  );
}

if (staleDeclarations.length > 0) {
  failed = true;
  console.error(
    `\nloop-core closure: ${staleDeclarations.length} declared exclusion(s) no longer describe the ` +
      `tree — the module is now in the loop-core set, or it gained a consumer outside it:`,
  );
  for (const module of staleDeclarations) console.error(`  - ${module}`);
  console.error(
    `\nDelete the stale row(s) from scripts/shared/loopCoreClosureData.mjs. A declaration that ` +
      `outlives its condition is how a data list rots into prose.`,
  );
}

if (failed) process.exit(1);

console.log(
  `loop-core closure: ${modules.length} module(s) scanned; every module reachable only through ` +
    `loop-core is either in the set or declared (${declaredExclusions().size} declared).`,
);
