/**
 * The per-site pinning gate's contract (`scripts/check-sites-pinned.mjs`).
 *
 * The gate exists because a prototype took a HAND-WRITTEN site list — 7 sites
 * declared against >=11 substantive hunks — and "all 7 changed sites are
 * individually pinned" was literally true and materially misleading. The
 * property this file pins is the one that closes that: the site list is DERIVED
 * from the diff, so an omitted hunk cannot be omitted by anyone's choice.
 *
 * These tests drive the exported walker against FIXTURE diffs. That is
 * deliberate: the refusals below are the whole point of the gate, and asserting
 * them against the real index would mean breaking the real repo to reach them —
 * a refusal path that is never exercised is the half-enforced trap the gate
 * itself exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  ADMISSIBILITY_NOTE,
  PIN_MARKER,
  changedSites,
  classifyChangedLine,
  deriveGeneratedFiles,
  parseUnifiedDiff,
  pinSites,
  readPinDeclaration,
} from "../../scripts/check-sites-pinned.mjs";

const INCLUDE = (p: string) => p.startsWith("src/");

/** A minimal `git diff -U0` block for one file, with its hunk placed at `atLine`. */
function diffFor(
  path: string,
  added: string[],
  removed: string[] = [],
  { atLine = 1, removedAt = 1 }: { atLine?: number; removedAt?: number } = {},
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${removedAt},${removed.length} +${atLine},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

/** A `git diff -U0` block that DELETES lines, leaving nothing at that position. */
function deletionFor(path: string, removed: string[], atLine = 1): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${atLine},${removed.length} +${atLine},0 @@`,
    ...removed.map((l) => `-${l}`),
  ].join("\n");
}

/** A source reader backed by a fixture map. */
const reader = (files: Record<string, string>) => (rel: string) => {
  if (!(rel in files)) throw new Error(`ENOENT ${rel}`);
  return files[rel];
};

describe("site derivation — the denominator", () => {
  it("derives a site for every changed hunk, including ones an author would omit", () => {
    // Two substantive hunks in ONE file, separated by untouched code. The
    // prototype's failure mode was declaring one and not the other; here both
    // are derived from the same diff and both must be bound.
    const diffText = [
      diffFor("src/a.ts", ["const FIXED = true;"]),
      diffFor("src/b.ts", ["export function core() {", "  return 42;", "}"]),
    ].join("\n");

    const { sites } = pinSites({
      diffText,
      readText: reader({
        "src/a.ts": `// ${PIN_MARKER}: tests/shared/x.test.ts\nconst FIXED = true;`,
        "src/b.ts": `// ${PIN_MARKER}: tests/shared/x.test.ts\n`,
      }),
      include: INCLUDE,
    });

    expect(sites.map((s) => s.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    // The count is DERIVED — three lines in b.ts, not the author's "one hunk".
    expect(sites.find((s) => s.path === "src/b.ts")?.lines).toHaveLength(3);
  });

  it("refuses a changed site with no declaration — the omitted-hunk shape", () => {
    const { errors, sites } = pinSites({
      diffText: diffFor("src/omitted.ts", ["export const sneaky = 1;"]),
      readText: reader({ "src/omitted.ts": "export const sneaky = 1;\n" }),
      include: INCLUDE,
    });

    expect(sites).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declaration ABOVE it");
    // The refusal NAMES the line AND ITS POSITION, so the operator does not have
    // to re-derive which hunk went unbound.
    expect(errors[0]).toContain("src/omitted.ts:1");
    expect(errors[0]).toContain('"export const sneaky = 1;"');
  });

  it("ignores files outside the pinned source set", () => {
    const { errors, sites } = pinSites({
      diffText: diffFor("docs/readme.md", ["a new sentence"]),
      readText: reader({ "docs/readme.md": "a new sentence\n" }),
      include: INCLUDE,
    });
    expect(errors).toEqual([]);
    expect(sites).toEqual([]);
  });
});

