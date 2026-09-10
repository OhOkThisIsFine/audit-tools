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

// ── the declared CLAIM vocabulary ────────────────────────────────────────────
//
// WHY THIS EXISTS (backlog 2026-08-30). The 25 rows the gate landed with record
// what the tree MEASURED the night the gate landed, not a judgement that each
// module is correctly outside the set. Their `reason` strings are prose: the
// gate could not read them, so a row stayed green after the shape it described
// had changed underneath it. The property the entry states is that a declared
// exclusion says WHY the module is not core, and that the reason has been
// CHECKED rather than inherited from the measurement.
//
// So the reason becomes a CLAIM drawn from a closed vocabulary, and each claim
// is mechanically re-derived from the module's own source and its in-src
// transitive import closure. A row whose claim no longer holds is an error.
//
// The claims are about CAPABILITY, not about style. What makes a module a leaf
// body rather than part of the boundary is whether it can reach a filesystem
// write at all, and whether it decides WHERE a write lands:
//
//   'pure'       neither the module nor anything it reaches imports a node I/O
//                builtin. It cannot touch the filesystem even indirectly.
//   'reads-only' I/O is reachable, but the module's own source performs no
//                mutating filesystem call. It can observe, never change.
//   'mutates'    the module's own source performs a mutating filesystem call,
//                so its reason must go on to say what it writes and who owns
//                that location — the boundary itself, or its caller.
//
// These are capability facts, chosen because they are the ones that can change
// SILENTLY and invalidate the classification: a module that gains a write is no
// longer the leaf body its row describes, and nothing else in the tree would
// notice. They are deliberately exhaustive and heuristic-free — no attempt is
// made to judge WHERE a mutating call writes from its source text, because that
// judgement is not mechanical and a guess dressed as a check is worse than a
// stated gap. The four 'mutates' rows therefore carry the location argument in
// their `reason`, and that half is prose.
//
// The classification is a MEASUREMENT of today's tree, exactly as the original
// 25 rows were. What changed is that it is now re-measured on every run: a row
// cannot silently become false.

/** Node builtins that let a module touch the filesystem or spawn a child. */
const IO_BUILTINS = /^node:(fs|fs\/promises|child_process)$/;

/** A mutating filesystem call — the verbs that change state on disk. */
const MUTATING_CALL =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|chmod|chmodSync|symlink|symlinkSync|truncate|truncateSync)\s*\(/;

/** The claim names, in strength order — for validation and for error text. */
export const CLOSURE_CLAIMS = ['pure', 'reads-only', 'mutates'];

/** Every module specifier of one source file, both forms. */
function specifiersOf(text) {
  const out = [];
  for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) out.push({ kind: 'relative', spec: m[1] });
  for (const m of text.matchAll(/from\s+["'](audit-tools\/shared(?:\/[^"']+)?)["']/g)) {
    out.push({ kind: 'package', spec: m[1] });
  }
  return out;
}

/** Resolve one specifier to a repo-relative module path that is in `known`, or null. */
function resolveSpecifier(root, from, spec) {
  const base = spec.startsWith('audit-tools/shared')
    ? `src/shared/${spec.slice('audit-tools/shared'.length).replace(/^\//, '')}`
    : null;
  const raw = base !== null ? base : spec;
  const abs = base !== null ? join(root, raw) : resolve(dirname(join(root, from)), raw);
  const trimmed = abs.replace(/\.js$/, '').replace(/\.mjs$/, '');
  for (const candidate of [`${trimmed}.ts`, `${trimmed}/index.ts`]) {
    if (candidate.replace(/\\/g, '/').startsWith(root.replace(/\\/g, '/'))) {
      const r = rel(root, candidate);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Re-derive each declared claim from the tree.
 *
 * @param {string} root
 * @param {Map<string, string>} declared module -> claim
 * @returns {{module: string, claim: string, actual: string|null, detail: string}[]}
 *   rows whose declared claim the source does not support (or whose claim is
 *   not a known one), each naming what the source actually shows.
 */
export function checkDeclaredClaims(root, declared) {
  const modules = collectSourceModules(root);
  const known = new Set(modules);
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  for (const module of modules) {
    const text = readFileSync(join(root, module), 'utf8');
    const targets = [];
    for (const { spec } of specifiersOf(text)) {
      const target = resolveSpecifier(root, module, spec);
      if (target && target !== module && known.has(target)) targets.push(target);
    }
    edges.set(module, targets);
  }

  /** The in-src transitive closure of one module — itself included. */
  const closureOf = (module) => {
    const seen = new Set();
    const stack = [module];
    while (stack.length) {
      const m = /** @type {string} */ (stack.pop());
      if (seen.has(m)) continue;
      seen.add(m);
      for (const t of edges.get(m) ?? []) if (!seen.has(t)) stack.push(t);
    }
    return [...seen];
  };

  const failures = [];
  for (const [module, claim] of declared) {
    if (!known.has(module)) continue; // absence is the closure gate's own report
    let text;
    try {
      text = readFileSync(join(root, module), 'utf8');
    } catch {
      continue; // unreadable is reported elsewhere; do not manufacture a second verdict
    }
    if (!CLOSURE_CLAIMS.includes(claim)) {
      failures.push({
        module,
        claim,
        actual: null,
        detail: `"${claim}" is not a known claim — expected one of ${CLOSURE_CLAIMS.join(', ')}`,
      });
      continue;
    }
    const closure = closureOf(module);
    const ioModules = closure.filter((m) => {
      const t = readFileSync(join(root, m), 'utf8');
      return [...t.matchAll(/from\s+["'](node:[^"']+)["']/g)].some((x) => IO_BUILTINS.test(x[1]));
    });
    const mutates = MUTATING_CALL.test(text);

    if (claim === 'pure' && ioModules.length > 0) {
      failures.push({
        module,
        claim,
        actual: 'reads-only',
        detail: `declared 'pure' but node I/O is reachable through ${ioModules.join(', ')}`,
      });
    } else if (claim === 'reads-only' && mutates) {
      failures.push({
        module,
        claim,
        actual: 'mutates',
        detail: "declared 'reads-only' but the module's own source performs a mutating filesystem call",
      });
    } else if (claim === 'mutates' && !mutates) {
      // The other direction: the row's reason argues about what it writes, and
      // the write is gone — the argument now describes a module that no longer
      // exists, which is how a data list rots into prose.
      failures.push({
        module,
        claim,
        actual: 'reads-only',
        detail:
          "declared 'mutates' but the module's own source performs no mutating filesystem call — " +
          'its reason argues about a write that is no longer there',
      });
    }
  }
  return failures;
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
