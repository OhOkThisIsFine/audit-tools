/**
 * CP-NODE-3 — contract-validation-gates (B1 #3 batch + B2 coverage exposure +
 * polarity hint + B5 decomposition file_scope gate). Red-before-green coverage
 * for the OBL-contract-validation-gates-* obligations (positive AND negative):
 *
 *   INV-CVG-1  validateArtifacts batches EVERY gate failure across all present
 *              artifacts into ONE result (no per-invocation partial report).
 *   INV-CVG-2  the paired-obligation coverage gate is reachable from
 *              validate-artifact (validateArtifacts), not only next-step.
 *   INV-CVG-3  a polarity misread on a block/exit-2 satisfied path emits the
 *              explicit POSITIVE:/NEGATIVE: label escape-hatch hint.
 *   INV-CVG-4  validateDecompositionFileScope rejects a shim-only file_scope,
 *              passes a real-logic scope, warns on an empty tree, fails closed on
 *              an unreadable tree.
 *   INV-CVG-5  the decomposition role prompt carries guidance parity with the gate.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  validatePairedObligations,
  validateDecompositionFileScope,
  CP_MODULE_DECOMPOSITION_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import { validateArtifacts } from "../../src/remediate/validation/artifacts.js";
import { ROLES } from "../../src/remediate/steps/contractPipelinePrompts.js";
import { contractPipelineDir } from "../../src/remediate/contractPipeline/artifactStore.js";
import { intakePaths } from "../../src/remediate/intake.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "audit-tools/shared";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cvg-gate-"));
  tempDirs.push(dir);
  return dir;
}

/** A temp dir initialized as a git repo, with `files` written and `git add`ed. */
async function makeGitRepo(files: Record<string, string>): Promise<string> {
  const dir = await makeTempDir();
  const git = (...args: string[]) =>
    spawnSyncHidden("git", args, { cwd: dir, encoding: "utf8", shell: false, windowsHide: true });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  git("add", "-A");
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// ── B5 gate direct unit tests (INV-CVG-4) ─────────────────────────────────────

const SHIM_FILE = 'export * from "./real.js";\n';
const REAL_FILE = "export function install() {\n  return 1;\n}\n";

function decomposition(modules: Array<{ name: string; file_scope: string[] }>): unknown {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: modules.map((m) => ({
      name: m.name,
      responsibilities: "does the work",
      file_scope: m.file_scope,
    })),
    created_at: CREATED_AT,
  };
}

describe("INV-CVG-4: validateDecompositionFileScope (B5)", () => {
  it("POSITIVE: passes a module scoped at the file where real logic lives", async () => {
    const repo = await makeGitRepo({ "src/real.ts": REAL_FILE, "src/barrel.ts": SHIM_FILE });
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "installer", file_scope: ["src/real.ts"] }]),
      repo,
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("NEGATIVE: errors on a module scoped ONLY at a thin re-export shim/barrel", async () => {
    const repo = await makeGitRepo({ "src/real.ts": REAL_FILE, "src/barrel.ts": SHIM_FILE });
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "installer", file_scope: ["src/barrel.ts"] }]),
      repo,
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/re-export shim/i);
    expect(errors[0].message).toContain("src/barrel.ts");
  });

  it("does NOT reject when file_scope includes at least one real-logic file (rebuttable lead)", async () => {
    const repo = await makeGitRepo({ "src/real.ts": REAL_FILE, "src/barrel.ts": SHIM_FILE });
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "installer", file_scope: ["src/barrel.ts", "src/real.ts"] }]),
      repo,
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("does NOT false-reject a genuinely small non-shim module (structural check, not line-count) — fail-5", async () => {
    const repo = await makeGitRepo({ "src/tiny.ts": "export const N = 1;\n" });
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "tiny", file_scope: ["src/tiny.ts"] }]),
      repo,
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("degrades a valid-but-empty git tree to a WARNING, never a hard block — fail-4", async () => {
    const repo = await makeGitRepo({}); // git repo, nothing added → 0 tracked files
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "installer", file_scope: ["src/real.ts"] }]),
      repo,
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("fails CLOSED (error) on an unreadable tree — git missing / not a repo — fail-4", async () => {
    const notARepo = await makeTempDir(); // plain dir, no git init
    const issues = validateDecompositionFileScope(
      decomposition([{ name: "installer", file_scope: ["src/real.ts"] }]),
      notARepo,
    );
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });
});

// ── B2 polarity escape-hatch hint (INV-CVG-3) ─────────────────────────────────

describe("INV-CVG-3: polarity-misread escape-hatch hint (B2)", () => {
  const ledger = {
    obligations: [
      {
        id: "OBL-blk-inv-1",
        description: "the gate blocks writeRecord when out of scope",
        kind: "invariant",
        change_classification: {
          change_kind: "change",
          touched_symbols: ["writeRecord"],
          determined_by: "touches_existing_symbol",
        },
      },
    ],
  };

  it("POSITIVE: a block/exit-2 satisfied path (misread as no-positive) yields the POSITIVE:/NEGATIVE: hint", () => {
    const plan = {
      test_specs: [
        {
          obligation_id: "OBL-blk-inv-1",
          assertions: [
            // Success case is a block/`exit 2` action — the keyword heuristic reads no positive.
            "the commit-gate blocks the session and exits 2 when the writeRecord record is incomplete",
            // A scoped negative so ONLY the positive half is missing.
            "NEGATIVE: it does not block when the writeRecord record is complete, scoped to writeRecord",
          ],
        },
      ],
    };
    const issues = validatePairedObligations(ledger, plan);
    const positiveError = issues.find((i) => i.path.endsWith(".positive"));
    expect(positiveError).toBeDefined();
    expect(positiveError!.message).toContain("POSITIVE:");
    expect(positiveError!.message).toContain("NEGATIVE:");
  });

  it("NEGATIVE: prefixing an explicit POSITIVE: label overrides the classifier — no positive error", () => {
    const plan = {
      test_specs: [
        {
          obligation_id: "OBL-blk-inv-1",
          assertions: [
            "POSITIVE: the commit-gate blocks and exits 2 when writeRecord is out of scope",
            "NEGATIVE: it does not block when writeRecord is in scope, scoped to writeRecord",
          ],
        },
      ],
    };
    const issues = validatePairedObligations(ledger, plan);
    expect(issues.some((i) => i.path.endsWith(".positive"))).toBe(false);
    expect(issues.some((i) => i.path.endsWith(".negative"))).toBe(false);
  });
});

