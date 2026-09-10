#!/usr/bin/env node
// Orphan-module gate: every src/**/*.ts file must be REACHABLE from a
// production root through literal import edges.
//
// WHY THIS EXISTS. The orphan-module class refilled after being emptied:
// 5,300 lines were deleted from it once, no mechanism was added, and the
// ceremony review (2026-08-29, CY-01) found 1,515 more in the same shape —
// modules whose only consumers are themselves and their own tests. knip
// cannot see the class: its vitest plugin makes test files entries, so a
// module imported only by its own test counts as used for the `files`
// report, and the exports report already gated everything symbol-level.
// This leg closes the FILE level with production-only roots.
//
// Roots: the package entries (src/audit/index.ts, src/remediate/index.ts,
// src/shared/index.ts — the `audit-tools/shared` subpath), plus every src
// file that a shipped .mjs tree (scripts/, wrapper/, dispatch/, the root
// bins, .claude/hooks/) references through its compiled dist/<path>.js twin.
//
// UNCOVERED, stated as data: an import whose specifier is not a string
// literal cannot be resolved. Today both such sites in src load EXTERNAL
// packages (src/audit/extractors/analyzers/treeSitter.ts, .../typescript.ts).
// A new non-literal import of an in-repo module needs an ORPHAN_ALLOW row
// here, with the reason.
//
// ── the RELATIVE-IMPORT pass (Track 2.5, forward-tracks) ──────────────────────
//
// The reachability walk above is FILE-level and counts a re-export edge as
// consumption. That leaves the class the slimdown review named: a production
// module whose only production importers are BARRELS that nobody in production
// consumes — the module's whole production story is a re-export chain ending in
// nothing, and its only real reader is its own test. knip cannot see it either
// (its vitest plugin makes test files entries).
//
// So the second pass asks the SYMBOL question, over the TypeScript program:
// for a src module that is not a package entry, take the exports it DECLARES
// itself, and ask whether any of those names is referenced by any OTHER
// production src file — an import specifier, a re-export specifier, or a
// qualified use, all count, through any depth of barrel. A module that declares
// exports, is reached by the tests, and has none of them referenced from
// production is production-dead by construction.
//
// WHY THE TYPE CHECKER AND NOT A NAME SCAN. `export { x } from "./y.js"` makes
// the NAME flow, and only the checker follows it through every aliasing and
// barrel form. A textual scan over-approximates (it cannot tell a re-export
// specifier from a use) and under-approximates (an aliased import renames the
// symbol); measured against this tree it reported 40 candidates where the
// checker reports 1. A leads list of 40 false positives is a gate nobody reads.
//
// COST: ~4-5s, because the program must bind symbols over all of src/. The
// identifier walk is pre-filtered to names that are actually exported somewhere,
// which is what keeps it off a full type-check budget; a file-level prefilter is
// NOT used because a single file can mention any exported name.
//
//   node scripts/check-orphan-modules.mjs        # verify (exit 1 on orphans)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files reachability may not flag, each with its reason. */
const ORPHAN_ALLOW = new Map([
  // A row here is a file kept alive by a wiring the resolver cannot see,
  // never a parked deletion.
  [
    "src/shared/constitutionalDocPaths.ts",
    "canonical source the generator reads TEXTUALLY (scripts/shared/generate-constitutional-doc-paths.mjs " +
      "regex-extracts the array — no import edge); parity is enforced by check:constitutional-doc-paths",
  ],
]);

/**
 * The package entries. A module here is the PUBLISHED SURFACE: its exports are
 * addressed by consumers outside this repository (the `audit-tools/shared`
 * subpath), so "no src file references this name" is the normal, correct state
 * for most of what they re-export — the relative-import pass must not claim
 * them, and neither may it flag a module merely because its only production
 * importer is an entry.
 */
const PRODUCTION_ENTRIES = new Set([
  "src/audit/index.ts",
  "src/remediate/index.ts",
  "src/shared/index.ts",
]);

const norm = (/** @type {string} */ p) => p.replace(/\\/g, "/");

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  return out.split("\0").filter(Boolean).map(norm);
}

