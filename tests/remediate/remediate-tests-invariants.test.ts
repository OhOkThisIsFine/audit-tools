/**
 * INV-remediate-tests-01: no it() at module scope in test files; describe blocks balanced
 * INV-remediate-tests-02: retired with the multi-artifact contract pipeline
 * INV-remediate-tests-03: duplicated scaffold helpers extracted to a shared module (structural check)
 * INV-remediate-tests-04: no either-or set-membership assertions where a single deterministic outcome is expected
 * INV-remediate-tests-05: retired with the tool-owned quota scheduler (host execution policy is outside the remediation contract)
 * INV-remediate-tests-06: retired (A6 — contracts single-sourced as zod; no JSON schema files)
 * INV-remediate-tests-07: retired artifact roster; executable-plan behavior is tested directly
 * INV-remediate-tests-08: ESM-correct __dirname derivation (fileURLToPath(import.meta.url))
 * INV-remediate-tests-09: no vacuous/placeholder tests (expect(true).toBe(true))
 * INV-remediate-tests-10: no cross-file duplicate test bodies for the same behaviour
 * INV-remediate-tests-11: type-safe fixtures — no as-any on tested inputs
 * INV-remediate-tests-12: no vi.spyOn on the audit-tools/shared re-export barrel (vacuous-pass guard)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __dirname;

function readTestFile(name: string): string {
  return readFileSync(join(TESTS_DIR, name), "utf8");
}

function listTestFiles(): string[] {
  return readdirSync(TESTS_DIR).filter(
    (f) => f.endsWith(".test.ts") || f.endsWith(".test.mjs"),
  );
}

// ── INV-remediate-tests-01 ─────────────────────────────────────────────────

describe("INV-remediate-tests-01: no it() at module scope in test files", () => {
  // A module-scope it() appears as the first non-whitespace token on a line
  // (possibly indented a fixed amount between describe blocks).
  // We detect it() that is NOT preceded by a describe( on the same or a
  // prior line without an intervening }); — by checking for lines that start
  // with optional whitespace then "it(" outside any describe.
  // Simplified heuristic: lines matching /^\s{0,2}it\(/ in .test.ts files that
  // are NOT inside a describe block (detected by scanning the file structurally).
  //
  // We use a simpler check: after the last top-level "});" that closes a
  // describe block, there must be no "  it(" line before the next
  // "describe(" line.

  it("the next-step-*.test.ts files have no module-scope it() calls between describe blocks", () => {
    // The former next-step.test.ts monolith (MNT-86449ec9) was split into
    // focused next-step-*.test.ts files; this guard now spans every shard so a
    // stray module-scope it() in any of them is still caught.
    const shards = listTestFiles().filter((f) => /^next-step-.*\.test\.ts$/.test(f));
    expect(shards.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of shards) {
      const lines = readTestFile(file).split("\n");
      // Track describe( and }); at column 0; flag any "  it(" at 2-space indent
      // while no describe is open (depth === 0).
      let depth = 0;
      let moduleScope = 0;
      for (const line of lines) {
        if (/^describe\(/.test(line)) depth++;
        if (/^\}\);/.test(line) && depth > 0) depth--;
        if (/^  it\(/.test(line) && depth === 0) moduleScope++;
      }
      if (moduleScope > 0) violations.push(`${file}: ${moduleScope} module-scope it()`);
    }
    expect(violations).toEqual([]);
  });

  it("no test file has a bare it() at column 0 (no indentation)", () => {
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      const src = readTestFile(file);
      const matches = src.split("\n").filter((l) => /^it\(/.test(l));
      if (matches.length > 0) violations.push(`${file}: ${matches.length} module-scope it()`);
    }
    expect(violations).toEqual([]);
  });
});

// ── INV-remediate-tests-08 ─────────────────────────────────────────────────

describe("INV-remediate-tests-08: ESM-correct __dirname derivation in .test.ts files", () => {
  // .test.ts files that use __dirname must derive it via fileURLToPath(import.meta.url)
  // rather than relying on an implicit polyfill or global.

  // next-step.test.ts (which used __dirname) was split into next-step-*.test.ts
  // shards (MNT-86449ec9); the shards derive paths from the shared
  // helpers/nextStepHarness module instead of a local __dirname, so they no
  // longer belong in this list.
  const FILES_THAT_USE_DIRNAME = [
    "file-integrity.test.ts",
    "store.test.ts",
    "working-directory-prompts.test.ts",
    "remediate-state-invariants.test.ts",
    "remediate-tests-invariants.test.ts",
    "integration-pipeline.test.ts",
  ];

  for (const file of FILES_THAT_USE_DIRNAME) {
    it(`${file} derives __dirname from fileURLToPath(import.meta.url)`, () => {
      // TST-f95f5162: FILES_THAT_USE_DIRNAME is a deliberate guard manifest. A
      // listed file that has been renamed/removed must FAIL (so the manifest is
      // updated), not pass vacuously via a silent catch-return — otherwise the
      // structural invariant silently stops covering a file it claims to guard.
      let src: string;
      try {
        src = readTestFile(file);
      } catch {
        throw new Error(
          `${file} is listed in FILES_THAT_USE_DIRNAME but no longer exists — ` +
            `update the manifest (a missing guarded file must not be skipped silently).`,
        );
      }
      if (!src.includes("__dirname")) return; // no __dirname usage — OK
      // Must have the ESM-correct pattern
      expect(src).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    });
  }
});

// ── INV-remediate-tests-09 ─────────────────────────────────────────────────

describe("INV-remediate-tests-09: no vacuous placeholder tests", () => {
  // A vacuous placeholder is a test whose only assertion is trivially true.
  // Pattern: expect(true).toBe(true) inside a test body.
  // We skip this invariants file itself (it contains the pattern in comments).

  it("no test file (other than this one) contains a bare expect(true).toBe(true) placeholder", () => {
    const THIS_FILE = "remediate-tests-invariants.test.ts";
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      if (file === THIS_FILE) continue; // skip self-reference
      const src = readTestFile(file);
      // Match the pattern as it would appear in a test body (not in a comment)
      const lines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
      const joined = lines.join("\n");
      if (joined.includes("expect(true).toBe(true)")) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── INV-remediate-tests-03 ─────────────────────────────────────────────────

describe("INV-remediate-tests-03: duplicated scaffold helpers extracted to test-helpers.ts", () => {
  // Shared fixtures (makeState) must live in tests/test-helpers.ts, not be
  // re-declared inline in each test file.  We check:
  //   (a) test-helpers.ts exports makeState
  //   (b) the key consumer files import from test-helpers, not re-define it
  it("test-helpers.ts exists and exports makeState", () => {
    const src = readTestFile("test-helpers.ts");
    expect(src).toMatch(/export function makeState/);
  });

  it("remediate-phases-invariants.test.ts imports makeState from test-helpers (not re-declared)", () => {
    const src = readTestFile("remediate-phases-invariants.test.ts");
    // Must import from test-helpers
    expect(src).toMatch(/from.*test-helpers/);
    // Must NOT define its own makeState (which would be a duplicate)
    const ownDeclarations = src.split("\n").filter(
      (l) => /^function makeState\b/.test(l) || /^const makeState\b/.test(l),
    );
    expect(ownDeclarations).toHaveLength(0);
  });

  it("no test file re-declares a standalone makeState without wrapping the shared test-helpers version", () => {
    // Files may NOT declare makeState if they do NOT import from test-helpers at all.
    // Files that import makeState (or makeBaseState) from test-helpers and then wrap it
    // are acceptable (they add file-specific defaults on top of the shared base).
    // Purely standalone re-implementations are the violation.
    //
    // Known acceptable exceptions:
    //   step-utils.test.ts — has a genuinely different signature (items, blocks) not
    //     compatible with the shared overrides-based API; it is intentionally distinct.
    const KNOWN_EXCEPTIONS = new Set(["step-utils.test.ts"]);
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      if (file === "test-helpers.ts") continue;
      if (KNOWN_EXCEPTIONS.has(file)) continue;
      const src = readTestFile(file);
      const lines = src.split("\n");
      // Check if the file declares any form of a top-level makeState
      const declaresOwn = lines.some((l) =>
        /^function makeState\s*\(/.test(l) || /^const makeState\s*=/.test(l),
      );
      if (!declaresOwn) continue;
      // OK only if it also imports from test-helpers (it's a wrapper)
      const importsFromHelpers = src.includes("./test-helpers");
      if (!importsFromHelpers) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});

// ── INV-remediate-tests-04 ─────────────────────────────────────────────────

describe("INV-remediate-tests-04: no either-or set-membership assertions for deterministic single outcomes", () => {
  // Either-or assertions like `expect(['a','b']).toContain(result)` hide bugs
  // when the function is deterministic (one specific value expected).
  // We detect the `.toContain(someVar)` pattern applied to array literals holding
  // step_kind or status string members.
  //
  // The old integration/closing exceptions now have exact outcome assertions.
  // New either-or assertions must not bring that ambiguity back.

  it("no deterministic outcome assertion accepts an either-or result", () => {
    const THIS_FILE = "remediate-tests-invariants.test.ts";
    // Matches: expect(['...', '...']).toContain( — two or more string items then .toContain(
    const EITHER_OR_PATTERN = /expect\(\s*\[(?:\s*['"][a-z_]+['"]\s*,\s*){1,}['"][a-z_]+['"]\s*\]\s*\)\.toContain\(/;
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      if (file === THIS_FILE) continue; // skip self
      const src = readTestFile(file);
      // Only flag lines that are not inside a comment
      const nonCommentLines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
      if (EITHER_OR_PATTERN.test(nonCommentLines.join("\n"))) {
        violations.push(file);
      }
    }
    expect(violations.sort()).toEqual([]);
  });
});

// INV-remediate-tests-05 retired with the tool-owned quota scheduler. Host
// execution policy is outside the remediation contract.

// INV-remediate-tests-06 retired (A6): the schema-contracts.test.ts structural
// drift-guard it policed is gone — every contract is single-sourced as a zod
// schema now, so there are no hand-authored JSON schema files to bidirectionally
// cover.

// The retired multi-artifact validator roster is replaced by executable-plan
// schema and live-boundary tests in executable-plan-identity/contract-review-independence.

// ── INV-remediate-tests-10 ─────────────────────────────────────────────────

describe("INV-remediate-tests-10: no cross-file duplicate test bodies for same behaviour", () => {
  // Specific known single-owner invariant documented in step-utils.test.ts:
  // classifyFindingRisk → classify-finding-risk.test.ts only
  // These must not have duplicate test describe blocks in other files.

  it("classifyFindingRisk is only directly tested in classify-finding-risk.test.ts", () => {
    const THIS_FILE = "remediate-tests-invariants.test.ts";
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      if (file === "classify-finding-risk.test.ts") continue;
      if (file === THIS_FILE) continue; // skip self — invariant text mentions the name
      const src = readTestFile(file);
      const lines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
      const joined = lines.join("\n");
      if (
        /import.*classifyFindingRisk/.test(joined) &&
        /expect.*classifyFindingRisk/.test(joined)
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── INV-remediate-tests-11 ─────────────────────────────────────────────────

describe("INV-remediate-tests-11: no as-any on tested inputs in fixture helpers", () => {
  it("file-integrity.test.ts mkFinding does not use 'as any' return type", () => {
    const src = readTestFile("file-integrity.test.ts");
    // The function signature must not end with ': any'
    const hasAnyReturn = /function mkFinding\([^)]*\)\s*:\s*any\b/.test(src);
    expect(hasAnyReturn).toBe(false);
  });
});

// ── INV-remediate-tests-12 ─────────────────────────────────────────────────

describe("INV-remediate-tests-12: no vi.spyOn on the audit-tools/shared re-export barrel", () => {
  // Spying a symbol on the `audit-tools/shared` barrel namespace object does NOT
  // intercept a consumer that imported the same symbol directly — the source
  // holds its own bound reference, so the spy records zero calls and any
  // assertion over spy.mock.calls passes VACUOUSLY (a green test that exercises
  // nothing). This bit a cache-reuse test that spied `detectRepoConventions` on
  // the barrel. Verify behaviour through observable output (real files, cache
  // state) or a dependency-injection seam instead. Built-in targets (process.*,
  // console.*) and relative source-module imports (import * as x from "../../src
  // /…") are a different mechanism and are allowed.
  const THIS_FILE = "remediate-tests-invariants.test.ts";

  /** Variables bound to the audit-tools/shared barrel as a full namespace object. */
  function barrelNamespaceVars(src: string): string[] {
    const names = new Set<string>();
    // `const NS = await import("audit-tools/shared…")` — a `{`-destructure never
    // matches (no identifier after `const`), so only namespace bindings are caught.
    for (const m of src.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']audit-tools\/shared/g,
    )) {
      names.add(m[1]);
    }
    // `import * as NS from "audit-tools/shared…"`
    for (const m of src.matchAll(
      /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']audit-tools\/shared/g,
    )) {
      names.add(m[1]);
    }
    return [...names];
  }

  function barrelSpyViolations(src: string): string[] {
    const nonComment = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    return barrelNamespaceVars(nonComment).filter((name) =>
      new RegExp(`vi\\.spyOn\\(\\s*${name}\\b`).test(nonComment),
    );
  }

  it("the detector flags a barrel-namespace spy but not destructures / relative-module spies (non-vacuous self-check)", () => {
    const bad = [
      'const sharedModule = await import("audit-tools/shared");',
      'const spy = vi.spyOn(sharedModule, "detectRepoConventions");',
    ].join("\n");
    expect(barrelSpyViolations(bad)).toEqual(["sharedModule"]);

    const clean = [
      'const { detectRepoConventions } = await import("audit-tools/shared");',
      'import * as scheduler from "../../src/shared/dispatch/ownershipScheduler.js";',
      'const s = vi.spyOn(scheduler, "ownershipSubWaves");',
      'const e = vi.spyOn(process.stderr, "write");',
    ].join("\n");
    expect(barrelSpyViolations(clean)).toEqual([]);
  });

  function scanBarrelSpies(root: string): string[] {
    const violations: string[] = [];
    function visit(directory: string): void {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { visit(file); continue; }
        if (file === `remediate/${THIS_FILE}` || !/\.test\.(?:ts|mjs)$/.test(file)) continue;
        for (const name of barrelSpyViolations(readFileSync(join(root, file), "utf8"))) {
          violations.push(`${file}: vi.spyOn(${name}, …)`);
        }
      }
    }
    visit("");
    return violations;
  }

  it("finds barrel spies in audit, remediation and nested shared tests", () => {
    const root = mkdtempSync(join(tmpdir(), "barrel-scope-"));
    try {
      const bad = 'import * as ns from "audit-tools/shared";\nvi.spyOn(ns, "someExport");\n';
      for (const area of ["audit", "remediate", "shared/nested"]) {
        mkdirSync(join(root, area), { recursive: true });
        writeFileSync(join(root, area, "bad.test.ts"), bad);
      }
      expect(scanBarrelSpies(root)).toEqual([
        "audit/bad.test.ts: vi.spyOn(ns, …)",
        "remediate/bad.test.ts: vi.spyOn(ns, …)",
        "shared/nested/bad.test.ts: vi.spyOn(ns, …)",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no test file spies on the audit-tools/shared barrel namespace", () => {
    expect(scanBarrelSpies(dirname(TESTS_DIR))).toEqual([]);
  });
});