describe("exclusion rules — what a site is not", () => {
  it.each([
    ["", "blank"],
    ["// a comment", "comment-only"],
    ["  /* block */", "comment-only"],
    ["import { z } from 'zod';", "import-edge"],
  ])("classifies %j as excluded by %s", (line, rule) => {
    const verdict = classifyChangedLine(line);
    expect(verdict.excluded).toBe(true);
    expect(verdict.rule).toBe(rule);
  });

  it("does NOT exclude real code — the predicate is not a catch-all", () => {
    for (const line of [
      "export const PINNED = true;",
      "  return parse(value);",
      "if (x === 1) {",
      "const s = 'import from';",
    ]) {
      expect(classifyChangedLine(line).excluded, line).toBe(false);
    }
  });

  it("collapses an all-excluded file to a REPORTED exclusion, never silence", () => {
    const { errors, sites, excluded } = pinSites({
      diffText: diffFor("src/comments-only.ts", ["// just a note", ""]),
      readText: reader({ "src/comments-only.ts": "// just a note\n" }),
      include: INCLUDE,
    });
    expect(errors).toEqual([]);
    expect(sites).toEqual([]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].path).toBe("src/comments-only.ts");
  });

  it("honours a declared whole-file exemption, and prints its reason", () => {
    const { errors, excluded } = pinSites({
      diffText: diffFor("src/generated.ts", ["export const BIG = {};"]),
      readText: reader({
        "src/generated.ts": `// ${PIN_MARKER}: none — generated from the schema, pinned by the render test\n`,
      }),
      include: INCLUDE,
    });
    expect(errors).toEqual([]);
    expect(excluded[0].reason).toContain("generated from the schema");
  });
});

describe("the whole-file exemption is the WORD `none`, with a reason (D1)", () => {
  // The fail-open this closes: choosing the exemption with
  // `body.toLowerCase().startsWith('none')` made `sites-pinned:
  // nonexistent.test.ts` an EXEMPTION, so the name check was skipped and the
  // gate passed with its binding deleted. A prefix match is not a token match.

  it("reads `nonexistent.test.ts` as a TEST NAME, not as `none`", () => {
    expect(readPinDeclaration(`// ${PIN_MARKER}: nonexistent.test.ts`)).toEqual({
      kind: "tests",
      names: ["nonexistent.test.ts"],
      why: "",
    });
  });

  it("refuses a site bound to a nonexistent test, through the REAL name checker", () => {
    const refused = (names: string[]) =>
      names.includes("nonexistent.test.ts") ? [`binds "${names[0]}" which is not tracked`] : [];
    const { errors, excluded } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({ "src/a.ts": `// ${PIN_MARKER}: nonexistent.test.ts\n` }),
      include: INCLUDE,
      checkNames: (names) => refused(names),
    });
    // The site is CHECKED and refused — it is not exempted out of the walk.
    expect(excluded).toEqual([]);
    expect(errors).toEqual(['binds "nonexistent.test.ts" which is not tracked']);
  });

  it("refuses a bare `none` with no reason, and names the documented form", () => {
    const { errors, excluded } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({ "src/a.ts": `// ${PIN_MARKER}: none\n` }),
      include: INCLUDE,
    });
    expect(excluded).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("malformed");
    expect(errors[0]).toContain("states no reason");
    // The refusal names the form the author should have written.
    expect(errors[0]).toContain(`\`// ${PIN_MARKER}: none — <why>\``);
  });

  it("accepts `none — <why>` and keeps the reason", () => {
    expect(readPinDeclaration(`// ${PIN_MARKER}: none — it is a data twin`)).toEqual({
      kind: "whole-file",
      names: [],
      why: "it is a data twin",
    });
    // A colon is the other separator an author reaches for, and it is read the
    // same way rather than becoming a malformed refusal.
    expect(readPinDeclaration(`// ${PIN_MARKER}: none: it is a data twin`)?.why).toBe(
      "it is a data twin",
    );
  });

  it("does not read `nonetheless-…` or `nonexistent` as the token `none`", () => {
    // A word BOUNDARY, checked directly: the operand must begin with `none`
    // followed by a non-word character, never with a longer word.
    expect(readPinDeclaration(`// ${PIN_MARKER}: nonetheless.test.ts`)?.kind).toBe("tests");
    expect(readPinDeclaration(`// ${PIN_MARKER}: nonesuch.test.ts`)?.kind).toBe("tests");
  });
});

