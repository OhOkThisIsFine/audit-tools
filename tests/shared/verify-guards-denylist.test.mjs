/**
 * The `verify:guards` script (package.json) is the per-node cross-cutting GUARD suite —
 * the full vitest run MINUS the heavy subprocess-spawning integration/e2e tests, named
 * as an additive-safe denylist of `--exclude` globs. A HEAVY test that gets RENAMED
 * would silently fall OUT of the denylist and back INTO the per-node guard, blowing up
 * the per-node guard's cost (that guard runs in the hot accept path). This test pins the
 * denylist honest: every `--exclude` glob must still match ≥1 existing test file on disk,
 * so a rename that orphans an exclude fails loud here instead of degrading guard cost.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

/** Recursively collect every test file under `tests/`, as repo-relative forward-slash paths. */
function listTestFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (/\.test\.[cm]?[jt]s$/.test(ent.name)) out.push(r);
    }
  };
  walk(join(repoRoot, "tests"), "tests");
  return out;
}

/** Minimal glob → RegExp (supports `**` / `**\/` / `*`), anchored, "/"-separated paths. */
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * Pull the `--exclude "<glob>"` values out of the verify:guards script string.
 * Accepts either quote style — but the script MUST use double quotes so the globs
 * survive `npm run` on BOTH cmd.exe (Windows strips only double quotes; single
 * quotes pass through literally and never match) and POSIX sh.
 */
function excludeGlobs(script) {
  const globs = [];
  const rx = /--exclude\s+(?:"([^"]+)"|'([^']+)')/g;
  let m;
  while ((m = rx.exec(script)) !== null) globs.push(m[1] ?? m[2]);
  return globs;
}

describe("verify:guards denylist — every exclude glob still matches a real test file", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const script = pkg.scripts["verify:guards"];
  const globs = excludeGlobs(script);
  const files = listTestFiles();

  it("verify:guards exists and carries a non-empty --exclude denylist", () => {
    expect(typeof script).toBe("string");
    expect(globs.length).toBeGreaterThan(0);
  });

  it("uses DOUBLE-quoted excludes (single quotes pass through literally under npm+cmd.exe on Windows)", () => {
    // cmd.exe strips only double quotes; a single-quoted glob reaches vitest WITH the
    // quotes and matches nothing → the heavy tests silently re-enter the per-node guard.
    expect(script).not.toMatch(/--exclude\s+'/);
    expect(script).toMatch(/--exclude\s+"/);
  });

  it.each(globs)("exclude glob %s matches at least one existing test file", (glob) => {
    const re = globToRegExp(glob);
    const matched = files.filter((f) => re.test(f));
    expect(matched.length).toBeGreaterThan(0);
  });
});
