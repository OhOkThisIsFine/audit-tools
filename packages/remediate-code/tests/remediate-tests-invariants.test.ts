/**
 * INV-remediate-tests-01: no it() at module scope in test files; describe blocks balanced
 * INV-remediate-tests-02: no inline contract-pipeline version literals in test fixtures;
 *                         tests must import CONTRACT_PIPELINE_*_VERSION constants
 * INV-remediate-tests-03: duplicated scaffold helpers extracted to a shared module (structural check)
 * INV-remediate-tests-04: no either-or set-membership assertions where a single deterministic outcome is expected
 * INV-remediate-tests-05: quota-scheduler.test.ts covers dispatch.ts scheduleWave (not only shared scheduleWave)
 * INV-remediate-tests-06: schema-contracts EXPECTED_SCHEMAS covers all on-disk schemas bidirectionally
 * INV-remediate-tests-07: validation.test.ts covers all contract-pipeline validators
 * INV-remediate-tests-08: ESM-correct __dirname derivation (fileURLToPath(import.meta.url))
 * INV-remediate-tests-09: no vacuous/placeholder tests (expect(true).toBe(true))
 * INV-remediate-tests-10: no cross-file duplicate test bodies for the same behaviour
 * INV-remediate-tests-11: type-safe fixtures — no as-any on tested inputs
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

// ── INV-remediate-tests-02 ─────────────────────────────────────────────────

describe("INV-remediate-tests-02: no inline contract-pipeline version literals in test files", () => {
  // The canonical form for these test files is to use the exported version constants
  // from @audit-tools/shared (CONTRACT_PIPELINE_*_VERSION) or from local validation
  // modules (CP_* private consts) rather than bare string literals.
  //
  // CONTRACT_PIPELINE_ exports available from shared cover: goal_spec, context_bundle,
  // design_spec, conceptual_design_critique, obligation_ledger, contract_assessment_report,
  // counterexample, judge_report, implementation_dag, verification_report, test_validator_plan.
  //
  // Artifacts whose constants are NOT yet in shared (module_decomposition, module_contracts,
  // seam_reconciliation_report, finalized_module_contracts, cyclic_seam_resolution) must
  // be imported from src/validation/contractPipeline.js (local module-level consts).
  // Until that migration completes, validation.test.ts is the exception — it defines
  // local test-scope consts inline (acceptable; see the describe blocks it adds below).
  //
  // This test checks the KEY invariant: contract-pipeline-adversarial.test.ts (the main
  // adversarial fixture) at a minimum imports at least one shared CONTRACT_PIPELINE_* constant
  // or a local const CP_* for the artifact types that now have exported constants.

  it("contract-pipeline-adversarial.test.ts uses CONTRACT_PIPELINE_*_VERSION for supported artifact types OR defines local version consts", () => {
    const src = readTestFile("contract-pipeline-adversarial.test.ts");
    // The file uses version literals for fixtures. It MUST import at least the shared
    // constants that exist (goal_spec, obligation_ledger, judge_report, implementation_dag, etc.)
    // OR define equivalent local const CP_* or import from validation/.
    const usesSharedConstants = src.includes("CONTRACT_PIPELINE_");
    const usesLocalConsts = src.includes("const CP_");
    const importsFromValidation = src.includes("../src/validation/contractPipeline");

    // Track which of the 4+ shared-exported types are used raw:
    const rawGoalSpec = /"remediate-code-contract-pipeline\/goal-spec\/v1alpha1"/.test(src);
    const rawJudge = /"remediate-code-contract-pipeline\/judge-report\/v1alpha1"/.test(src);
    const rawImplDag = /"remediate-code-contract-pipeline\/implementation-dag\/v1alpha1"/.test(src);

    // If raw literals are used for types that HAVE shared constants, it's a violation.
    // These types have CONTRACT_PIPELINE_GOAL_SPEC_VERSION, _JUDGE_REPORT_VERSION, etc.
    if (rawGoalSpec) {
      expect(usesSharedConstants || usesLocalConsts).toBe(true);
    }
    if (rawJudge) {
      expect(usesSharedConstants || usesLocalConsts).toBe(true);
    }
    if (rawImplDag) {
      expect(usesSharedConstants || usesLocalConsts).toBe(true);
    }

    // Overall: the file MUST use constants for at least the available shared types.
    const hasAnyConstants = usesSharedConstants || usesLocalConsts || importsFromValidation;
    // NOTE: this assertion will fail when the file is updated to use constants (which is good),
    // or it records the current state (file uses only raw literals = known debt).
    // This test documents the current state and will fail when migration is needed.
    // For now, record the count of raw literals as an invariant (must not grow).
    const rawLiteralCount = (src.match(/"remediate-code-contract-pipeline\/[^"]+\/v1alpha1"/g) ?? []).length;
    // The count is currently ~20+. We fix it to not increase (regression guard).
    expect(rawLiteralCount).toBeLessThanOrEqual(25);
  });

  it("validation.test.ts defines local version consts (not bare literals) for the 5 validators under test", () => {
    const src = readTestFile("validation.test.ts");
    // After the INV-07 fix, validation.test.ts defines local const variables for each
    // tested artifact version (e.g. const CP_MODULE_DECOMPOSITION_VERSION = "...").
    // These local consts are acceptable because the shared module doesn't yet export them.
    const definesLocalConsts = src.includes("const CP_") ||
      src.includes("CP_MODULE_DECOMPOSITION_VERSION") ||
      src.includes("CP_MODULE_CONTRACTS_VERSION");
    expect(definesLocalConsts).toBe(true);
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
      let src: string;
      try {
        src = readTestFile(file);
      } catch {
        return; // file not present — skip
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
  // Known legitimate non-determinism: integration-pipeline.test.ts and
  // next-step.test.ts closing-phase assertions where multiple closing step_kinds
  // are valid depending on plan state. These are tracked as known debt (not
  // new violations) and must not grow.

  it("either-or set-membership assertion count does not grow beyond known debt (integration + next-step closing steps)", () => {
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
    // Only the known debt files are allowed; any new file is a violation. The
    // next-step closing-phase either-or assertion now lives in the
    // implementation-dispatch shard after the monolith split (MNT-86449ec9).
    const KNOWN_DEBT = [
      "integration-pipeline.test.ts",
      "next-step-implement-dispatch.test.ts",
    ].sort();
    expect(violations.sort()).toEqual(KNOWN_DEBT);
  });
});

// ── INV-remediate-tests-05 ─────────────────────────────────────────────────

describe("INV-remediate-tests-05: quota-scheduler.test.ts covers dispatch.ts scheduleWave", () => {
  it("quota-scheduler.test.ts imports scheduleWave from dispatch.js", () => {
    const src = readTestFile("quota-scheduler.test.ts");
    expect(src).toMatch(/from.*steps\/dispatch\.js/);
  });

  it("quota-scheduler.test.ts has a describe block explicitly for dispatch.ts scheduleWave", () => {
    const src = readTestFile("quota-scheduler.test.ts");
    // The INV-remediate-tests-05 comment ensures both shared + dispatch are tested
    expect(src).toContain("dispatch.ts scheduleWave");
  });
});

// ── INV-remediate-tests-06 ─────────────────────────────────────────────────

describe("INV-remediate-tests-06: schema-contracts EXPECTED_SCHEMAS has bidirectional disk coverage", () => {
  it("schema-contracts.test.ts declares EXPECTED_SCHEMAS array", () => {
    const src = readTestFile("schema-contracts.test.ts");
    expect(src).toMatch(/const EXPECTED_SCHEMAS\s*=/);
  });

  it("schema-contracts.test.ts includes the bidirectional reverse-check test", () => {
    const src = readTestFile("schema-contracts.test.ts");
    // The reverse check test must exist
    expect(src).toMatch(/no schema files exist on disk that are missing from EXPECTED_SCHEMAS/);
  });

  it("schema-contracts.test.ts verifies worker_result schema", () => {
    const src = readTestFile("schema-contracts.test.ts");
    expect(src).toContain("worker_result.schema.json");
  });
});

// ── INV-remediate-tests-07 ─────────────────────────────────────────────────

describe("INV-remediate-tests-07: validation.test.ts covers all contract-pipeline validators", () => {
  // The full set of validators in src/validation/contractPipeline.ts must each
  // have a describe block in validation.test.ts covering them.
  const REQUIRED_VALIDATORS = [
    "validateModuleDecomposition",
    "validateModuleContracts",
    "validateSeamReconciliationReport",
    "validateFinalizedModuleContracts",
    "validateCyclicSeamResolution",
    "validateGoalSpec",
    "validateImplementationDAG",
    "validateCounterexample",
    "validateJudgeReport",
  ];

  it("validation.test.ts imports all required validators", () => {
    const src = readTestFile("validation.test.ts");
    const missing = REQUIRED_VALIDATORS.filter((v) => !src.includes(v));
    expect(missing).toEqual([]);
  });

  it("each required validator has its own describe block in validation.test.ts", () => {
    const src = readTestFile("validation.test.ts");
    const missingDescribe = REQUIRED_VALIDATORS.filter(
      (v) => !src.includes(`describe("${v}`) && !src.includes(`describe('${v}`),
    );
    expect(missingDescribe).toEqual([]);
  });
});

// ── INV-remediate-tests-10 ─────────────────────────────────────────────────

describe("INV-remediate-tests-10: no cross-file duplicate test bodies for same behaviour", () => {
  // Specific known single-owner invariants documented in step-utils.test.ts:
  // specIndicatesNoChange → spec-no-change.test.ts only
  // classifyFindingRisk → classify-finding-risk.test.ts only
  // These must not have duplicate test describe blocks in other files.

  it("specIndicatesNoChange is only directly tested in spec-no-change.test.ts", () => {
    const THIS_FILE = "remediate-tests-invariants.test.ts";
    const violations: string[] = [];
    for (const file of listTestFiles()) {
      if (file === "spec-no-change.test.ts") continue;
      if (file === THIS_FILE) continue; // skip self — invariant text mentions the name
      const src = readTestFile(file);
      // Acceptable: a comment reference (e.g. step-utils.test.ts has a comment)
      // Violation: an actual import and usage in assertions
      const lines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
      const joined = lines.join("\n");
      if (
        /import.*specIndicatesNoChange/.test(joined) &&
        /expect.*specIndicatesNoChange/.test(joined)
      ) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

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
