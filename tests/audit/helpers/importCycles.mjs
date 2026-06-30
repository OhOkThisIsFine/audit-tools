import { readFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";

// Deterministic, in-process circular-import detector for TypeScript source.
//
// Replaces the former `npx madge --circular` regression guard, which shelled out
// to a package that is not a declared dependency (fetched on demand by npx) — so
// the guard was network/cache-dependent and flaky, and silently passed when madge
// failed to resolve. This walker reads the same import graph madge would, using
// only Node built-ins, and reports cycles deterministically.
//
// Resolution model: the project is NodeNext, so every relative import carries an
// explicit `.js` specifier that maps 1:1 to a sibling `.ts` source file. We
// follow only relative specifiers (./ or ../); bare package specifiers and
// node:/data: imports are external and cannot close an in-repo cycle.

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^\n;]*?from\s*["'](\.[^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g;

function extractRelativeSpecifiers(source) {
  const specs = new Set();
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      specs.add(match[1]);
    }
  }
  return specs;
}

// Map a relative `.js` (or extensionless) specifier to its `.ts` source path.
function resolveSpecifierToTs(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  if (base.endsWith(".ts")) return base;
  if (base.endsWith(".js")) return base.slice(0, -3) + ".ts";
  // Extensionless (rare under NodeNext, but tolerate): assume a sibling `.ts`.
  return base + ".ts";
}

/**
 * Build the directed import graph reachable from `entryFile` and return any
 * circular import chains found. Each cycle is the list of files forming the loop
 * (the cycle closes from the last file back to the first). Returns [] when the
 * source is cycle-free.
 *
 * @param {string} entryFile absolute path to the entry `.ts` file
 * @returns {Promise<string[][]>}
 */
export async function findImportCycles(entryFile) {
  const adjacency = new Map(); // file -> string[] of imported files
  const exists = new Map(); // file -> boolean (resolved + readable)

  async function loadNode(file) {
    if (adjacency.has(file)) return;
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      exists.set(file, false);
      adjacency.set(file, []);
      return;
    }
    exists.set(file, true);
    const edges = [];
    for (const spec of extractRelativeSpecifiers(source)) {
      edges.push(resolveSpecifierToTs(file, spec));
    }
    adjacency.set(file, edges);
    for (const target of edges) {
      await loadNode(target);
    }
  }

  await loadNode(entryFile);

  // White/gray/black DFS: a gray target on the stack is a back-edge → cycle.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seenCycleKeys = new Set();

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      // Only traverse edges to files that actually resolved to source.
      if (exists.get(next) !== true) continue;
      const c = color.get(next) ?? WHITE;
      if (c === WHITE) {
        visit(next);
      } else if (c === GRAY) {
        const idx = stack.indexOf(next);
        if (idx !== -1) {
          const cyc = stack.slice(idx);
          // Canonicalize rotations so the same directed cycle is reported once.
          const key = canonicalCycleKey(cyc);
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push(cyc);
          }
        }
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && exists.get(node) === true) {
      visit(node);
    }
  }
  return cycles;
}

function canonicalCycleKey(cycle) {
  // Rotate so the lexicographically smallest member is first, then join.
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
  return rotated.join(" -> ");
}

/** Render a cycle as repo-relative arrows for assertion messages. */
export function formatCycle(cycle, repoRoot) {
  const rel = cycle.map((f) => relative(repoRoot, f).split(sep).join("/"));
  return [...rel, rel[0]].join(" -> ");
}