/** Resolve one import specifier from `importer` to a tracked repo file, or null. */
function resolveSpec(spec, importer, tracked) {
  let candidate = null;
  if (spec.startsWith(".")) {
    candidate = norm(join(dirname(importer), spec));
  } else if (spec === "audit-tools/shared") {
    candidate = "src/shared/index.ts";
  } else if (spec.startsWith("audit-tools/shared/")) {
    candidate = "src/shared/" + spec.slice("audit-tools/shared/".length);
  } else {
    return null; // external package
  }
  const tries = [];
  if (candidate.endsWith(".js")) tries.push(candidate.slice(0, -3) + ".ts");
  else if (candidate.endsWith(".mjs") || candidate.endsWith(".ts")) tries.push(candidate);
  else tries.push(candidate + ".ts", candidate + "/index.ts");
  for (const t of tries) if (tracked.has(t)) return t;
  return null;
}

/** Literal import edges of one TS/JS source file. */
function importEdges(file, tracked) {
  const text = readFileSync(join(repoRoot, file), "utf8");
  const pre = ts.preProcessFile(text, true, true);
  const specs = pre.importedFiles.map((f) => f.fileName);
  const edges = new Set();
  for (const spec of specs) {
    const target = resolveSpec(spec, file, tracked);
    if (target && target !== file) edges.add(target);
  }
  return edges;
}

/**
 * The relative-import pass: production modules whose DECLARED exports are
 * referenced by no other production src file, but which the tests reach.
 *
 * Reads the tree through a real TypeScript program — the symbol flow is what
 * the pass is FOR, and no cheaper reading follows `export { x } from "./y.js"`
 * through aliasing and barrel depth. `root` defaults to this repo, so the
 * contract test can drive it over a fixture tree on disk.
 *
 * @param {{
 *   root?: string,
 *   prodFiles: string[],
 *   testFiles: string[],
 *   trackedFiles?: Set<string>,
 * }} input `testFiles` are the test SOURCE paths; a module counts as
 *   test-reached when one of them imports it. `trackedFiles` resolves their
 *   specifiers and defaults to the union of both lists.
 * @returns {string[]} repo-relative production-dead module paths, sorted
 */
