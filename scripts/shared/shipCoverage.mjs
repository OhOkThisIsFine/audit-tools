// The shipped-import closure: every file a shipped file REACHES by relative
// import must itself be shipped.
//
// WHY THIS EXISTS. `package.json`'s `files` list names the shipped scripts one
// by one, and nothing connected it to the import graph those scripts form. On
// 2026-09-10 the wrapper build started importing `scripts/shared/primitives.mjs`
// (85255cc5) and the packed package did not carry it: every local gate stayed
// green, `verify:checks` stayed green, and the defect surfaced as
// `smoke:packaged-audit-code` dying on ERR_MODULE_NOT_FOUND inside a temp
// install — a package defect read as a smoke flake. The one-file fix (8f411d11)
// added the entry by hand; this module is the mechanism that makes the next one
// impossible, because a by-hand list is a list a human must remember to extend.
//
// THE SHAPE. The roots are DERIVED, not hand-kept: every shipped file that is a
// `.mjs`/`.js` module is a root, so "a shipped file imports something unshipped"
// is the whole predicate — the entry-point list the defect was reported against
// (root bins, `wrapper/**`, `dispatch/**`, the postinstall scripts, the two
// shared install modules) is a subset of it, and a root added to `files`
// tomorrow is covered without editing anything here.
//
// The resolution is over the FILESYSTEM, not over git: `npm pack` ships what
// matches `files` and is not ignored, so a reachable file present on disk but
// absent from `files` is exactly the defect, whether or not it is tracked.
//
// UNCOVERED, stated as data: a specifier that is not a string literal cannot be
// read (`ts.preProcessFile` sees literal imports only), a bare specifier is
// never followed (it is either an external package or `audit-tools/shared`,
// which resolves into `dist/**` and is covered as a directory), and a relative
// specifier that resolves to NO file on disk is skipped rather than reported —
// that is a broken import, which the packaged smokes catch directly, not a
// coverage hole. `tests/shared/shipped-import-closure.test.ts` is the guard.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

import { globToRegExp, isGlob } from '../check-doc-manifest.mjs';

/** Extensions a relative specifier may resolve to, in try order. */
const RESOLVE_SUFFIXES = ['.mjs', '.js', '.cjs', '.json'];
/** Index forms tried after the bare candidate, in try order. */
const INDEX_SUFFIXES = ['/index.mjs', '/index.js'];

/** Module files a ship-coverage root may be: only these are walked AS roots. */
const MODULE_RE = /\.(mjs|js|cjs)$/;

const norm = (/** @type {string} */ p) => p.replace(/\\/g, '/');

/**
 * The matcher for one `files` pattern: a glob through the repo's single glob
 * grammar (`check-doc-manifest.mjs`, the same one the reach registry and the
 * doc manifest use), a literal otherwise.
 * @param {string} pattern
 */
function matcherFor(pattern) {
  const normalized = norm(pattern).replace(/\/+$/, '');
  return isGlob(normalized)
    ? globToRegExp(normalized)
    : { test: (/** @type {string} */ file) => file === normalized };
}

/**
 * Is `relPath` (repo-relative, forward slashes) covered by the `files` patterns?
 * @param {string[]} files
 * @param {string} relPath
 */
export function isShipped(files, relPath) {
  return files.some((pattern) => matcherFor(pattern).test(relPath));
}

/**
 * Resolve one relative specifier from `importer` (repo-relative) against the
 * filesystem under `repoRoot`. Returns the repo-relative target, or null when
 * nothing exists there (which is a broken import, not a coverage hole).
 * @param {string} spec
 * @param {string} importer
 * @param {string} repoRoot
 */
export function resolveRelativeSpec(spec, importer, repoRoot) {
  const base = norm(join(dirname(importer), spec));
  const candidates = [base];
  for (const suffix of RESOLVE_SUFFIXES) candidates.push(base + suffix);
  for (const suffix of INDEX_SUFFIXES) candidates.push(base + suffix);
  for (const candidate of candidates) {
    // A directory candidate (e.g. `./dispatch`) is not a module; only a file is.
    if (existsSync(join(repoRoot, candidate)) && statSync(join(repoRoot, candidate)).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * The literal relative-import edges of one source file, as repo-relative paths.
 * @param {string} repoRoot
 * @param {string} relPath
 * @returns {string[]}
 */
export function relativeEdges(repoRoot, relPath) {
  let text;
  try {
    text = readFileSync(join(repoRoot, relPath), 'utf8');
  } catch {
    return [];
  }
  const pre = ts.preProcessFile(text, true, true);
  const specs = [
    ...pre.importedFiles.map((f) => f.fileName),
    ...pre.referencedFiles.map((f) => f.fileName),
    ...pre.libReferenceDirectives.map((f) => f.fileName),
  ];
  const edges = new Set();
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue; // bare/absolute: external or a package subpath
    const target = resolveRelativeSpec(spec, relPath, repoRoot);
    if (target !== null && target !== relPath) edges.add(target);
  }
  return [...edges].sort();
}

/**
 * Every SHIPPED module file present on disk — the walk's roots, derived from
 * `files` rather than hand-listed (a hand-kept root list is the thing that
 * drifts; see this module's header).
 * @param {string} repoRoot
 * @param {string[]} files
 */
function shippedModuleRoots(repoRoot, files) {
  /** Every shipped module file under a directory root. */
  const walk = (/** @type {string} */ dir) => {
    /** @type {string[]} */
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else {
        const rel = norm(relative(repoRoot, full));
        if (MODULE_RE.test(rel) && isShipped(files, rel)) found.push(rel);
      }
    }
    return found;
  };
  const roots = new Set();
  for (const pattern of files) {
    // The literal prefix before the first glob char: `wrapper/**` -> `wrapper`,
    // `dist/**` -> `dist`, `audit-code.mjs` -> itself. A pattern with no literal
    // prefix at all (`**/*.md`) names no root.
    const literal = norm(pattern).split(/[*?]/u)[0].replace(/\/+$/, '');
    if (literal.length === 0) continue;
    const target = join(repoRoot, literal);
    if (!existsSync(target)) continue;
    if (statSync(target).isDirectory()) {
      // A directory pattern (`wrapper/**`, `dispatch/**`, `scripts/shared/**`)
      // contributes every shipped module under it — this is what keeps the walk
      // derived: a script added to a shipped directory is walked unedited.
      for (const file of walk(target)) roots.add(file);
    } else if (MODULE_RE.test(literal)) {
      roots.add(literal);
    }
  }
  return [...roots].sort();
}

/**
 * Walk the relative-import closure from every shipped module root and report
 * every reachable file `files` does not cover.
 *
 * @param {{repoRoot: string, files: string[]}} options
 * @returns {{roots: string[], reachable: string[], unshipped: {file: string, importedFrom: string[]}[]}}
 */
export function shipCoverage({ repoRoot, files }) {
  const root = resolve(repoRoot);
  const roots = shippedModuleRoots(root, files);
  const reachable = new Set(roots);
  /** @type {Map<string, Set<string>>} target -> importers that reached it */
  const importers = new Map();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const target of relativeEdges(root, file)) {
      const reachedFrom = importers.get(target) ?? new Set();
      reachedFrom.add(file);
      importers.set(target, reachedFrom);
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  const unshipped = [...reachable]
    .filter((file) => !isShipped(files, file))
    .sort()
    .map((file) => ({ file, importedFrom: [...(importers.get(file) ?? [])].sort() }));

  return { roots, reachable: [...reachable].sort(), unshipped };
}
