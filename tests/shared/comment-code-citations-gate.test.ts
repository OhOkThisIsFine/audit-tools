// check:comment-code-citations — a backticked citation in a source COMMENT must
// resolve against the tree, on the same engine the doc gate uses.
//
// WHY THIS EXISTS. Docs were gated and comments were gated by nothing, so a
// comment naming a renamed or deleted symbol or file stayed green forever. The
// script owns the rule; this file pins it on real throwaway git repos (the gate
// resolves against `git ls-files`, so a mocked fs would exercise nothing), plus
// the whole live tree.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// INV-WH: never a raw child_process entry point in a test file — a windowless
// parent spawning a console child flashes a window on win32.
import { execFileSyncHidden, spawnSyncHidden } from "../helpers/spawn.mjs";
import { commentCitations } from "../../scripts/check-comment-code-citations.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-comment-code-citations.mjs");

const repos: string[] = [];
afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

/** A real git repo holding `files`, every one added to the index. */
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "comment-cite-gate-"));
  repos.push(dir);
  const git = (...args: string[]) =>
    execFileSyncHidden("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  git("init", "-q");
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  git("add", "-A");
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/** Exit status and stdout+stderr — never throws, so a red gate is data. */
function run(dir: string): { code: number; out: string } {
  const r = spawnSyncHidden(process.execPath, [CHECKER, dir], {
    cwd: dir,
    encoding: "utf8",
    windowsHide: true,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("check-comment-code-citations — resolution on a real tree", () => {
  it("reds a comment naming a symbol nothing declares, and greens once the tree declares it", () => {
    const dir = repoWith({
      "src/reader.mjs": "// the reader delegates to `parseLedgerRows`\nexport const x = 1;\n",
    });
    const red = run(dir);
    expect(red.code).toBe(1);
    expect(red.out).toContain("src/reader.mjs:1  `parseLedgerRows` — names nothing the tree declares");

    write(dir, "src/ledger.mjs", "export function parseLedgerRows() {}\n");
    execFileSyncHidden("git", ["add", "-A"], { cwd: dir, windowsHide: true });
    const green = run(dir);
    expect(green.code, green.out).toBe(0);
  });

  it("reds a comment naming a slashed path the tree does not carry, and greens once it does", () => {
    const dir = repoWith({
      "src/reader.mjs": "/** The schema lives in `src/schema/rows.mjs`. */\nexport const x = 1;\n",
    });
    const red = run(dir);
    expect(red.code).toBe(1);
    expect(red.out).toContain("`src/schema/rows.mjs` — does not name a tracked file");

    write(dir, "src/schema/rows.mjs", "export {};\n");
    execFileSyncHidden("git", ["add", "-A"], { cwd: dir, windowsHide: true });
    expect(run(dir).code).toBe(0);
  });

  it("reds a rooted directory that does not exist, but leaves a bare run-layout directory alone", () => {
    const dir = repoWith({
      "src/reader.mjs": "// writes under `runs/` and reads `src/missing/` too\nexport const x = 1;\n",
    });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("`src/missing/`");
    expect(r.out).not.toContain("`runs/`");
  });

  it("does not check a bare filename — that form is out of scope", () => {
    const dir = repoWith({
      "src/reader.mjs": "// mirrors `Cargo.toml` and `gone-sibling.mjs`\nexport const x = 1;\n",
    });
    expect(run(dir).code).toBe(0);
  });

  it("an exemption marker covers its own line and the rest of its block — never the lines above, never the next block", () => {
    const dir = repoWith({
      "src/reader.mjs": [
        "// `aboveMarkerGone` is above the marker and still checked",
        "// <!-- comment-citation-exempt: records a deleted helper -->",
        "// `belowMarkerGone` is exempt",
        "export const x = 1;",
        "// `nextBlockGone` starts a new block and is checked",
        "",
      ].join("\n"),
    });
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("`aboveMarkerGone`");
    expect(r.out).toContain("`nextBlockGone`");
    expect(r.out).not.toContain("`belowMarkerGone`");
  });

  it("reads untracked files as resolution targets but never as citing sources", () => {
    const dir = repoWith({
      "src/reader.mjs": "// see `src/new-module.mjs`\nexport const x = 1;\n",
    });
    // Being authored in the same change: not yet added, but it must resolve.
    write(dir, "src/new-module.mjs", "export {};\n");
    // An untracked scratch file citing nonsense must not add a citation.
    write(dir, "src/scratch.mjs", "// `neverDeclaredAnywhere`\n");
    const r = run(dir);
    expect(r.code, r.out).toBe(0);
  });

  it("the live tree is green", () => {
    const r = run(REPO_ROOT);
    expect(r.code, r.out).toBe(0);
  });
});

describe("commentCitations — which tokens are candidates", () => {
  it("finds camelCase and CONSTANT symbols in line, block and trailing comments", () => {
    const source = [
      "// the reader is `renderConceptualReviewPrompt`",
      "/* and the set is `CONCEPTUAL_FINDING_CATEGORIES` */",
      "const value = 1; // trailing `trailingHelperName`",
    ].join("\n");
    expect(commentCitations(source).map((hit) => [hit.kind, hit.token, hit.line])).toEqual([
      ["symbol", "renderConceptualReviewPrompt", 1],
      ["symbol", "CONCEPTUAL_FINDING_CATEGORIES", 2],
      ["symbol", "trailingHelperName", 3],
    ]);
  });

  it("never reads a string, a template literal or a regex as a comment", () => {
    const source = [
      'const a = "// `insideStringName`";',
      "const b = `// ${a} \\`insideTemplateName\\``;",
      "const c = /\\/\\/ `insideRegexName`/;",
    ].join("\n");
    expect(commentCitations(source)).toEqual([]);
  });

  it("skips prose words, single capitalised words, host globals, calls and members", () => {
    const source = [
      "// prose `findings`, `state` and `done` are words, not citations",
      "// built-ins `NaN`/`RangeError`, errno `ENOENT`, device `COM1` — none a symbol",
      "// shell `$NAME` and emphasis `_FIXED_` are not camelCase either",
      "// host globals `structuredClone` and `setTimeout` are the runtime's",
      "// a call `quotedCall()`, a member `keyed.value` and a regex `^(src|tests)/` are syntax",
    ].join("\n");
    expect(commentCitations(source)).toEqual([]);
  });

  it("skips a token the file's own CODE spells — self-evidencing, no lookup needed", () => {
    const source = [
      "// see `localHelper`, and the fixture writes `src/fixture/a.ts`",
      "function localHelper() {}",
      'const fixture = "src/fixture/a.ts";',
    ].join("\n");
    expect(commentCitations(source)).toEqual([]);
    // The other half, so the case above cannot pass for the wrong reason: the
    // SAME comment, once the code no longer spells either token, reports both.
    expect(
      commentCitations("// see `localHelper`, and the fixture writes `src/fixture/a.ts`").map((hit) => hit.token),
    ).toEqual(["localHelper", "src/fixture/a.ts"]);
  });

  it("reports a candidate regardless of whether it resolves — resolution is the caller's rule", () => {
    expect(commentCitations("// see `goneForever` for the shape")).toEqual([
      { line: 1, token: "goneForever", kind: "symbol" },
    ]);
  });
});