export function relativeImportOrphans({
  root = repoRoot,
  prodFiles,
  testFiles,
  trackedFiles = new Set([...prodFiles, ...testFiles]),
}) {
  const prodSet = new Set(prodFiles);

  // The modules the TESTS reach. Without this the pass would claim modules no
  // one imports at all — the orphan class the file-level walk and knip own.
  const testReached = new Set();
  for (const test of testFiles) {
    const text = readFileSync(join(root, test), "utf8");
    for (const spec of ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName)) {
      const target = resolveSpec(spec, test, trackedFiles);
      if (target) testReached.add(target);
    }
  }
  const program = ts.createProgram(prodFiles.map((f) => join(root, f)), {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: false,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    types: [],
    baseUrl: root,
    paths: {
      "audit-tools/shared": ["./src/shared/index.ts"],
      "audit-tools/shared/*": ["./src/shared/*.ts"],
    },
  });
  const checker = program.getTypeChecker();
  const prefix = norm(root).replace(/\/$/, "") + "/";
  const rel = (f) => norm(f).replace(prefix, "");
  const deref = (s) => {
    try {
      return s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    } catch {
      return s;
    }
  };
  /** The module that DECLARES a symbol — `undefined` for anything unresolvable. */
  const homeOf = (s) => {
    const d = s?.declarations?.[0];
    return d ? rel(d.getSourceFile().fileName) : undefined;
  };

  // Every name exported anywhere, so the identifier walk resolves only what
  // could possibly matter (~34k of 231k identifiers on this tree).
  const candidateNames = new Set();
  for (const sf of program.getSourceFiles()) {
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) continue;
    for (const e of checker.getExportsOfModule(mod)) candidateNames.add(e.getName());
  }

  /** module -> the set of names referenced from OTHER production modules. */
  const referencedFromProd = new Map();
  for (const sf of program.getSourceFiles()) {
    const from = rel(sf.fileName);
    if (!prodSet.has(from)) continue;
    const visit = (node) => {
      if (ts.isIdentifier(node) && candidateNames.has(node.text)) {
        const sym = deref(checker.getSymbolAtLocation(node));
        const home = homeOf(sym);
        if (home !== undefined && prodSet.has(home) && home !== from) {
          if (!referencedFromProd.has(home)) referencedFromProd.set(home, new Set());
          referencedFromProd.get(home).add(sym.getName());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const flagged = [];
  for (const sf of program.getSourceFiles()) {
    const module = rel(sf.fileName);
    if (!prodSet.has(module) || PRODUCTION_ENTRIES.has(module)) continue;
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) continue;
    // Only exports this module DECLARES. A pure re-export barrel declares
    // nothing, and is a routing node rather than a production-dead module.
    const localNames = checker
      .getExportsOfModule(mod)
      .map(deref)
      .filter((s) => homeOf(s) === module)
      .map((s) => s.getName());
    if (localNames.length === 0) continue;
    // The tests are what is keeping it apparently alive — without that, the
    // file-level pass above or knip already owns the case.
    if (!testReached.has(module)) continue;
    const used = referencedFromProd.get(module) ?? new Set();
    if (localNames.some((n) => used.has(n))) continue;
    if (ORPHAN_ALLOW.has(module)) continue;
    flagged.push(module);
  }
  return flagged.sort();
}

function main() {
  const tracked = new Set(trackedFiles());
  const prodFiles = [...tracked].filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  const mjsTrees = [...tracked].filter(
    (f) =>
      f.endsWith(".mjs") &&
      (f.startsWith("scripts/") ||
        f.startsWith("wrapper/") ||
        f.startsWith("dispatch/") ||
        f.startsWith(".claude/hooks/") ||
        !f.includes("/")),
  );

  const roots = new Set(
    ["src/audit/index.ts", "src/remediate/index.ts", "src/shared/index.ts"].filter((f) => tracked.has(f)),
  );
  // A src file whose compiled dist twin a shipped .mjs references is a runtime root.
  for (const mjs of mjsTrees) {
    const text = readFileSync(join(repoRoot, mjs), "utf8");
    for (const m of text.matchAll(/dist\/([A-Za-z0-9_\-./]+)\.js/g)) {
      const twin = `src/${m[1]}.ts`;
      if (tracked.has(twin)) roots.add(twin);
    }
  }

  const edgesOf = new Map(prodFiles.map((f) => [f, importEdges(f, tracked)]));
  const reachable = new Set(roots);
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const target of edgesOf.get(file) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  // Name the test-side importers too, so the deletion sweeps its orphaned tests.
  const testFiles = new Set(
    [...tracked].filter((f) => f.startsWith("tests/") && (f.endsWith(".ts") || f.endsWith(".mjs"))),
  );

  const orphans = prodFiles.filter((f) => !reachable.has(f) && !ORPHAN_ALLOW.has(f));
  const symbolOrphans = relativeImportOrphans({
    prodFiles,
    testFiles: [...testFiles],
    trackedFiles: tracked,
  });

  if (orphans.length === 0 && symbolOrphans.length === 0) {
    process.stdout.write(
      `✓ orphan-modules: every src module is production-reachable (${prodFiles.length} files), and ` +
        `every module the tests reach is referenced from production by NAME\n`,
    );
    return;
  }

  if (symbolOrphans.length > 0) {
    process.stderr.write(
      `\n✗ relative-import orphan(s): src module(s) whose own exports are referenced by NO other ` +
        `production module — every production import edge into them is a re-export chain nothing in ` +
        `production consumes, and their only real reader is their own test (Track 2.5).\n` +
        `Delete the module AND its orphaned tests in one commit, or wire the intended consumer; ` +
        `a module kept alive by wiring this resolver cannot see gets an ORPHAN_ALLOW row with the reason.\n\n` +
        symbolOrphans.map((f) => `  - ${f}`).join("\n") +
        `\n`,
    );
  }

  if (orphans.length === 0) {
    process.exit(1);
  }

  /** @type {Map<string, string[]>} */
  const testImporters = new Map(orphans.map((f) => [f, []]));
  for (const test of testFiles) {
    for (const target of importEdges(test, tracked)) {
      testImporters.get(target)?.push(test);
    }
  }

  process.stderr.write(
    `\n✗ orphan module(s): src file(s) no production root reaches — dead by construction.\n` +
      `Delete the module AND its orphaned tests in one commit, or wire the intended consumer;\n` +
      `a file kept alive by wiring this resolver cannot see gets an ORPHAN_ALLOW row with the reason.\n\n` +
      orphans
        .map((f) => {
          const tests = testImporters.get(f) ?? [];
          return `  - ${f}${tests.length ? `\n      test-only importers: ${tests.join(", ")}` : ""}`;
        })
        .join("\n") +
      `\n`,
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
