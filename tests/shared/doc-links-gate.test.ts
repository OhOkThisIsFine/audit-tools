import { describe, it, expect, beforeAll, afterAll } from "vitest";
// INV-WH: never a raw child_process entry point in a test file — a windowless
// parent spawning a console child flashes a window on win32.
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rebaseRelativeLinks } from "../../scripts/shared/rebase-relative-links.mjs";

const CHECKER = resolve(process.cwd(), "scripts/check-doc-links.mjs");

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
}

/**
 * A REAL temporary git repo, not a mocked fs. The checker enumerates tracked
 * files via `git ls-files`, so a fixture that is not actually committed would
 * exercise nothing — the gate would report zero links and pass vacuously.
 */
function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "doc-links-gate-"));
  const git = (...args: string[]) =>
    execFileSyncHidden("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }) as string;
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  return { dir, git };
}

function write(dir: string, relPath: string, body: string): void {
  const abs = join(dir, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/** Returns { code, out } — never throws, so a failing gate is data not an exception. */
function runChecker(dir: string): { code: number; out: string } {
  try {
    const out = execFileSyncHidden("node", [CHECKER, dir], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("check-doc-links — the gate is RED on each real defect class", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it("PASSES a repo whose relative links all resolve", () => {
    write(repo.dir, "docs/a.md", "See [b](b.md) and [spec](../spec/s.md).\n");
    write(repo.dir, "docs/b.md", "# B\n");
    write(repo.dir, "spec/s.md", "# S\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
    expect(out).toMatch(/every relative link/);
  });

  it("catches a MISSING target — the moved/renamed/deleted class", () => {
    write(repo.dir, "docs/dead.md", "[gone](../spec/removed.md)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[missing\]/);
    expect(out).toMatch(/\.\.\/spec\/removed\.md/);
    expect(out, "must report the source file and line").toMatch(/docs\/dead\.md:1/);
  });

  it("catches the WRONG-DEPTH form specifically — ../../ where ../ was meant", () => {
    // The exact shape the roadmap generator produced: a link correct in
    // docs/backlog/*.md, lifted verbatim one directory up into docs/.
    write(repo.dir, "docs/depth.md", "[axes](../../spec/s.md)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[missing\]/);
    expect(out).toMatch(/\.\.\/\.\.\/spec\/s\.md/);
    // The generated-doc warning must fire, or the reader "fixes" the generated file.
    expect(out).toMatch(/Fix the generator, never the\s+generated file/);
  });

  it("catches a LINE-SUFFIXED citation, and says the file itself exists", () => {
    write(repo.dir, "src/thing.ts", "export const x = 1;\n");
    write(repo.dir, "docs/cite.md", "[sym](../src/thing.ts:1946)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[line-suffixed\]/);
    expect(out, "must distinguish this from a missing file").toMatch(/exists, but `:1946`/);
    expect(out).toMatch(/cite a symbol, not a line/);
  });

  it("catches a RANGE suffix too (:120-140), not just a single line", () => {
    write(repo.dir, "docs/range.md", "[sym](../src/thing.ts:120-140)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[line-suffixed\]/);
    expect(out).toMatch(/:120-140/);
  });

  it("catches a CASE-ONLY mismatch — green on Windows, dead in Linux CI", () => {
    write(repo.dir, "docs/Cased.md", "# Cased\n");
    write(repo.dir, "docs/caseref.md", "[c](cased.md)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[case-mismatch\]/);
    expect(out).toMatch(/Cased\.md/);
  });

  it("catches a dead REFERENCE-STYLE definition, not only inline links", () => {
    write(repo.dir, "docs/ref.md", "Text [label].\n\n[label]: ../spec/nope.md\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/\[missing\]/);
    expect(out).toMatch(/nope\.md/);
  });
});

describe("check-doc-links — the gate stays NARROW", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it("ignores external, mailto, protocol-relative and pure-anchor targets", () => {
    write(
      repo.dir,
      "docs/ext.md",
      [
        "[http](http://example.com/a.md)",
        "[https](https://example.com/b.md)",
        "[mail](mailto:someone@example.com)",
        "[proto](//cdn.example.com/c.md)",
        "[anchor](#a-heading)",
      ].join("\n") + "\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("resolves a link carrying a #fragment by its path half", () => {
    write(repo.dir, "docs/frag.md", "[t](target.md#some-heading)\n");
    write(repo.dir, "docs/target.md", "# Some heading\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("resolves a percent-encoded path", () => {
    write(repo.dir, "docs/enc.md", "[t](my%20doc.md)\n");
    write(repo.dir, "docs/my doc.md", "# spaced\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("ignores an UNTRACKED markdown file — tracked set only, so CI clones agree", () => {
    write(repo.dir, "docs/tracked.md", "# fine\n");
    repo.git("add", "-A");
    // Written but deliberately never staged.
    write(repo.dir, "docs/scratch.md", "[dead](../spec/never.md)\n");
    const { code, out } = runChecker(repo.dir);
    expect(code, `untracked scratch must not gate; got:\n${out}`).toBe(0);
    // Remove it before the next case: these tests share one repo, and a later
    // `git add -A` would TRACK this deliberately-dead link and fail that case
    // for a reason that has nothing to do with what it asserts.
    rmSync(join(repo.dir, "docs/scratch.md"), { force: true });
  });

  it("does not treat a bare directory link as dead when the directory exists", () => {
    write(repo.dir, "docs/backlog/x.md", "# x\n");
    write(repo.dir, "docs/dir.md", "[b](backlog/)\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });
});

describe("rebaseRelativeLinks — the LIFT carries the rewrite", () => {
  // The generator bug this fixes: a title authored in docs/backlog/*.md is copied
  // verbatim into docs/HANDOFF.md one directory up, so `../../spec/x.md` (correct
  // at the source) becomes dead at the destination. Two of the eight dead links
  // at HEAD were exactly this, and both were created by a previous run's own moves.
  const lift = (md: string) => rebaseRelativeLinks(md, "docs/backlog/forward-tracks.md", "docs/HANDOFF.md");

  it("re-bases the exact wrong-depth shape that broke HEAD", () => {
    expect(lift("[`spec/backend-identity-axes.md`](../../spec/backend-identity-axes.md)")).toBe(
      "[`spec/backend-identity-axes.md`](../spec/backend-identity-axes.md)",
    );
  });

  it("re-bases a sibling-file link into the parent directory", () => {
    expect(lift("[deferred](deferred.md)")).toBe("[deferred](./backlog/deferred.md)");
  });

  it("preserves a #fragment across the rebase", () => {
    expect(lift("[x](../../spec/s.md#a-heading)")).toBe("[x](../spec/s.md#a-heading)");
  });

  it("rewrites reference-style definitions too", () => {
    expect(lift("[label]: ../../spec/s.md")).toBe("[label]: ../spec/s.md");
  });

  it("leaves external, anchor and root-absolute targets untouched", () => {
    const external =
      "[a](https://example.com/x.md) [b](mailto:x@y.z) [c](#anchor) [d](/abs/x.md) [e](//cdn/x.md)";
    expect(lift(external)).toBe(external);
  });

  it("is a NO-OP when source and destination share a directory", () => {
    const md = "[x](../../spec/s.md)";
    expect(rebaseRelativeLinks(md, "docs/a.md", "docs/b.md")).toBe(md);
  });

  it("keeps a trailing slash on a directory link", () => {
    expect(lift("[b](../backlog/)")).toMatch(/\/\)$/);
  });

  it("REGRESSION: the generated roadmap and index contain no ../../ escape", () => {
    // Inverting the fix (dropping the lift) reintroduces `../../spec/...` here.
    for (const f of ["docs/HANDOFF.md", "docs/backlog.md"]) {
      const body = readFileSync(resolve(process.cwd(), f), "utf8");
      const escapes = [...body.matchAll(/\]\((\.\.\/\.\.\/[^)]+)\)/g)].map((m) => m[1]);
      expect(escapes, `${f} carries link(s) that escape the repo docs root`).toEqual([]);
    }
  });
});

describe("check-doc-links — an ignored target is an install artifact, not a dead link", () => {
  // The gate's verdict must not depend on the machine running it. `existsSync`
  // made it depend: a link into a GITIGNORED install dir resolved on a box that
  // had run the installer and 404'd in CI's bare clone — green locally, red on
  // main, which is the precise failure this gate exists to prevent.
  // Inverting the fix (dropping the gitIgnored filter) turns the first case red.
  let repo: Repo;
  beforeAll(() => {
    repo = makeRepo();
    write(repo.dir, ".gitignore", ".installed/\n");
    // Deliberately NOT written to disk — this is the BARE-CLONE state, the only
    // one that exercises the filter. Writing it would make the link resolve
    // through `existsSync` and never reach the `missing` branch at all, so the
    // test would pass with the fix inverted (it did, on the first attempt).
    write(
      repo.dir,
      "AGENTS.md",
      [
        "[install-time directive](.installed/generated.md)",
        "[a genuinely dead link](docs/nope.md)",
      ].join("\n\n"),
    );
    repo.git("add", "-A");
    repo.git("commit", "-qm", "fixture");
  });
  afterAll(() => rmSync(repo.dir, { recursive: true, force: true }));

  it("does NOT flag an ABSENT link target that git ignores", () => {
    const { out } = runChecker(repo.dir);
    expect(out).not.toContain(".installed/generated.md");
  });

  it("STILL fails on a genuinely dead link in the same file", () => {
    // Guards against the filter being over-broad and neutering the gate.
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toContain("docs/nope.md");
  });
});

describe("check-doc-links — the real repo is the contract", () => {
  it("THIS repo has zero unresolvable relative links", () => {
    const { code, out } = runChecker(process.cwd());
    expect(code, `dead links at HEAD:\n${out}`).toBe(0);
  });
});
