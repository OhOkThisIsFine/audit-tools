/**
 * Test-scratch-root guard (CP-NODE-24 / test-harness-hermeticity inv-2).
 *
 * A test suite's scratch tree must be rooted OFF the repo tree, per invocation —
 * `scratchDir()` in `tests/helpers/scratch.ts` is the one constructor that does
 * that, and `createNextStepHarness` routes every next-step suite through it.
 *
 * The hazard this guard exists to make unrepresentable: a suite rooting its
 * scratch tree at its OWN directory —
 * `join(dirname(fileURLToPath(import.meta.url)), ".test-something")` — puts a
 * directory that is created and recursively deleted on every single test INSIDE
 * `tests/`. The INV-WH raw-spawn scanner (`shared-tests-invariants.test.mjs`)
 * WALKS that tree, so a concurrently-running suite races the walk into a
 * mid-scan ENOENT, and two concurrent `vitest run` invocations share the
 * directory outright.
 *
 * WHY A GUARD AND NOT A COMMENT. `nextStepHarness.ts` has documented this hazard
 * in prose for as long as the harness has existed, and `friction-capture-closeout`
 * carried the in-tree pattern anyway — a future author copy-pasting from any
 * neighbouring file gets whichever precedent they happened to open. The rule is
 * therefore mechanical, and it holds across the ORDINARY ways the shape gets
 * written: `join` or `resolve`, aliased or member-qualified, quoted or backticked,
 * on one line or several, through an alias chain, with spread arguments, or as a
 * `${ownDir}/name` template — and across BOTH spellings of the own directory,
 * the modern `import.meta.dirname` and the older
 * `dirname(fileURLToPath(import.meta.url))` family. Those forms are covered
 * because they are what a real author reaches for, not because an adversary
 * might.
 *
 * SCOPE, STATED — this guard is a DETECTOR, not a proof.
 *
 *   1. It catches the IN-TREE root, the hazard the module contract names. It
 *      deliberately does NOT flag `mkdtemp(join(tmpdir(), …))`, which is
 *      off-tree and per-invocation and therefore safe.
 *
 *   2. SEMANTIC GAP: a FIXED off-tree root — `join(tmpdir(), "audit-tools-tests",
 *      ".some-name")` with no `mkdtemp` — is off-tree but SHARED between
 *      concurrent invocations, defect (b) in `tests/helpers/scratch.ts`'s own
 *      header. Not flagged. `tests/remediate/cp-node-1-regressions.test.ts:97`
 *      is one such root today. Different property (per-invocation isolation,
 *      not tree residue), not enforced here.
 *
 *   3. SYNTACTIC GAP: this matches SOURCE TEXT, not a parsed program. What
 *      remains out of reach is what text cannot see — a root assembled through
 *      a helper function or a class, a directory name built by concatenation or
 *      returned by a call rather than written as a literal, or a path-call
 *      reached through a namespace import re-exported under another name. A
 *      determined author can still get an in-tree root past this; an ordinary
 *      one cannot get one past it by accident, which is the property being
 *      bought. Closing gap 3 means parsing TypeScript, not a longer regex.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

/**
 * Where `scratchDir`'s real implementation lives. READ-ONLY REFERENCE: this
 * guard locates the owner to exempt it and to prove it still exists; it never
 * modifies it. Exempt because the owner is allowed — required, in fact — to do
 * the path arithmetic every other file must delegate to it.
 */
const SCRATCH_ROOT_OWNER = "tests/helpers/scratch.ts";

const SCAN_ROOT = "tests";
const CODE_FILE_RE = /\.(?:[cm]?[jt]s)$/;
const SKIP_DIR_NAMES = new Set<string>(["node_modules", "dist", "fixtures"]);

/**
 * A scratch-root LITERAL: the `.test-*` convention this repo uses for suite
 * scratch trees, or a name that says scratch/tmp/temp outright. Anchored at both
 * ends on purpose — `join(__dirname, "..", "..")` (walking to the repo root to
 * READ a source file) and `join(repoRoot, "tests")` are ubiquitous and
 * legitimate, and a prefix match would flag `"tmp.json"` and `"tests"` too.
 */