describe("generated files need no declaration (D2)", () => {
  const GENERATED_ROWS = [
    { generator: "scripts/shared/generate-thing.mjs", artifacts: ["scripts/shared/thing.generated.mjs"] },
    { generator: "scripts/audit/generate-schemas.mjs", generatedArtifacts: ["src/a.generated.ts"] },
  ];

  it("derives the exclusion set from the declared GENERATED data", () => {
    const byFile = deriveGeneratedFiles(GENERATED_ROWS);
    expect(byFile.get("scripts/shared/thing.generated.mjs")).toBe(
      "scripts/shared/generate-thing.mjs",
    );
    // The `generatedArtifacts` field is read too: a generator whose freshness is
    // held by a contract test rather than a declared artifact still WRITES the
    // file, and reading only `artifacts` would leave that file a false red.
    expect(byFile.get("src/a.generated.ts")).toBe("scripts/audit/generate-schemas.mjs");
  });

  it("excludes a changed site in a declared generated file, and still refuses its neighbour", () => {
    // The pair is the point: the exclusion must be scoped to the DECLARED file,
    // not to a file whose name merely looks generated.
    const { errors, sites, generated } = pinSites({
      diffText: [
        diffFor("src/a.generated.ts", ["export const TABLE = {};"]),
        diffFor("src/b.ts", ["export const HAND_WRITTEN = 1;"]),
      ].join("\n"),
      readText: reader({
        "src/a.generated.ts": "export const TABLE = {};\n",
        "src/b.ts": "export const HAND_WRITTEN = 1;\n",
      }),
      include: INCLUDE,
      isGenerated: (p) => deriveGeneratedFiles(GENERATED_ROWS).get(p) ?? null,
    });
    expect(generated).toEqual([
      { path: "src/a.generated.ts", generator: "scripts/audit/generate-schemas.mjs" },
    ]);
    expect(sites).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/b.ts:1");
  });

  it("needs no declaration even when a whole-file `none` would otherwise be required", () => {
    // `scripts/` is in the real pinned set and NOT in this suite's narrow
    // `INCLUDE`, so the walk is driven with the real predicate here.
    const { errors, generated } = pinSites({
      diffText: diffFor("scripts/shared/thing.generated.mjs", ["export const X = [];"]),
      readText: reader({ "scripts/shared/thing.generated.mjs": "export const X = [];\n" }),
      include: (p) => p.startsWith("scripts/") || p.startsWith("src/"),
      isGenerated: (p) => deriveGeneratedFiles(GENERATED_ROWS).get(p) ?? null,
    });
    expect(errors).toEqual([]);
    expect(generated).toEqual([
      { path: "scripts/shared/thing.generated.mjs", generator: "scripts/shared/generate-thing.mjs" },
    ]);
  });
});

