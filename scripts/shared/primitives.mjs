// The governance tree's twin of the shared single-source primitives.
//
// WHY THIS EXISTS (ceremony review 2026-08-29, F1; forward-tracks). The
// repository's own single-source gate — `check:shared-primitives` — scanned
// `git ls-files 'src/**/*.ts'` only, so the enforcement layer was the ONE tree
// exempt from the rule it enforced. Widening its reach (this change) makes the
// governance tree obey the same rules, and these are the primitives it then
// needs.
//
// WHY NOT IMPORT `audit-tools/shared`. The scripts, hooks and wrappers here are
// PRE-BUILD: `tsconfig.scripts.json` typechecks them but nothing compiles them,
// and the pre-commit gate, the write-time advisories and the closeout renderer
// all run in checkouts that may never have been built. Importing
// `audit-tools/shared` resolves `dist/` and dies with ERR_MODULE_NOT_FOUND. So
// these are PORTABLE TWINS of the src homes, not copies of convenience:
//
//   compareCodeUnits  ↔ src/shared/compareCodeUnits.ts
//   hashContent       ↔ src/shared/hash.ts
//   resolveWithinRoot ↔ src/shared/io/pathContainment.ts
//
// The gate's rule tables list BOTH homes, so a re-roll anywhere in either tree
// is red. Change one and change the other — the rules treat them as one home in
// two files, which is what makes the divergence impossible to miss.
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Code-unit lexical comparator — the ONE ordering primitive for every sort
 * whose result is persisted, hashed, or compared across hosts. ICU collation is
 * banned in both trees (see check:shared-primitives' `intl-collator` and
 * `locale-compare` rules for the two spellings): it varies with the host
 * locale, so a persisted array ordered by it hashes differently per machine —
 * the phantom-staleness class. The banned names are not repeated here because
 * this file is itself inside the scan.
 */
export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Compute a hex digest of `content` (a string or raw bytes). Returns the full
 * digest by default, or the leading `length` characters when `length` is given
 * — callers that want a truncated digest pass it EXPLICITLY, so no call site
 * carries a bare `.slice(0, N)` literal on a hash result.
 *
 * `options.algorithm` defaults to sha256. It exists for the ids whose values are
 * ALREADY PERSISTED: the nightly `subject_key` and scope-ledger `item_hash` are
 * sha1 and are written into a tracked artifact, so "upgrade the algorithm" is a
 * rewrite of every id in that file, not a cleanup. Naming the algorithm here
 * routes those sites through the one home without churning persisted state.
 */
export function hashContent(content, options = {}) {
  const { algorithm = "sha256" } = options;
  const digest =
    typeof content === "string"
      ? createHash(algorithm).update(content, "utf8").digest("hex")
      : createHash(algorithm).update(content).digest("hex");

  const { length } = options;
  if (length === undefined) return digest;
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`hashContent: length must be a positive integer, got ${String(length)}`);
  }
  return digest.slice(0, length);
}

/**
 * Resolve `candidate` against `root` and return the absolute path only when it
 * stays inside that root; otherwise `null`.
 *
 * The escape test is SEGMENT-accurate (`".."` or a `"../"`-prefixed relative
 * path), not a bare `startsWith("..")`: a real entry named `..cache` sits inside
 * the root and the prefix test wrongly rejected it. `isAbsolute(rel)` catches
 * the win32 case where the two sides share no common base at all (different
 * drives / UNC roots), where `relative()` returns an absolute path and a
 * `startsWith("..")` test therefore reads "contained".
 *
 * `options.allowRoot` (default `true`) decides whether the root itself counts.
 */
export function resolveWithinRoot(root, candidate, options = {}) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const rootPath = resolve(root);
  const absolutePath = resolve(rootPath, candidate);
  const rel = relative(rootPath, absolutePath);
  if (isAbsolute(rel)) return null;
  if (rel === "") return options.allowRoot === false ? null : absolutePath;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) return null;
  return absolutePath;
}
