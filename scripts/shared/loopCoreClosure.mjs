// The loop-core set's REACH, as a property of the code rather than of whoever
// last refactored it.
//
// WHY THIS EXISTS. `LOOP_CORE_PATTERNS` is a hand-maintained path list, and a
// symbol that MOVES out of a loop-core file into a new module leaves attestation
// coverage silently. That happened: `quarantineSubmissionFile` moved out of
// `src/audit/cli/nextStepHelpers.ts` (loop-core, then and now) into the new
// `src/audit/cli/foldTransaction.ts` at `b4a3eb4a`, taking the fold's one core
// write boundary with it. Nothing noticed for months.
//
// The FIRST design against this class was a staged-diff check — refuse a commit
// that removes an exported symbol from a loop-core file and adds that name to a
// non-loop-core one. An independent refutation killed it: `commitFold` was a
// BRAND NEW symbol in that same commit, not a moved one, so the diff check would
// not have covered `foldTransaction.ts` at all; a rename during the move escapes
// it too; and PH-05 forbids a gate that guesses at a boundary owned by something
// else — membership is a property of the module graph, not of patch text.
//
// The rule here is the graph property instead: a module whose EVERY importer is
// loop-core is reachable only through loop-core, so it is loop-core. It would
// have caught `foldTransaction.ts` on the commit that created it — that file has
// exactly one importer, `nextStepHelpers.ts` — by construction rather than by
// anyone noticing. A module that is legitimately not core states so as DATA
// (`loopCoreClosureData.mjs`), with a reason, and a declaration that stops being
// true is itself an error: the list cannot rot quietly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Repo-relative, forward-slashed. The whole module speaks this one form. */
function rel(root, file) {
  return relative(root, file).split("\\").join("/");
}

/**
 * Every `.ts` module under `src/`, repo-relative. Declaration files are
 * excluded: they carry no runtime reachability.
 * @param {string} root
 * @returns {string[]} sorted, so the output order is content-derived
 */
export function collectSourceModules(root) {
  const src = join(root, "src");
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(rel(root, full));
    }
  };
  walk(src);
  return found;
}

/**
 * Who imports whom, over RELATIVE specifiers only. A package-subpath import
 * (`audit-tools/shared/...`) is deliberately not resolved: it names the public
 * surface, and a module reachable through the package export is by definition
 * not reachable only through loop-core.
 *
 * @param {string} root
 * @param {string[]} modules repo-relative module paths
 * @returns {Map<string, Set<string>>} target -> importers
 */
export function buildImporterGraph(root, modules) {
  const known = new Set(modules);
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  for (const module of modules) {
    const text = readFileSync(join(root, module), "utf8");
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      // Emitted ESM imports carry the `.js` extension the `.ts` source compiles to.
      const spec = match[1].replace(/\.js$/, ".ts");
      const resolved = resolve(dirname(join(root, module)), spec);
      const target = rel(root, resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
      if (!known.has(target)) continue;
      const existing = importers.get(target);
      if (existing) existing.add(module);
      else importers.set(target, new Set([module]));
    }
  }
  return importers;
}

/**
 * The closure verdict. Two failures, and the second is what stops the declared
 * list from rotting: a declaration whose condition no longer holds is an error,
 * so the data cannot quietly outlive the shape it describes.
 *
 * @param {{
 *   modules: string[],
 *   importers: Map<string, Set<string>>,
 *   isLoopCorePath: (path: string) => boolean,
 *   declared: Map<string, string>,
 * }} input
 * @returns {{ undeclared: {module: string, importers: string[]}[], staleDeclarations: string[] }}
 */
export function evaluateClosure({ modules, importers, isLoopCorePath, declared }) {
  const reachedOnlyByCore = new Set();
  for (const module of modules) {
    if (isLoopCorePath(module)) continue;
    const consumers = importers.get(module);
    // No importer at all is the ORPHAN class, which `check:orphan-modules`
    // owns. Claiming it here would put two gates on one property.
    if (!consumers || consumers.size === 0) continue;
    if ([...consumers].every((c) => isLoopCorePath(c))) reachedOnlyByCore.add(module);
  }

  const undeclared = [...reachedOnlyByCore]
    .filter((m) => !declared.has(m))
    .sort()
    .map((module) => ({ module, importers: [...(importers.get(module) ?? [])].sort() }));

  const staleDeclarations = [...declared.keys()]
    .filter((m) => !reachedOnlyByCore.has(m))
    .sort();

  return { undeclared, staleDeclarations };
}
