import { describe, it, expect, beforeAll, afterAll } from "vitest";
// INV-WH: never a raw child_process entry point in a test file — a windowless
// parent spawning a console child flashes a window on win32.
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHECKER = resolve(process.cwd(), "scripts/check-doc-code-citations.mjs");

interface Repo {
  dir: string;
  git: (...args: string[]) => string;
}

/**
 * A REAL temporary git repo, not a mocked fs — the checker resolves citations
 * against `git ls-files`, so an uncommitted fixture would exercise nothing.
 */
function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "doc-cite-gate-"));
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

describe("check-doc-code-citations — backticked repo paths must name tracked files", () => {
  let repo: Repo;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmSync(repo.dir, { recursive: true, force: true });
  });

  it("PASSES when every citation resolves — including a stripped :line suffix", () => {
    write(repo.dir, "src/thing.ts", "export const x = 1;\n");
    write(
      repo.dir,
      "docs/a.md",
      "See `src/thing.ts` and the anchor form `src/thing.ts:42` and range `src/thing.ts:10-20`.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
    expect(out).toMatch(/every one names a tracked file/);
  });

  it("is RED on a citation of a non-tracked path under a tracked top-level dir", () => {
    write(repo.dir, "docs/dead.md", "The old file `src/removed.ts` did this.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/docs[/\\]?dead\.md:1/);
    expect(out).toMatch(/src\/removed\.ts/);
    rmSync(join(repo.dir, "docs", "dead.md"));
    repo.git("add", "-A");
  });

  it("an explicit exempt marker on the line above (or inline) suppresses the citation", () => {
    write(
      repo.dir,
      "docs/exempt.md",
      "<!-- doc-citation-exempt: third-party repo path -->\n" +
        "`src/not-ours.ts` lives in another repo.\n" +
        "`src/also-not-ours.ts` too. <!-- doc-citation-exempt: narrative -->\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("skips patterns, placeholders, prose with spaces, and runtime .audit-tools paths", () => {
    write(
      repo.dir,
      "docs/skips.md",
      "Globs `src/**/*.ts` and templates `docs/reviews/*-<date>.md` are patterns.\n" +
        "Runtime layout `.audit-tools/audit/steps/current-step.json` is a run artifact.\n" +
        "Prose `src/thing.ts and friends` has whitespace.\n" +
        "No slash: `package.json`. Unknown top dir: `node_modules/x/y.js`.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("skips files the doc-manifest excluded row names (dated review records)", () => {
    write(
      repo.dir,
      "docs/reviews/something-2026-01-01.md",
      "Historical record citing `src/long-gone.ts` as it was that day.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("treats an unstaged deleted markdown file as absent instead of crashing", () => {
    write(
      repo.dir,
      "docs/deleted.md",
      "This tracked document is being retired and cites `src/thing.ts`.\n",
    );
    repo.git("add", "docs/deleted.md");
    rmSync(join(repo.dir, "docs", "deleted.md"));

    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
    expect(out).toMatch(/every one names a tracked file/);

    repo.git("add", "-u", "docs/deleted.md");
  });

  it("lets a citation resolve to an untracked file being added in the same tree", () => {
    write(repo.dir, "src/new-source.ts", "export const added = true;\n");
    write(repo.dir, "docs/new-source.md", "See `src/new-source.ts`.\n");
    repo.git("add", "docs/new-source.md");

    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);

    rmSync(join(repo.dir, "src", "new-source.ts"));
    rmSync(join(repo.dir, "docs", "new-source.md"));
    repo.git("add", "-u", "docs/new-source.md");
  });
});