const SCRATCH_NAME_RE = /^(?:\.test[\w-]*|\.?(?:scratch|tmp|temp)[\w-]*)$/i;

/**
 * Blank out comments while PRESERVING every offset and newline, so a match's
 * line number is still exact against the original text. Comments are prose —
 * this guard's own header quotes the shape it forbids — but stripping them by
 * line, as the first draft did, misses a comment that opens mid-line and, worse,
 * cannot see a call that spans lines.
 */
function blankComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else {
        if (c === "'" || c === '"' || c === "`") state = c;
        out += c;
        i += 1;
      }
      continue;
    }
    if (state === "line") {
      if (c === "\n") state = "code";
      out += c === "\n" ? c : " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    // Inside a string: content is PRESERVED (the scratch literal is an argument).
    if (c === "\\") {
      out += c + (next ?? "");
      i += 2;
      continue;
    }
    if (c === state) state = "code";
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The two spellings of "this module's own location".
 *
 * `import.meta.dirname` (Node >= 20.11) is the MODERN one and already the idiom
 * in most of this tree; the `fileURLToPath(import.meta.url)` family is the older
 * one. Keying only on the older literal — as the first widened draft did — left
 * the modern spelling invisible in all three positions (bound, inline, aliased),
 * and the alias fixpoint never even got a seed to walk from.
 */
const OWN_DIR_TOKENS = ["import.meta.dirname", "import.meta.url"] as const;

/** Whether some text refers to this module's own location by either spelling. */
function mentionsOwnDirToken(text: string): boolean {
  return OWN_DIR_TOKENS.some((token) => text.includes(token));
}

/**
 * Whether an assignment's right-hand side evaluates to the own DIRECTORY.
 *
 * `import.meta.dirname` IS the directory, so it needs no wrapper. The URL form
 * does: bare `fileURLToPath(import.meta.url)` is the FILE, and only
 * `dirname(...)` or `new URL(".", ...)` around it makes it the directory — so
 * the file form is deliberately not seeded.
 */
function isOwnDirExpression(rhs: string): boolean {
  if (rhs.includes("import.meta.dirname")) return true;
  return (
    rhs.includes("import.meta.url") &&
    (rhs.includes("dirname") || rhs.includes("new URL"))
  );
}

/**
 * Names that denote the FILE'S OWN DIRECTORY.
 *
 * Matching the NAME rather than a fixed spelling is what stops a rename from
 * walking around the guard, and the alias chain is followed to a FIXPOINT so
 * `const B = A; const C = B;` is no more of an escape than `const B = A`.
 * `__dirname` is included unconditionally: in CJS it IS the own directory with
 * no binding to find, and in ESM it is already bound by the rule above.
 */
function ownDirNames(source: string): Set<string> {
  const names = new Set<string>(["__dirname"]);
  const assignment = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  const pending: Array<{ name: string; rhs: string }> = [];
  for (const match of source.matchAll(assignment)) {
    const name = match[1]!;
    const rhs = match[2]!.replace(/\s+/g, " ").trim();
    if (isOwnDirExpression(rhs)) {
      names.add(name);
    } else {
      pending.push({ name, rhs });
    }
  }
  // Alias hops to a fixpoint: `const B = A;`
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, rhs } of pending) {
      if (names.has(name)) continue;
      if (/^[A-Za-z_$][\w$]*$/.test(rhs) && names.has(rhs)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/**
 * Regexes in THIS file are built from strings rather than written as regex
 * literals whenever they need a quote character.
 *
 * `blankComments` tracks string state by scanning characters, and a regex
 * LITERAL containing `"` / `'` / a backtick desynchronizes it — the scanner
 * enters a string it never left, and a later `//` stops being seen as a comment.
 * That produced a FALSE RED against this guard's own source, which is the worse
 * failure: a guard that cries wolf gets switched off. Telling a regex literal
 * from a division needs a parser, so the file simply does not write one.
 */
const PATH_IMPORT_RE = new RegExp(
  "import\\s*\\{([^}]*)\\}\\s*from\\s*[\"'](?:node:)?path[\"']",
  "g",
);
const STRING_LITERAL_RE = new RegExp(
  ['"([^"]*)"', "'([^']*)'", "`([^`$]*)`"].join("|"),
  "g",
);

/** Local names that call into a path builder — `join`/`resolve` and any alias. */
function pathCallNames(source: string): Set<string> {
  const names = new Set<string>(["join", "resolve"]);
  for (const match of source.matchAll(PATH_IMPORT_RE)) {
    for (const clause of match[1]!.split(",")) {
      const alias = /^\s*(join|resolve)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(clause);
      if (alias) names.add(alias[2]!);
    }
  }
  return names;
}

/**
 * Text of a call's argument list, given the index of its opening paren.
 *
 * CAPPED. An unbalanced scan — which a mis-parse can always produce, since this
 * reads text and not a program — would otherwise run to end-of-file and sweep
 * every literal in the module into one call's "arguments". The cap turns that
 * failure into a miss instead of a false accusation.
 */
const MAX_ARGUMENT_SPAN = 2_000;

function argumentText(source: string, openParen: number): string {
  let depth = 0;
  let quote: string | undefined;
  const limit = Math.min(source.length, openParen + MAX_ARGUMENT_SPAN);
  for (let i = openParen; i < limit; i++) {
    const c = source[i]!;
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  // Never closed within the cap: report nothing rather than everything.
  return "";
}

/** Every string literal (quoted or backticked) appearing in some argument text. */
function stringLiterals(args: string): string[] {
  return [...args.matchAll(STRING_LITERAL_RE)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
}

export interface ScratchRootOffense {
  line: number;
  text: string;
}

/**
 * Find in-tree scratch-root constructions in one file's SOURCE TEXT.
 *
 * A pure function of the text on purpose: `fail-1` is about a FUTURE file
 * copying the retired pattern, so the mechanism has to be provable against
 * source that does not exist on disk. A test that could only demonstrate the
 * guard by pointing at the one file this module fixed would prove nothing about
 * the next one.
 *
 * The rule is deliberately NOT positional. Rather than "argument 1 is the own
 * dir and argument 2 is the name", it asks whether a path call's ARGUMENTS
 * mention the own directory AND a scratch-shaped name. Positional matching is
 * what let `join(...[HERE, ".test-x"])`, a multi-line call, and an extra
 * intervening argument all walk straight past the first draft.
 */
export function findInTreeScratchRoots(source: string): ScratchRootOffense[] {
  const code = blankComments(source);
  const ownDirs = ownDirNames(code);
  const callNames = pathCallNames(code);
  const lineOf = (offset: number): number =>
    code.slice(0, offset).split("\n").length;
  const snippet = (offset: number): string =>
    code
      .slice(offset, offset + 160)
      .split("\n")
      .map((part) => part.trim())
      .join(" ")
      .trim();

  const offenses: ScratchRootOffense[] = [];
  const seen = new Set<number>();

  // (1) A path call whose arguments name the own directory and a scratch name.
  //     `(?:[\w$]+\.)?` admits `path.join(` / `nodePath.resolve(` alongside the
  //     bare and aliased forms.
  const callRe = new RegExp(
    `\\b(?:[A-Za-z_$][\\w$]*\\.)?(?:${[...callNames].join("|")})\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(callRe)) {
    // `Promise.resolve(` is not a path builder; the member-prefix branch would
    // otherwise adopt it.
    if (match[0].startsWith("Promise.")) continue;
    const openParen = match.index! + match[0].length - 1;
    const args = argumentText(code, openParen);
    const mentionsOwnDir =
      // Inline, either spelling: a path call taking the own-directory token
      // DIRECTLY as an argument has no binding at all, so the name set below
      // would never see it. (Spelling the shape out here would trip
      // INV-shared-tests-08, which scans comments too — deliberately.)
      mentionsOwnDirToken(args) ||
      [...ownDirs].some((name) =>
        new RegExp(`(?:^|[^\\w$.])${name}(?![\\w$])`).test(args),
      );
    if (!mentionsOwnDir) continue;
    if (!stringLiterals(args).some((literal) => SCRATCH_NAME_RE.test(literal))) {
      continue;
    }
    if (seen.has(match.index!)) continue;
    seen.add(match.index!);
    offenses.push({ line: lineOf(match.index!), text: snippet(match.index!) });
  }

  // (2) The template form, which is no path call at all: `${HERE}/.test-x`.
  //     Bindings AND the inline spellings, so `${import.meta.dirname}/.test-x`
  //     is caught with no binding to find.
  const templateBases = [
    ...ownDirs,
    ...OWN_DIR_TOKENS.map((token) => token.replace(/\./g, "\\.")),
  ];
  for (const name of templateBases) {
    const templateRe = new RegExp(
      "`\\$\\{\\s*" + name + "\\s*\\}([^`]*)`",
      "g",
    );
    for (const match of code.matchAll(templateRe)) {
      const tail = match[1]!.replace(/^[/\\]+/, "").split(/[/\\]/)[0] ?? "";
      if (!SCRATCH_NAME_RE.test(tail)) continue;
      if (seen.has(match.index!)) continue;
      seen.add(match.index!);
      offenses.push({ line: lineOf(match.index!), text: snippet(match.index!) });
    }
  }

  return offenses.sort((a, b) => a.line - b.line);
}

/** Recursively collect code files under `dir`, as repo-relative "/" paths. */
function listCodeFiles(dir: string, rel: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    // A scratch tree that leaked into the repo is exactly what this guard is
    // about; never descend into one and report its contents as source.
    if (entry.name.startsWith(".test-")) continue;
    const abs = join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listCodeFiles(abs, relPath, out);
    else if (CODE_FILE_RE.test(entry.name)) out.push(relPath);
  }
  return out;
}

const files = listCodeFiles(join(repoRoot, SCAN_ROOT), SCAN_ROOT, []);

describe("test-scratch-root guard — scratch trees live off-tree, per invocation", () => {
  it("ANTI-VACUITY: the scan reads a plausible tree", () => {
    // An empty offender list means nothing if the walk read nothing. Assert the
    // scan found files, reached both suite directories, and reached its OWN
    // file — the one member it can name with certainty.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith("tests/remediate/"))).toBe(true);
    expect(files.some((f) => f.startsWith("tests/shared/"))).toBe(true);
    expect(files).toContain("tests/shared/test-scratch-root-guard.test.ts");
  });

  it("the scratchDir owner still exists and still owns scratchDir (honesty check)", () => {
    // The exemption below is only sound while the owner is real. A moved or
    // renamed owner must fail here rather than sit as a silent hole.
    const ownerPath = join(repoRoot, SCRATCH_ROOT_OWNER);
    expect(existsSync(ownerPath)).toBe(true);
    expect(readFileSync(ownerPath, "utf8")).toContain("export function scratchDir");
  });

  it("no suite roots its scratch tree at its own directory (in-tree)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SCRATCH_ROOT_OWNER) continue;
      const source = readFileSync(join(repoRoot, file), "utf8");
      for (const offense of findInTreeScratchRoots(source)) {
        offenders.push(`${file}:${offense.line}: ${offense.text}`);
      }
    }
    expect(
      offenders,
      "in-tree scratch root(s) found. A directory created and rm -rf'd on every " +
        "test must not live under tests/: the INV-WH raw-spawn scanner walks " +
        "that tree and races the churn into a mid-scan ENOENT, and two " +
        "concurrent vitest invocations share it. Use scratchDir(name) from " +
        "tests/helpers/scratch.ts (or createNextStepHarness, which routes " +
        "through it):\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  // ── fail-1: a FUTURE file copying the retired pattern ────────────────────
  //
  // Proven against synthetic source, never against the one suite this module
  // fixed: the hazard named by the failure mode is the NEXT file, so a
  // demonstration that depends on this file's content would expire the moment
  // it was fixed — which is now.
  describe("fail-1: the mechanism catches a future suite that copy-pastes the retired pattern", () => {
    // Fixture source is ASSEMBLED, never spelled contiguously, so the offending
    // shape never appears as literal text in this file and the tree scan above
    // can therefore cover its OWN file. A scanner that has to exempt itself has
    // a hole exactly where its author is standing — and the first draft of this
    // guard proved it by flagging these very fixtures.
    const CALL = "join";
    const OWN_DIR_EXPR = "dirname(fileURLToPath(import.meta.url))";
    const OWN_DIR_META = "import.meta.dirname";
    const bindOwnDir = (name: string): string =>
      `const ${name} = ${OWN_DIR_EXPR};`;
    const rootAt = (
      base: string,
      literal: string,
      call: string = CALL,
      quote = '"',
    ): string => `const TEST_DIR = ${call}(${base}, ${quote}${literal}${quote});`;

    it("flags the bound form a copy-paste of the old suite produces", () => {
      const hypothetical = [
        `import { dirname, ${CALL} } from "node:path";`,
        bindOwnDir("HERE"),
        rootAt("HERE", ".test-some-new-suite"),
      ].join("\n");
      const offenses = findInTreeScratchRoots(hypothetical);
      expect(offenses).toHaveLength(1);
      expect(offenses[0]!.line).toBe(3);
    });

    it("flags the inline form, and the binding's NAME is not a way around it", () => {
      expect(findInTreeScratchRoots(rootAt(OWN_DIR_EXPR, ".test-inline"))).toHaveLength(
        1,
      );
      // Renaming HERE to anything else must not help: a binding is matched by
      // what it is ASSIGNED, not by what it is called.
      const renamed = [
        bindOwnDir("somethingElse"),
        rootAt("somethingElse", ".test-renamed"),
      ].join("\n");
      expect(findInTreeScratchRoots(renamed)).toHaveLength(1);
    });

    // The ORDINARY fresh-write shapes. Every one of these walked past the first
    // draft of the detector, which matched a single line, `join` only, a quoted
    // literal only, positionally, through exactly one binding. None of them is
    // exotic — they are what an author reaches for without thinking about this
    // guard at all, which is precisely why the guard has to reach them.
    it.each([
      [
        "alias re-binding chain",
        [
          bindOwnDir("A"),
          "const B = A;",
          "const C = B;",
          rootAt("C", ".test-chain"),
        ].join("\n"),
      ],
      [
        "resolve() instead of join()",
        [bindOwnDir("HERE"), rootAt("HERE", ".test-resolve", "resolve")].join("\n"),
      ],
      [
        "backtick literal",
        [bindOwnDir("HERE"), rootAt("HERE", ".test-backtick", CALL, "`")].join("\n"),
      ],
      [
        "template interpolation, no path call at all",
        [
          bindOwnDir("HERE"),
          "const TEST_DIR = `" + "$" + "{HERE}/.test-template`;",
        ].join("\n"),
      ],
      [
        "CJS __dirname, with no binding to find",
        rootAt("__dirname", ".test-cjs"),
      ],
      [
        "aliased import of join",
        [
          `import { ${CALL} as pj } from "node:path";`,
          bindOwnDir("HERE"),
          rootAt("HERE", ".test-aliased", "pj"),
        ].join("\n"),
      ],
      [
        "multi-line call",
        [
          bindOwnDir("HERE"),
          `const TEST_DIR = ${CALL}(`,
          "  HERE,",
          `  ".test-multiline",`,
          ");",
        ].join("\n"),
      ],
      [
        "spread-array arguments",
        [
          bindOwnDir("HERE"),
          `const TEST_DIR = ${CALL}(...[HERE, ".test-spread"]);`,
        ].join("\n"),
      ],
      [
        "member-qualified path.join",
        [bindOwnDir("HERE"), rootAt("HERE", ".test-member", `path.${CALL}`)].join(
          "\n",
        ),
      ],
      // The MODERN own-directory spelling. Node >= 20.11 makes the whole
      // dirname(fileURLToPath(…)) dance unnecessary, and most of this tree
      // already writes it this way — so a detector that only knows the older
      // spelling is blind to the form new code actually uses.
      [
        "import.meta.dirname, bound",
        [`const HERE = ${OWN_DIR_META};`, rootAt("HERE", ".test-meta-bound")].join(
          "\n",
        ),
      ],
      [
        "import.meta.dirname, aliased through a chain",
        [
          `const A = ${OWN_DIR_META};`,
          "const B = A;",
          rootAt("B", ".test-meta-chain"),
        ].join("\n"),
      ],
      [
        "import.meta.dirname, inline with no binding",
        rootAt(OWN_DIR_META, ".test-meta-inline"),
      ],
      [
        "import.meta.dirname in a template",
        "const TEST_DIR = `" + "$" + `{${OWN_DIR_META}}/.test-meta-template\`;`,
      ],
    ])("flags the %s shape", (_name, fixture) => {
      expect(findInTreeScratchRoots(fixture).length).toBeGreaterThan(0);
    });

    it("does NOT flag the legitimate uses that share the same building blocks", () => {
      // Walking to the repo root to READ a source file is ubiquitous and fine.
      const readingSource = [
        bindOwnDir("__dirname"),
        `const repoRoot = ${CALL}(__dirname, "..", "..");`,
        `const src = ${CALL}(__dirname, "..", "..", "src", "nextStep.ts");`,
      ].join("\n");
      expect(findInTreeScratchRoots(readingSource)).toEqual([]);
      // Off-tree per-invocation roots are the CORRECT pattern, not an offense.
      const correct = [
        `const TEST_DIR = scratchDir(".test-some-suite");`,
        `const harness = createNextStepHarness(".test-some-suite");`,
        `const dir = await mkdtemp(${CALL}(tmpdir(), "some-suite-"));`,
      ].join("\n");
      expect(findInTreeScratchRoots(correct)).toEqual([]);
      // Prose quoting the pattern (this guard's own header does) is not code.
      expect(
        findInTreeScratchRoots(`// ${rootAt("HERE", ".test-x")} — the retired form`),
      ).toEqual([]);
    });
  });

  // ── inv-3: one precedent in tests/remediate/, not two ────────────────────
  it("inv-3: every scratch-rooting suite under tests/remediate/ uses the same off-tree constructor", () => {
    const remediateSuites = files.filter(
      (file) => file.startsWith("tests/remediate/") && file.endsWith(".test.ts"),
    );
    expect(remediateSuites.length).toBeGreaterThan(10);
    const contradictory: string[] = [];
    for (const file of remediateSuites) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      if (findInTreeScratchRoots(source).length > 0) contradictory.push(file);
    }
    expect(
      contradictory,
      "a suite here roots its scratch tree in-tree while every sibling roots it " +
        "off-tree — two contradictory precedents in one directory means a future " +
        "author copy-pasting from a neighbour gets a coin flip:\n" +
        contradictory.join("\n"),
    ).toEqual([]);
  });
});

// ── fail-2: the unset-env fallback is off-tree, and stays that way ─────────
describe("fail-2: scratchDir's AUDIT_TOOLS_TEST_RUN_ROOT fallback is off-tree", () => {
  it("falls back to an OS-temp mkdtemp root, never to the repo tree", async () => {
    // Read-only reference: this behaviour is READ from tests/helpers/scratch.ts,
    // never modified. A bare `node` script importing scratch.ts outside vitest's
    // global-setup gets no AUDIT_TOOLS_TEST_RUN_ROOT — and the degradation must
    // be to a private temp dir, not to an in-tree default, or the fix this
    // module lands would be undone by its own fallback.
    const { scratchDir, TEST_RUN_ROOT_ENV } = await import("../helpers/scratch.js");
    const previous = process.env[TEST_RUN_ROOT_ENV];
    delete process.env[TEST_RUN_ROOT_ENV];
    try {
      const fallback = scratchDir(".test-unset-env-probe");
      expect(fallback.startsWith(join(repoRoot, "tests"))).toBe(false);
      expect(fallback).toContain("audit-tools-tests-orphan-");
    } finally {
      if (previous === undefined) delete process.env[TEST_RUN_ROOT_ENV];
      else process.env[TEST_RUN_ROOT_ENV] = previous;
    }
  });
});
