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
    expect(out).toMatch(/every one resolves/);
    // The tally reports all three citation classes, not just slashed file paths.
    expect(out).toMatch(/\d+ path \+ \d+ directory \+ \d+ bare-filename citation\(s\)/);
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
        "Unknown top dir: `node_modules/x/y.js`. Elision: `src/…/deep.ts`.\n",
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
    expect(out).toMatch(/every one resolves/);

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

  // ── directory citations (trailing slash → the tracked dir must exist) ──────

  it("resolves a trailing-slash citation of a tracked root-relative directory", () => {
    write(repo.dir, "docs/dirs-green.md", "The `src/` tree and the `docs/` tree.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("resolves a trailing-slash citation doc-relative when it misses at the root", () => {
    write(repo.dir, "docs/sub/x.md", "leaf\n");
    write(repo.dir, "docs/rel.md", "See the `sub/` folder beside this doc.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("is RED on a trailing-slash citation of a directory that exists nowhere", () => {
    write(repo.dir, "docs/dir-dead.md", "Prompts live under `prompts/` now.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/docs[/\\]?dir-dead\.md:1/);
    expect(out).toMatch(/prompts\//);
    expect(out).toMatch(/missing directory/);
    rmSync(join(repo.dir, "docs", "dir-dead.md"));
    repo.git("add", "-A");
  });

  it("never resolves a directory anywhere-in-tree — the P29 stale-`prompts/` regression", () => {
    // A tracked .github/prompts/ dir must NOT green a `prompts/` citation in a
    // doc elsewhere: that anywhere-match is exactly how the stale citation P29
    // caught would have stayed invisible.
    write(repo.dir, ".github/prompts/x.md", "prompt\n");
    write(repo.dir, "src/audit/README.md", "Prompt templates live in `prompts/`.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/src[/\\]audit[/\\]README\.md:1/);
    expect(out).toMatch(/missing directory/);
    rmSync(join(repo.dir, "src", "audit", "README.md"));
    repo.git("add", "-A");
  });

  it("skips gitignored and non-repo directory citations", () => {
    write(repo.dir, ".gitignore", "dist/\nnode_modules/\n");
    write(
      repo.dir,
      "docs/dir-skips.md",
      "Build output lands in `dist/`. External homes: `~/.claude/x/`, `C:/tmp/`, `file://x/`.\n" +
        "Runtime layout: `.audit-tools/audit/`.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  // ── bare filename citations (resolved against the tracked set) ─────────────

  it("resolves a bare filename with exactly one tracked match — line suffix included", () => {
    write(repo.dir, "package.json", '{ "name": "fixture" }\n');
    write(
      repo.dir,
      "docs/bare-green.md",
      "Entries live in `package.json`; the helper is `thing.ts`, anchored as `thing.ts:1`.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("is RED on a bare filename matching no tracked file", () => {
    write(repo.dir, "docs/bare-dead.md", "The old test was `removed.ts` here.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/docs[/\\]?bare-dead\.md:1/);
    expect(out).toMatch(/removed\.ts/);
    expect(out).toMatch(/matches no tracked file/);
    rmSync(join(repo.dir, "docs", "bare-dead.md"));
    repo.git("add", "-A");
  });

  it("is RED on an ambiguous bare filename and names every candidate", () => {
    write(repo.dir, "a/dup.ts", "export const a = 1;\n");
    write(repo.dir, "b/dup.ts", "export const b = 2;\n");
    write(repo.dir, "docs/bare-ambiguous.md", "See `dup.ts` for details.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code).toBe(1);
    expect(out).toMatch(/ambiguous/);
    expect(out).toMatch(/a\/dup\.ts/);
    expect(out).toMatch(/b\/dup\.ts/);
    rmSync(join(repo.dir, "docs", "bare-ambiguous.md"));
    rmSync(join(repo.dir, "a"), { recursive: true });
    rmSync(join(repo.dir, "b"), { recursive: true });
    repo.git("add", "-A");
  });

  it("resolves an ambiguous bare filename to a repo-root candidate when exactly one exists", () => {
    // `README.md`-style: the root file is only citable bare (it has no longer
    // form), so a single root-level candidate wins the tie.
    write(repo.dir, "notes.md", "root notes\n");
    write(repo.dir, "src/notes.md", "nested notes\n");
    write(repo.dir, "docs/bare-root.md", "Read `notes.md` first.\n");
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("skips leading-dot names, untracked extensions, and runtime artifact names", () => {
    write(
      repo.dir,
      "docs/bare-skips.md",
      "Dotfile mention `.npmrc`; binary `claude.exe`; method `vi.spyOn`;\n" +
        "run artifact `repo_manifest.json` is written by the audit, never tracked.\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });

  it("an exempt marker suppresses directory and bare-filename reds too", () => {
    write(
      repo.dir,
      "docs/exempt-new-classes.md",
      "<!-- doc-citation-exempt: deleted dir narrative -->\n" +
        "The retired `gone-away/` directory held state.\n" +
        "`long-gone.ts` was deleted. <!-- doc-citation-exempt: narrative -->\n",
    );
    repo.git("add", "-A");
    const { code, out } = runChecker(repo.dir);
    expect(code, `expected green, got:\n${out}`).toBe(0);
  });
});
