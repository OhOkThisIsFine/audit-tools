/**
 * Direct unit tests for the single-sourced ownership-identity path
 * canonicalization (src/shared/io/pathIdentity.ts, INV-SOO-09): every spelling
 * of one physical file must collide on one key — absolute against root/cwd,
 * `..`/`.`-collapsed, separators normalized to `/`, case-folded on a
 * case-insensitive volume, symlink realpath folded in when resolvable with a
 * lexical fallback when not.
 */
import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { canonicalizeFilePath } from "audit-tools/shared";

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}

test("case folding: differing-case spellings of one file collide", () => {
  const root = makeScratch("pathid-case-");
  try {
    const upper = join(root, "SRC", "A.ts");
    const lower = join(root, "src", "a.ts");
    if (CASE_INSENSITIVE_FS) {
      expect(canonicalizeFilePath(upper, { root })).toBe(canonicalizeFilePath(lower, { root }));
    } else {
      // Case-sensitive volume: distinct keys, still both canonicalized.
      expect(canonicalizeFilePath(upper, { root })).not.toBe(canonicalizeFilePath(lower, { root }));
    }
    // The folded form is fully lowercase on a case-insensitive volume…
    const folded = canonicalizeFilePath(upper, { root });
    if (CASE_INSENSITIVE_FS) expect(folded).toBe(folded.toLowerCase());
    // …and stable across repeated calls (pure function of its inputs) — the SAME
    // spelling re-canonicalized; the cross-spelling collision is the branch above,
    // and on a case-sensitive volume the two spellings are distinct keys by design.
    expect(folded).toBe(canonicalizeFilePath(upper, { root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a link→target pair whose two spellings must collide. A plain file
 * symlink everywhere that permits one; on an unprivileged Windows host (EPERM
 * without Developer Mode) a directory JUNCTION, which needs no privilege and
 * exercises the identical realpath fold. Returns null when the host permits
 * neither, so the caller skips rather than red-herrings the suite.
 */
function makeLinkFixture(root: string): { link: string; target: string } | null {
  const target = join(root, "src", "real.ts");
  writeFileSync(target, "export {};\n");
  const link = join(root, "src", "link.ts");
  try {
    symlinkSync(target, link);
    return { link, target };
  } catch {
    const dirTarget = join(root, "src", "realdir");
    mkdirSync(dirTarget);
    const inner = join(dirTarget, "inner.ts");
    writeFileSync(inner, "export {};\n");
    const dirLink = join(root, "src", "linkdir");
    try {
      symlinkSync(dirTarget, dirLink, "junction");
    } catch {
      return null;
    }
    return { link: join(dirLink, "inner.ts"), target: inner };
  }
}

test("symlink fold-in: link collides with its target when realpath resolves", (ctx) => {
  const root = makeScratch("pathid-link-");
  try {
    const fixture = makeLinkFixture(root);
    if (!fixture) {
      ctx.skip(true, "host permits neither file symlinks nor directory junctions");
      return;
    }
    expect(canonicalizeFilePath(fixture.link, { resolveSymlinks: true })).toBe(
      canonicalizeFilePath(fixture.target, { resolveSymlinks: true }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cwd-root default: no root supplied resolves against the process cwd", () => {
  const rel = join("src", "f.ts");
  expect(canonicalizeFilePath(rel)).toBe(canonicalizeFilePath(join(process.cwd(), rel)));
});

test("dot-dot collapsing: `..` and `.` collapse to one key", () => {
  const root = makeScratch("pathid-dots-");
  try {
    const plain = canonicalizeFilePath(join("src", "f.ts"), { root });
    expect(canonicalizeFilePath(join("src", "..", "src", ".", "f.ts"), { root })).toBe(plain);
    // An absolute input with dot segments collapses too.
    expect(canonicalizeFilePath(join(root, "x", "..", "src", "f.ts"))).toBe(plain);
    // Escaping the root still lands on a stable, absolute, collapsed key.
    const escaped = canonicalizeFilePath(join("src", "..", "outside.ts"), { root });
    expect(escaped).toBe(canonicalizeFilePath("outside.ts", { root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("separator normalization: native separators fold to `/` in the key", () => {
  const root = makeScratch("pathid-sep-");
  try {
    const slashed = canonicalizeFilePath(join("src", "f.ts"), { root });
    // Portable: on POSIX sep === '/', so a not-contains assertion would be
    // vacuous-to-failing there — pin the `/` form and key equality instead.
    expect(slashed).toContain("/");
    if (sep !== "/") expect(slashed).not.toContain(sep);
    // A literal native-separator spelling keys identically to its `/` form.
    expect(canonicalizeFilePath(`src${sep}f.ts`, { root })).toBe(slashed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lexical fallback: unresolvable path keeps the lexical canonical key", () => {
  const root = makeScratch("pathid-fallback-");
  try {
    const absent = join(root, "src", "missing.ts");
    expect(canonicalizeFilePath(absent, { root, resolveSymlinks: true })).toBe(
      canonicalizeFilePath(absent, { root }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