describe("the name binding — and the admission about it", () => {
  it("binds each site to tracked test files by name", () => {
    const seen: string[][] = [];
    const { errors, sites } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({
        "src/a.ts": `// ${PIN_MARKER}: tests/shared/one.test.ts, tests/shared/two.test.ts\n`,
      }),
      include: INCLUDE,
      checkNames: (names) => {
        seen.push(names);
        return [];
      },
    });
    expect(errors).toEqual([]);
    expect(sites[0].tests).toEqual(["tests/shared/one.test.ts", "tests/shared/two.test.ts"]);
    expect(seen[0]).toHaveLength(2);
  });

  it("threads a name-checker refusal out rather than swallowing it", () => {
    const refusals: string[][] = [];
    const { errors } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({ "src/a.ts": `// ${PIN_MARKER}: tests/gone.test.ts\n` }),
      include: INCLUDE,
      checkNames: (names) => {
        refusals.push(names);
        return [`binds "${names[0]}" which is not a tracked file`];
      },
    });
    expect(refusals).toEqual([["tests/gone.test.ts"]]);
    expect(errors).toEqual(['binds "tests/gone.test.ts" which is not a tracked file']);
  });

  it("the REAL checker refuses a binding to a test that is not tracked", async () => {
    // Driven through the gate's own CLI against a fixture repo, so the refusal
    // that actually fires at commit time is the one exercised — not a stand-in.
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "sites-pinned-"));
    try {
      const run = (args: string[]) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
      run(["init", "-q"]);
      run(["config", "user.email", "t@example.com"]);
      run(["config", "user.name", "t"]);
      mkdirSync(join(repo, "scripts"), { recursive: true });
      mkdirSync(join(repo, "tests", "shared"), { recursive: true });
      writeFileSync(join(repo, "tests/shared/real.test.ts"), 'it("x", () => {});\n');
      writeFileSync(
        join(repo, "scripts/gate.mjs"),
        `// ${PIN_MARKER}: tests/shared/real.test.ts\nconst X = 1;\n`,
      );
      writeFileSync(join(repo, "README.md"), "# fixture\n");
      run(["add", "-A"]);
      run(["commit", "-qm", "base"]);

      // Bind the SAME changed site to a test that does not exist. `scripts/` is
      // in the pinned set, so this is the one file the gate walks.
      writeFileSync(
        join(repo, "scripts/gate.mjs"),
        `// ${PIN_MARKER}: tests/shared/ghost.test.ts\nconst X = 1;\nconst Y = 2;\n`,
      );
      run(["add", "-A"]);

      const gate = fileURLToPath(new URL("../../scripts/check-sites-pinned.mjs", import.meta.url));
      let output = "";
      try {
        execFileSync(process.execPath, [gate], { cwd: repo, encoding: "utf8", windowsHide: true });
      } catch (error) {
        output = String((error as { stderr?: string }).stderr ?? "");
      }
      expect(output).toContain("tests/shared/ghost.test.ts");
      expect(output).toContain("NOT a tracked file");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("refuses a declaration with no names — a binding to nothing", () => {
    // A bare `// sites-pinned:` with no operand reads as a binding while
    // obliging nothing, so it is refused by name rather than treated as absent:
    // the author DID declare something, and the refusal has to say what was
    // wrong with it rather than claim there was no declaration.
    const { errors } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({ "src/a.ts": `// ${PIN_MARKER}:   \n` }),
      include: INCLUDE,
    });
    // `readPinDeclaration` DOES read it as a declaration (the operand is blank
    // whitespace, which the pattern admits), with zero names…
    expect(readPinDeclaration(`// ${PIN_MARKER}:   `)).toEqual({
      kind: "tests",
      names: [],
      why: "",
    });
    // …so the walk refuses it as a binding to nothing rather than reporting an
    // absent declaration: the author declared something and the refusal says
    // what was wrong with it.
    expect(errors.join("\n")).toContain("with no test names");
    // The truly bare form (no operand at all) is not a declaration.
    expect(readPinDeclaration(`// ${PIN_MARKER}:`)).toBeNull();
  });

  it("refuses a declaration that binds to prose instead of test paths", () => {
    // A body that is not a test-path list would surface later as a confusing
    // "not a tracked file"; it is read as no declaration, which is the same
    // refusal an absent one gets.
    expect(readPinDeclaration(`// ${PIN_MARKER}: see the commit message for details`)).toBeNull();
  });

  it("does NOT read prose about the marker as a declaration", () => {
    // This gate's own header discusses `// sites-pinned:` in prose. A parse that
    // accepted that would bind every file to the string "`".
    expect(readPinDeclaration("// a `// sites-pinned: <test names>` declaration beside it")).toBeNull();
    expect(readPinDeclaration(" * the `// sites-pinned: none` marker")).toBeNull();
    // A real declaration is still read.
    expect(readPinDeclaration(`// ${PIN_MARKER}: tests/shared/a.test.ts`)?.names).toEqual([
      "tests/shared/a.test.ts",
    ]);
  });

  it("states in its own output that it is NOT admissible attestation evidence", () => {
    // The owner decision left the name binding author-supplied, which the
    // backlog warns relocates the claim rather than removing it. The gate has to
    // SAY so, in the text a reader of a green run actually sees.
    expect(ADMISSIBILITY_NOTE).toContain("NOT ADMISSIBLE AS ATTESTATION EVIDENCE");
    expect(ADMISSIBILITY_NOTE).toContain("author-supplied");
  });
});

