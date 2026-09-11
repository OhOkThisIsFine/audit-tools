// The comment-reconciliation leg.
//
// WHY THIS EXISTS. `check:doc-code-citations` gates DOCS and `check:doc-links`
// gates LINKS; COMMENTS were gated by nothing. So a comment could name a symbol,
// a workflow shape or an enumeration the code had already changed and every gate
// stayed green — the 2026-08-31 finding: `src/shared/continuityScore.ts`'s header
// claimed audit "re-exports `computeContinuityScores` … and biases review-packet
// ORDERING with it" while `grep` over `src/audit` found no consumer at all, and
// `findingsEnvelopeExample`'s doc comment named a "combined" pass that exists
// nowhere in the tree. Both were found by a doc-review lane reading code to check
// a DOC — the same class of check this file automates, weeks after the fact.
//
// WHAT IS ENFORCED. One decidable half of "a comment is reconciled against the
// code it describes": a comment that cites a backticked SYMBOL must cite one that
// is declared somewhere in the tree. That is a rename/deletion check, and it is
// mechanical.
//
// WHAT IS NOT, stated precisely rather than as "nothing could notice". NO TEXT
// RULE reaches a comment stating a workflow SHAPE — which pass runs first, how
// many lanes exist — because it names no identifier; the two comments that
// survived P50's fix are of exactly that class and were reconciled by editing
// them, not by this gate. And the recognizer carries a same-file rule of its own
// (see its doc comment in tests/helpers/recognizers.ts): a symbol that ALSO
// appears as a NON-comment token in the same file is not checked, because a
// comment referencing the symbol its own file declares is self-evidencing and
// needs no cross-tree lookup. The `computeContinuityScores` case is exactly that
// shape — the name survived in `src/shared/continuityScore.ts`'s own code, so the
// recognizer skipped it and this gate would not have caught it either. Both
// halves are declared on the guard's row in scripts/guard-reach-data.mjs rather
// than implied here; `check:conceptual-category-comment-drift` covers the
// enumeration class separately.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// INV-WH: never a raw child_process entry point in a test file — a windowless
// parent spawning a console child flashes a window on win32.
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { backtickedSymbolsInComments } from "../helpers/recognizers.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** Every file whose COMMENT this guard reads — the modules that carry prose about code. */
function scannedFiles(): string[] {
  return execFileSyncHidden("git", ["ls-files", "src/**/*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(".test."));
}

/**
 * Every identifier the tree DECLARES, from every source file — including the
 * `scripts/` and `tests/` trees, because a comment legitimately cites a helper
 * that lives there.
 *
 * DECLARED, not EXPORTED. A comment naturally names the private helper in the
 * module it sits beside (`withFoldAdvisories`, `designReviewPassState`), and
 * demanding `export` would red those — the check is "does this name still exist
 * in the tree", and a module-local declaration answers it. That rule is also
 * what excludes the host-global class (`setInterval`, `structuredClone`) and the
 * module-filename class (`auditToolsPaths`, `reviewPackets`): none of them is
 * ever a declaration, so no host-global or module-noun list is needed.
 *
 * The set also carries every STRING LITERAL the tree contains, because some
 * names this repo genuinely owns are string VALUES rather than identifiers — an
 * environment variable (`AUDIT_TOOLS_CALLER_CWD`, declared as
 * `AUDIT_TOOLS_CALLER_CWD_ENV = "AUDIT_TOOLS_CALLER_CWD"`) is the case that
 * proved it. A name the code still passes around is not a dangling citation.
 */
function declaredSymbols(): Set<string> {
  // EVERY tracked source file, not a tree list: the resolution universe must be
  // wider than the scan set, or a comment citing a hook helper
  // (`.claude/hooks/*.mjs`) or a script would red for naming something real.
  const files = execFileSyncHidden("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(line));
  const names = new Set<string>();
  // DECLARATIONS — a binding, a type, a function, a class.
  const DECLARATION = new RegExp(
    String.raw`\b(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)`,
    "g",
  );
  // FIELD/MEMBER NAMES — `forceReplan?: boolean`, `extraFields: {`, `{ risk: 1 }`.
  // A comment legitimately names a field rather than a binding ("the
  // `forceReplan` option"), and demanding a declaration would red those. Keyed
  // on the `name:` / `name?:` shape inside a type body or object literal.
  const MEMBER = new RegExp(String.raw`^\s*([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:`, "gm");
  // STATIC MEMBER ACCESS — `process.env.AUDIT_TOOLS_CHILD_SESSION`,
  // `z.ZodType`. An environment variable is passed around as a member, never
  // declared as an identifier, and a comment telling an operator about one is
  // naming something the code really does read.
  const MEMBER_ACCESS = new RegExp(String.raw`\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g");
  // Double- and single-quoted only: a template literal's contents are prose as
  // often as they are a name, and including them re-admits the module-noun class.
  const STRING_LITERAL = new RegExp(String.raw`["']([A-Za-z_$][A-Za-z0-9_$]*)["']`, "g");
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of source.matchAll(DECLARATION)) names.add(match[1]);
    for (const match of source.matchAll(MEMBER)) names.add(match[1]);
    for (const match of source.matchAll(MEMBER_ACCESS)) names.add(match[1]);
    for (const match of source.matchAll(STRING_LITERAL)) names.add(match[1]);
    // A MODULE's basename is how prose cites it (`reviewPacketShared`,
    // `fsIntake`), and a module is a thing the tree really does have — so it
    // belongs in the resolution set rather than in an exclusion list. `index`
    // is dropped: it is a generic word that would swallow real drift.
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.(ts|mjs|cjs|js)$/, "");
    if (base !== "index" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(base)) names.add(base);
  }
  return names;
}

describe("a comment citing a backticked symbol cites one the tree exports", () => {
  it("no src comment names a symbol that exists nowhere in the tree", () => {
    const declared = declaredSymbols();
    const offenders = scannedFiles().flatMap((file) =>
      backtickedSymbolsInComments(readFileSync(join(REPO_ROOT, file), "utf8"))
        .filter((hit) => !declared.has(hit.symbol))
        .map((hit) => `${file}:${hit.line}  \`${hit.symbol}\`\n    ${hit.text}`),
    );
    expect(
      offenders,
      offenders.length
        ? `A comment cites a symbol the tree does not export — the code it describes moved,\n` +
            `was renamed, or was deleted, and comments are gated by nothing. Either re-point the\n` +
            `comment at what the code does now, or drop the claim:\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([]);
  });

  // The recognizer is only worth its exclusions if they are the reason the scan
  // is quiet — a recognizer that returned nothing would pass the case above for
  // the wrong reason. These pin both directions on text, not on this repo.
  describe("the recognizer's shape rules", () => {
    it("finds a camelCase symbol and an ALL_CAPS constant on comment lines", () => {
      const source = [
        "// the reader is `renderConceptualReviewPrompt` and the set is `CONCEPTUAL_FINDING_CATEGORIES`",
        "* and `auditToolsPaths` is a module",
        "export const unrelated = 1;",
      ].join("\n");
      const hits = backtickedSymbolsInComments(source).map((hit) => hit.symbol);
      expect(hits).toEqual(["renderConceptualReviewPrompt", "CONCEPTUAL_FINDING_CATEGORIES", "auditToolsPaths"]);
    });

    it("skips code lines, lower-case prose words, built-ins, and non-identifier forms", () => {
      const source = [
        "const x = `renderConceptualReviewPrompt`; // on a CODE line, not a comment",
        "// prose `findings`, `state` and `done` are words, not citations",
        // A call-shaped example in prose is not a citation: the token has to be
        // a BARE identifier to be a symbol this tree could look up. The doc
        // gate's spec leg shipped this shape rule prefix-anchored and reported
        // `writeContractArtifact(...)` as a dangling symbol, so the two legs
        // share one fully-anchored spelling rule; the call forms are rejected
        // here by the bare-identifier rule and in the spec leg by the anchor.
        "// prose `quotedCall()`, `member.path()` and `keyed.value` are syntax, not citations",
        "// JS built-ins `NaN`/`RangeError`, errno `ENOENT`/`ENOBUFS`, device `COM1` — none a symbol",
        "// a path `src/foo/bar.ts`, a member `x.reviewPackets`, and a call `thing()` are not symbols",
      ].join("\n");
      expect(backtickedSymbolsInComments(source)).toEqual([]);
    });

    // This rule has a named residual, and this case is it: the file header's
    // claim that "nothing was in a position to notice" the
    // `computeContinuityScores` case is FALSE, because the recognizer skips a
    // name its own file's code mentions. The symbol survived as a declaration
    // in `src/shared/continuityScore.ts` while the header above it described
    // wiring that no longer existed — so the skip is exactly why this gate
    // would not have caught it, in the same way the shape class is.
    it("skips a name the file's own CODE mentions — self-evidencing, no lookup needed", () => {
      const source = [
        "// see `localHelper` for the shape",
        "function localHelper() {}",
      ].join("\n");
      expect(backtickedSymbolsInComments(source)).toEqual([]);
    });

    it("skips a DECLARED symbol whose comment describes deleted WIRING — the continuityScore shape", () => {
      const source = [
        "// audit re-exports `computeContinuityScores` and biases packet ordering with it",
        "export function computeContinuityScores() {}",
      ].join("\n");
      expect(backtickedSymbolsInComments(source)).toEqual([]);
      // The other half, so the case above cannot pass for the wrong reason: the
      // SAME comment line, once the file no longer declares the name, IS reported.
      expect(
        backtickedSymbolsInComments(
          "// audit re-exports `computeContinuityScores` and biases packet ordering with it",
        ).map((hit) => hit.symbol),
      ).toEqual(["computeContinuityScores"]);
    });

    it("reports a name regardless of whether it resolves — resolution is the caller's rule", () => {
      const source = "// see `goneForever` for the shape";
      const hits = backtickedSymbolsInComments(source);
      expect(hits.map((h) => h.symbol)).toEqual(["goneForever"]);
      expect(hits.map((h) => h.line)).toEqual([1]);
    });
  });
});
