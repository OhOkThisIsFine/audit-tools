import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Whether the host filesystem is case-insensitive for path identity. win32 and
 * darwin default to case-insensitive volumes; linux is case-sensitive. Used so
 * `src/A.ts` and `src/a.ts` collide on a Windows/macOS volume (one physical
 * file) but stay distinct on Linux — INV-SOO-09 canonical physical-file identity.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/**
 * The single-sourced path canonicalization for ownership identity (INV-SOO-09).
 *
 * Resolves a path to a stable physical-file key: absolute (against `root` when
 * supplied, else cwd), `..`/`.`-collapsed (via `resolve`), separators normalized
 * to `/`, and case-folded on a case-insensitive filesystem. All spellings of one
 * file therefore collide, closing the rel/abs/case/`..` mismatch (CE-004).
 *
 * Symlink identity is a RECORDED RESIDUAL, not silently treated as disjoint
 * (INV-SOO-09 / fail-3): when `resolveSymlinks` is set and the path exists, the
 * realpath is folded in so `link.ts → x.ts` collides; when realpath is
 * unavailable (path absent, or FS symlink resolution out of scope) the lexical
 * canonical key is used and the unresolved case degrades to the downstream merge
 * guard rather than being asserted disjoint here.
 *
 * This is the ONLY normalization scheme for ownership identity — callers must
 * not introduce a second one (failure-mode: path-identity mismatch). It lives in
 * `audit-tools/shared` so BOTH orchestrators' ownership scheduling resolves file
 * identity identically (a remediate write-scope and an audit read-scope key the
 * same file the same way).
 */
export function canonicalizeFilePath(
  path: string,
  opts: { root?: string; resolveSymlinks?: boolean } = {},
): string {
  const { root, resolveSymlinks = false } = opts;
  let abs = isAbsolute(path)
    ? resolve(path)
    : resolve(root ?? process.cwd(), path);
  if (resolveSymlinks) {
    try {
      abs = realpathSync(abs);
    } catch {
      // Symlink/realpath unavailable (path absent or FS resolution out of scope):
      // keep the lexical key — the unresolved symlink case is a recorded residual
      // handled by the downstream merge guard, never asserted disjoint here.
    }
  }
  const slashed = abs.split(sep).join("/");
  return CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
}