describe("diff parsing", () => {
  it("reads added and removed lines alike as changed sites", () => {
    const files = parseUnifiedDiff(
      diffFor("src/a.ts", ["const NEW = 1;"], ["const OLD = 2;"]),
    );
    expect(files.get("src/a.ts")?.lines.map((l) => l.text).sort()).toEqual([
      "const NEW = 1;",
      "const OLD = 2;",
    ]);
  });

  it("drops generator lines rather than counting them as sites", () => {
    const files = parseUnifiedDiff(diffFor("src/a.ts", ["const X = 1;"]));
    expect(files.get("src/a.ts")?.lines.map((l) => l.text)).toEqual(["const X = 1;"]);
  });

  it("carries each changed line's position in the NEW file", () => {
    // The position is what binds a site to the declaration above it, so it is
    // read from the hunk header rather than assumed.
    const files = parseUnifiedDiff(
      ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -40,2 +57,3 @@", " const kept;", "+const added = 1;", "+const added2 = 2;"].join("\n"),
    );
    expect(files.get("src/a.ts")?.lines).toEqual([
      { text: "const added = 1;", head: 57 },
      { text: "const added2 = 2;", head: 58 },
    ]);
  });

  it("marks a pure deletion as having no position in the new file", () => {
    // `+c,0` leaves nothing at c: the removed lines were above every declaration
    // at their old position, and there is no governed line left to check them
    // against. Reported, never silently bound to whatever declaration follows.
    const files = parseUnifiedDiff(
      ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -3,2 +2,0 @@", "-const gone = 1;"].join("\n"),
    );
    expect(files.get("src/a.ts")?.lines).toEqual([{ text: "const gone = 1;", head: null }]);
  });

  it("changedSites is the exclusion-filtered view of a file's lines", () => {
    expect(
      changedSites([
        { text: "const a = 1;", head: 1 },
        { text: "// note", head: 2 },
        { text: "", head: 3 },
        { text: "const b = 2;", head: 4 },
      ]),
    ).toEqual([
      { text: "const a = 1;", head: 1 },
      { text: "const b = 2;", head: 4 },
    ]);
  });
});

