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

  const orphans = prodFiles.filter((f) => !reachable.has(f) && !ORPHAN_ALLOW.has(f));
  if (orphans.length === 0) {
    process.stdout.write(`✓ orphan-modules: every src module is production-reachable (${prodFiles.length} files)\n`);
    return;
  }

  // Name the test-side importers too, so the deletion sweeps its orphaned tests.
  const testFiles = [...tracked].filter(
    (f) => f.startsWith("tests/") && (f.endsWith(".ts") || f.endsWith(".mjs")),
  );
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