// ── B2 coverage gate exposed in validate-artifact (INV-CVG-2) ─────────────────

describe("INV-CVG-2: paired-obligation coverage gate reachable from validate-artifact", () => {
  it("NEGATIVE→POSITIVE: an uncovered testable obligation makes validateArtifacts return error", async () => {
    const repo = await makeTempDir();
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const cpDir = contractPipelineDir(artifactsDir);
    await writeJson(join(cpDir, "obligation_ledger.json"), {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "OBL-cov-inv-1",
          description: "an invariant with no covering test spec",
          kind: "invariant",
          depends_on: [],
          status: "pending",
        },
      ],
      created_at: CREATED_AT,
    });
    await writeJson(join(cpDir, "test_validator_plan.json"), {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [],
      created_at: CREATED_AT,
    });

    const result = await validateArtifacts(artifactsDir, repo);

    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/has no test spec|coverage/i);
  });
});

// ── B1 #3 batch all failures in ONE report (INV-CVG-1) ────────────────────────

describe("INV-CVG-1: validateArtifacts batches every gate failure in one result (B1 #3)", () => {
  it("POSITIVE: a missing paired-negative AND a shim file_scope AND an uncovered digest finding all surface in ONE result", async () => {
    // A real git repo so the B5 file_scope gate can enumerate + read the shim.
    const repo = await makeGitRepo({ "src/real.ts": REAL_FILE, "src/barrel.ts": SHIM_FILE });
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const cpDir = contractPipelineDir(artifactsDir);

    // (a) digest: structured_audit source so the digest gate is enumerable.
    await writeJson(join(cpDir, "goal_spec.json"), {
      contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
      goal_id: "G1",
      objective: "sweep",
      non_goals: [],
      success_criteria: ["cover findings"],
      source_type: "structured_audit",
      created_at: CREATED_AT,
    });
    await writeJson(intakePaths(artifactsDir).findingEnumeration, {
      is_enumerable: true,
      findings: [{ id: "F-UNCOVERED" }],
    });

    // (b) paired-negative missing: a CHANGE obligation with a positive-only spec.
    await writeJson(join(cpDir, "obligation_ledger.json"), {
      contract_version: CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
      goal_id: "G1",
      obligations: [
        {
          id: "OBL-batch-inv-1",
          description: "an invariant touching writeRecord in src/real.ts",
          kind: "invariant",
          depends_on: [],
          status: "pending",
          change_classification: {
            change_kind: "change",
            touched_symbols: ["writeRecord"],
            determined_by: "touches_existing_symbol",
          },
        },
      ],
      created_at: CREATED_AT,
    });
    await writeJson(join(cpDir, "test_validator_plan.json"), {
      contract_version: CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
      goal_id: "G1",
      test_specs: [
        {
          obligation_id: "OBL-batch-inv-1",
          name: "positive only",
          kind: "invariant",
          assertions: ["POSITIVE: writeRecord succeeds and returns the record when in scope"],
        },
      ],
      created_at: CREATED_AT,
    });

    // (c) shim-only file_scope.
    await writeJson(join(cpDir, "module_decomposition.json"), {
      contract_version: CP_MODULE_DECOMPOSITION_VERSION,
      goal_id: "G1",
      modules: [
        { name: "installer", responsibilities: "installs", file_scope: ["src/barrel.ts"] },
      ],
      created_at: CREATED_AT,
    });

    const result = await validateArtifacts(artifactsDir, repo);
    const joined = result.issues.join("\n");

    expect(result.status).toBe("error");
    // All THREE distinct gate failures present in the single returned result.
    expect(joined).toMatch(/negative/i); // paired-negative missing
    expect(joined).toMatch(/re-export shim/i); // shim file_scope
    expect(joined).toMatch(/F-UNCOVERED/); // uncovered digest finding
    // Batched: at least the three CP-gate issue entries are present together.
    expect(result.issue_count).toBeGreaterThanOrEqual(3);
  });
});

// ── B5 prompt guidance parity (INV-CVG-5) ─────────────────────────────────────

describe("INV-CVG-5: decomposition role prompt guidance parity with the gate", () => {
  it("POSITIVE: ROLES.decomposition.description tells the author to verify logic location / reject re-export shims", () => {
    const desc = ROLES.decomposition.description;
    expect(desc).toMatch(/re-export shim/i);
    expect(desc).toMatch(/actually lives|where the named/i);
  });

  it("NEGATIVE: the guidance references the enforcing gate so hint and gate stay paired", () => {
    expect(ROLES.decomposition.description).toContain("validateDecompositionFileScope");
  });
});