describe("a site binds to the declaration nearest ABOVE it (D6)", () => {
  // The docstring always said "nearest above"; the code returned the FIRST
  // declaration in the file. Between them sat the fail-open this closes: a stale
  // header declaration could answer for a hunk a later declaration was written
  // to bind, and a hunk above EVERY declaration was covered by one below it.
  const TWO_DECLARATIONS = [
    `// ${PIN_MARKER}: tests/stale.test.ts`,
    "const headerConstant = 1;",
    "export function untouched() {}",
    `// ${PIN_MARKER}: tests/fresh.test.ts`,
    "export function changed() {",
    "  return 2;",
    "}",
  ].join("\n");

  it("binds a change to the declaration written for it, not to the file's first", () => {
    const { errors, sites } = pinSites({
      // The hunk sits at lines 5..7 — BELOW the second declaration — which is
      // what a real diff of this edit reports.
      diffText: diffFor("src/a.ts", ["export function changed() {", "  return 2;", "}"], [], {
        atLine: 5,
      }),
      readText: reader({ "src/a.ts": TWO_DECLARATIONS }),
      include: INCLUDE,
      checkNames: () => [],
    });
    expect(errors).toEqual([]);
    expect(sites).toHaveLength(1);
    expect(sites[0].tests).toEqual(["tests/fresh.test.ts"]);
  });

  it("refuses a changed line that lies ABOVE the first declaration", () => {
    // No declaration governs it — the one further down the file is not "above".
    const source = ["const before = 1;", `// ${PIN_MARKER}: tests/later.test.ts`, "const after = 2;"].join(
      "\n",
    );
    const { errors, sites } = pinSites({
      diffText: diffFor("src/a.ts", ["const before = 1;"]),
      readText: reader({ "src/a.ts": source }),
      include: INCLUDE,
      checkNames: () => [],
    });
    expect(sites).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/a.ts:1");
    expect(errors[0]).toContain("declaration ABOVE it");
    expect(errors[0]).toContain('"const before = 1;"');
  });

  it("lets two hunks of ONE file bind to two different declarations", () => {
    const source = [
      `// ${PIN_MARKER}: tests/one.test.ts`,
      "const first = 1;",
      `// ${PIN_MARKER}: tests/two.test.ts`,
      "const second = 2;",
    ].join("\n");
    const { errors, sites } = pinSites({
      diffText: [
        diffFor("src/a.ts", ["const first = 1;"], ["const first = 0;"], { atLine: 2 }),
        diffFor("src/a.ts", ["const second = 2;"], ["const second = 0;"], { atLine: 4 }),
      ].join("\n"),
      readText: reader({ "src/a.ts": source }),
      include: INCLUDE,
      checkNames: () => [],
    });
    expect(errors).toEqual([]);
    expect(sites.map((s) => s.tests[0]).sort()).toEqual(["tests/one.test.ts", "tests/two.test.ts"]);
  });

  it("reports a site a `none` exemption governs, rather than exempting the whole file", () => {
    const source = [
      `// ${PIN_MARKER}: none — this block is a data table`,
      "const table = {};",
      `// ${PIN_MARKER}: tests/a.test.ts`,
      "const real = 1;",
    ].join("\n");
    const { errors, excluded, sites } = pinSites({
      diffText: diffFor("src/a.ts", ["const real = 1;"], [], { atLine: 4 }),
      readText: reader({ "src/a.ts": source }),
      include: INCLUDE,
      checkNames: () => [],
    });
    // The exemption covers the lines UNDER IT and stops at the next declaration.
    expect(errors).toEqual([]);
    expect(sites[0].tests).toEqual(["tests/a.test.ts"]);
    expect(excluded).toEqual([]);
  });

  it("reports a deletion that has no position in the new file", () => {
    // A pure deletion is bound to nothing by position, so it is reported rather
    // than silently judged against whatever declaration happens to precede the
    // hunk's empty span.
    const { errors, excluded, sites } = pinSites({
      diffText: deletionFor("src/a.ts", ["const removed = 1;"], 3),
      readText: reader({
        "src/a.ts": [`// ${PIN_MARKER}: tests/a.test.ts`, "const kept = 2;"].join("\n"),
      }),
      include: INCLUDE,
      checkNames: () => [],
    });
    expect(errors).toEqual([]);
    expect(sites).toEqual([]);
    expect(excluded[0].reason).toContain("no position in the new file");
  });

  it("reads a declaration's own line as belonging to that declaration", () => {
    // An off-by-one in the scan bound read the declaration the site sits under as
    // absent — the entire mechanism is a position, so the position is asserted.
    const source = [`// ${PIN_MARKER}: tests/a.test.ts`, "const X = 1;"].join("\n");
    expect(readPinDeclaration(source, 1)?.kind).toBe("tests");
    expect(readPinDeclaration(source, 2)?.names).toEqual(["tests/a.test.ts"]);
    // A line above every declaration has nothing governing it.
    expect(readPinDeclaration(source, 0)).toBeNull();
  });

  it("refuses a declaration with no names at the site it governs", () => {
    const { errors } = pinSites({
      diffText: diffFor("src/a.ts", ["export const X = 1;"]),
      readText: reader({ "src/a.ts": `// ${PIN_MARKER}:   \n` }),
      include: INCLUDE,
    });
    expect(errors.join("\n")).toContain("with no test names");
  });
});
