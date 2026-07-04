/**
 * S1 (contract-authoring determinism): the obligation ledger is derived
 * deterministically from the finalized module contracts by the tool, not
 * authored by an LLM phase. These tests cover the pure deriver, the step-builder
 * intercept that writes it and advances, and the `validate-artifact` write-time
 * validator CLI (S3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNextContractPipelineStep,
} from "../../src/remediate/steps/contractPipeline.js";
import {
  writeContractArtifact,
  contractArtifactFilePath,
  readContractArtifact,
  stampToolCreatedAt,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  deriveObligationLedger,
  buildTestValidatorPlanScaffold,
  buildImplementationDagScaffold,
  acceptedCounterexampleIds,
  advisoryCritiqueItems,
  isTestablePhaseObligation,
  isDagPhaseObligation,
} from "../../src/remediate/contractPipeline/derive.js";
import {
  captureTestPlanCarry,
  readTestPlanCarry,
} from "../../src/remediate/contractPipeline/testPlanCarry.js";
import {
  validateObligationLedger,
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_MODULE_CONTRACTS_VERSION,
  CP_SEAM_RECONCILIATION_REPORT_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  type ObligationLedger,
} from "audit-tools/shared";
import { program } from "../../src/remediate/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-cp-derive-obligations");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const STEP_OPTIONS = {
  root: TEST_DIR,
  artifactsDir: ARTIFACTS_DIR,
  runId: "CONTRACT-TEST",
};

/** A finalized-module-contracts payload with one rich module and one bare one. */
function finalizedContracts() {
  return {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: "G1",
    module_contracts: [
      {
        name: "auth-module",
        inputs: ["credentials"],
        outputs: ["session"],
        invariants: [
          "A session is issued only for validated credentials.",
          "Sessions expire after the configured TTL.",
        ],
        side_effects: ["writes session store"],
        validation_boundary: "validates credentials at the boundary",
        failure_modes: ["malformed credentials are rejected"],
      },
      {
        name: "logging-module",
        inputs: ["event"],
        outputs: ["log line"],
        invariants: [],
        side_effects: [],
        validation_boundary: "n/a",
        failure_modes: [],
      },
    ],
    created_at: CREATED_AT,
  };
}

/** Write every contract-pipeline artifact up to (but not including) the ledger. */
async function writeUpstreamThroughCritique(): Promise<void> {
  await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: "G1",
    objective: "Harden the auth flow.",
    non_goals: [],
    success_criteria: ["Auth flow is hardened."],
    source_type: "documents",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: "G1",
    entries: [],
    context_summary: "Auth context.",
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: "G1",
    modules: [
      { name: "auth-module", responsibilities: "Auth.", file_scope: ["src/auth.ts"] },
      { name: "logging-module", responsibilities: "Logs.", file_scope: ["src/log.ts"] },
    ],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "module_contracts", {
    ...finalizedContracts(),
    contract_version: CP_MODULE_CONTRACTS_VERSION,
  });
  await writeContractArtifact(ARTIFACTS_DIR, "seam_reconciliation_report", {
    contract_version: CP_SEAM_RECONCILIATION_REPORT_VERSION,
    goal_id: "G1",
    mismatches: [],
    created_at: CREATED_AT,
  });
  await writeContractArtifact(
    ARTIFACTS_DIR,
    "finalized_module_contracts",
    finalizedContracts(),
  );
  await writeContractArtifact(ARTIFACTS_DIR, "conceptual_design_critique", {
    contract_version: CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
    goal_id: "G1",
    items: [],
    verdict: "approved",
    created_at: CREATED_AT,
  });
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("deriveObligationLedger (S1 deterministic derivation)", () => {
  it("maps module invariants, failure modes, and modules to obligations", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), {
      created_at: CREATED_AT,
    });

    expect(ledger.contract_version).toBe(CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION);
    expect(ledger.goal_id).toBe("G1");

    const byKind = (kind: string) =>
      ledger.obligations.filter((o) => o.kind === kind);
    // 2 modules → 2 structural; auth has 2 invariants + 1 failure mode.
    expect(byKind("structural")).toHaveLength(2);
    expect(byKind("invariant")).toHaveLength(2);
    expect(byKind("behavioral")).toHaveLength(1);

    // Invariant text is carried verbatim into the obligation description.
    expect(byKind("invariant").map((o) => o.description)).toContain(
      "A session is issued only for validated credentials.",
    );
    // Failure-mode obligations name the failure they must handle.
    expect(byKind("behavioral")[0].description).toContain(
      "malformed credentials are rejected",
    );

    // Every obligation has a unique id, no dependencies, pending status.
    const ids = ledger.obligations.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ledger.obligations.every((o) => o.depends_on.length === 0)).toBe(true);
    expect(ledger.obligations.every((o) => o.status === "pending")).toBe(true);
  });

  it("represents a module with no invariants/failure modes via a structural obligation", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), {
      created_at: CREATED_AT,
    });
    const logging = ledger.obligations.filter((o) => o.id.includes("logging-module"));
    expect(logging).toHaveLength(1);
    expect(logging[0].kind).toBe("structural");
  });

  it("is deterministic and produces a ledger that passes validateObligationLedger", () => {
    const a = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const b = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    expect(a).toEqual(b);

    const issues = validateObligationLedger(a).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);
  });
});

describe("obligation_ledger is derived by the tool, not dispatched as an LLM phase", () => {
  it("writes the derived ledger and advances past obligation_ledger in one next-step", async () => {
    await writeUpstreamThroughCritique();

    const ledgerPath = contractArtifactFilePath(ARTIFACTS_DIR, "obligation_ledger");
    expect(existsSync(ledgerPath)).toBe(false);

    const step = await buildNextContractPipelineStep(STEP_OPTIONS);

    // The ledger was written by the tool, not handed to a worker to author.
    expect(existsSync(ledgerPath)).toBe(true);
    const envelope = await readContractArtifact(ARTIFACTS_DIR, "obligation_ledger");
    const written = envelope?.payload as ObligationLedger;
    const reference = deriveObligationLedger(finalizedContracts());
    expect(written.obligations.map((o) => o.id)).toEqual(
      reference.obligations.map((o) => o.id),
    );

    // The returned step advanced to the next LLM phase — it is NOT an
    // obligation-ledger authoring step.
    const prompt = await readFile((step as { prompt_path: string }).prompt_path, "utf8");
    expect(prompt).not.toMatch(/# Obligation Ledger/);
    expect(prompt).toMatch(/Test and Validator Plan/);

    // S3: the test-plan phase is scaffolded with the derived skeleton and the
    // write-time self-check is referenced.
    expect(prompt).toMatch(/Pre-filled Skeleton/);
    expect(prompt).toContain("validate-artifact");
    // The skeleton enumerates a testable obligation derived from the contracts.
    const aTestableId = reference.obligations.find(
      (o) => o.kind === "invariant" || o.kind === "behavioral",
    )!.id;
    expect(prompt).toContain(aTestableId);
  });
});

describe("artifact scaffolds (S3 skeletons for the partially-derivable phases)", () => {
  it("test-plan scaffold has one blank-assertion spec per testable obligation", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const scaffold = buildTestValidatorPlanScaffold(ledger);

    const testable = ledger.obligations.filter(
      (o) => o.kind === "invariant" || o.kind === "behavioral",
    );
    expect(scaffold.test_specs).toHaveLength(testable.length);
    // Structural obligations are NOT given test specs.
    expect(scaffold.test_specs.length).toBeLessThan(ledger.obligations.length);
    // Every spec references a real obligation and leaves assertions blank.
    for (const spec of scaffold.test_specs) {
      expect(testable.some((o) => o.id === spec.obligation_id)).toBe(true);
      expect(spec.assertions).toEqual([]);
      expect(spec.name.length).toBeGreaterThan(0);
    }
  });

  it("implementation-DAG scaffold covers every obligation and attaches accepted counterexamples", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const scaffold = buildImplementationDagScaffold(ledger, ["CE-001"]);

    // B2: ONE node per module (auth-module, logging-module), each grouping that
    // module's obligations, blank judgment slots — not one node per obligation.
    const moduleCount = new Set(
      ledger.obligations.map((o) => o.module).filter(Boolean),
    ).size;
    expect(moduleCount).toBe(2);
    expect(scaffold.nodes).toHaveLength(moduleCount);
    const coveredObligations = new Set(
      scaffold.nodes.flatMap((n) => n.satisfies_obligations),
    );
    for (const obl of ledger.obligations) {
      expect(coveredObligations.has(obl.id)).toBe(true);
    }
    expect(scaffold.nodes.every((n) => n.title === "" && n.targeted_commands.length === 0)).toBe(true);
    // The accepted counterexample is covered by some node.
    expect(
      scaffold.nodes.some((n) => n.addresses_counterexamples.includes("CE-001")),
    ).toBe(true);
    expect(scaffold.edges).toEqual([]);
  });

  it("derives node depends_on from producer/consumer artifact tokens in the finalized contracts", () => {
    // auth-module PRODUCES artifact:session; logging-module CONSUMES it → the
    // logging node must depend on the auth node, with no host-authored edge.
    const contracts = {
      goal_id: "G1",
      module_contracts: [
        {
          name: "auth-module",
          inputs: ["credentials"],
          outputs: ["artifact:session (an authenticated session)"],
          invariants: ["a session is returned for valid credentials"],
          failure_modes: ["malformed credentials are rejected"],
          validation_boundary: "",
        },
        {
          name: "logging-module",
          inputs: ["artifact:session to attribute the log line"],
          outputs: ["log line"],
          invariants: [],
          failure_modes: [],
          validation_boundary: "",
        },
      ],
    };
    const ledger = deriveObligationLedger(contracts, { created_at: CREATED_AT });
    const scaffold = buildImplementationDagScaffold(ledger, [], contracts);

    const authNode = scaffold.nodes.find((n) =>
      n.satisfies_obligations.some((id) => id.includes("auth-module")),
    )!;
    const loggingNode = scaffold.nodes.find((n) =>
      n.satisfies_obligations.some((id) => id.includes("logging-module")),
    )!;
    expect(authNode.depends_on).toEqual([]);
    expect(loggingNode.depends_on).toEqual([authNode.id]);
    // The scaffold's `edges` array stays empty; node depends_on carries ordering.
    expect(scaffold.edges).toEqual([]);
  });

  it("omits node depends_on when no finalized contracts are supplied (unchanged behaviour)", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const scaffold = buildImplementationDagScaffold(ledger, []);
    expect(scaffold.nodes.every((n) => n.depends_on.length === 0)).toBe(true);
  });

  it("breaks a producer/consumer dependency cycle rather than emitting a cyclic scaffold", () => {
    // a consumes artifact:y (produced by b) and produces artifact:x (consumed by b):
    // a genuine cycle. Phase-oriented derivation keeps at most one direction, so
    // the resulting node depends_on graph is acyclic (fail-toward-later).
    const contracts = {
      goal_id: "G1",
      module_contracts: [
        {
          name: "mod-a",
          inputs: ["artifact:y"],
          outputs: ["artifact:x"],
          invariants: ["a holds"],
          failure_modes: [],
          validation_boundary: "",
        },
        {
          name: "mod-b",
          inputs: ["artifact:x"],
          outputs: ["artifact:y"],
          invariants: ["b holds"],
          failure_modes: [],
          validation_boundary: "",
        },
      ],
    };
    const ledger = deriveObligationLedger(contracts, { created_at: CREATED_AT });
    const scaffold = buildImplementationDagScaffold(ledger, [], contracts);
    // No pair of nodes mutually depends on each other (acyclic by construction).
    const dep = new Map(scaffold.nodes.map((n) => [n.id, n.depends_on]));
    for (const n of scaffold.nodes) {
      for (const d of n.depends_on) {
        expect(dep.get(d)?.includes(n.id)).not.toBe(true);
      }
    }
  });

  it("B2: a single-module change with many obligations derives exactly ONE node", () => {
    const ledger = deriveObligationLedger(
      {
        goal_id: "G1",
        module_contracts: [
          {
            name: "one-mod",
            inputs: [],
            outputs: [],
            invariants: ["a holds", "b holds"],
            failure_modes: ["c fails"],
            validation_boundary: "",
          },
        ],
      },
      { created_at: CREATED_AT },
    );
    // 1 structural + 2 invariant + 1 behavioral = 4 obligations, all one module.
    expect(ledger.obligations.length).toBe(4);
    const dag = buildImplementationDagScaffold(ledger, []);
    expect(dag.nodes).toHaveLength(1);
    expect(dag.nodes[0].satisfies_obligations.sort()).toEqual(
      ledger.obligations.map((o) => o.id).sort(),
    );
  });

  it("C3: diff-carry pre-fills assertions for an unchanged obligation, blanks a changed one", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const fresh = buildTestValidatorPlanScaffold(ledger);
    const spec = fresh.test_specs[0];
    expect(spec.assertions).toEqual([]);

    // Prior round authored assertions for this obligation; premise unchanged.
    const prior = {
      [spec.obligation_id]: {
        name: spec.name,
        scope_anchors: spec.scope_anchors,
        assertions: ["positive: does X", "negative: rejects when " + spec.scope_anchors[0]],
      },
    };
    const carried = buildTestValidatorPlanScaffold(ledger, prior);
    const carriedSpec = carried.test_specs.find((s) => s.obligation_id === spec.obligation_id)!;
    expect(carriedSpec.assertions).toEqual(prior[spec.obligation_id].assertions);

    // A changed premise (different name) carries nothing — host re-authors.
    const staleName = {
      [spec.obligation_id]: {
        name: "a different obligation name",
        scope_anchors: spec.scope_anchors,
        assertions: ["stale assertion"],
      },
    };
    const notCarried = buildTestValidatorPlanScaffold(ledger, staleName);
    expect(
      notCarried.test_specs.find((s) => s.obligation_id === spec.obligation_id)!.assertions,
    ).toEqual([]);

    // A changed scope-anchor set also blocks carry.
    const staleAnchors = {
      [spec.obligation_id]: {
        name: spec.name,
        scope_anchors: ["totally-different-symbol"],
        assertions: ["stale assertion"],
      },
    };
    expect(
      buildTestValidatorPlanScaffold(ledger, staleAnchors).test_specs.find(
        (s) => s.obligation_id === spec.obligation_id,
      )!.assertions,
    ).toEqual([]);
  });

  it("C3: captureTestPlanCarry → readTestPlanCarry round-trips authored specs, drops empties", async () => {
    const dir = ARTIFACTS_DIR;
    await mkdir(dir, { recursive: true });
    {
      await captureTestPlanCarry(
        dir,
        {
          test_specs: [
            { obligation_id: "OBL-a", name: "A", scope_anchors: ["x"], assertions: ["p", "n"] },
            { obligation_id: "OBL-b", name: "B", scope_anchors: [], assertions: [] },
            { obligation_id: "OBL-c", name: "C", inapplicable_claim: { obligation_id: "OBL-c", reason: "n/a" } },
          ],
        },
        CREATED_AT,
      );
      const carry = await readTestPlanCarry(dir);
      expect(Object.keys(carry)).toEqual(["OBL-a"]);
      expect(carry["OBL-a"]).toEqual({ name: "A", scope_anchors: ["x"], assertions: ["p", "n"] });
    }
  });

  it("D1: every test-plan spec carries non-empty scope_anchors for negative scoping", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const scaffold = buildTestValidatorPlanScaffold(ledger);
    expect(scaffold.test_specs.length).toBeGreaterThan(0);
    for (const spec of scaffold.test_specs) {
      expect(Array.isArray(spec.scope_anchors)).toBe(true);
      // obligationScopeAnchors falls back to the id + description symbols, so a
      // real obligation always yields at least one anchor for the host to scope to.
      expect(spec.scope_anchors.length).toBeGreaterThan(0);
    }
  });

  it("B3: every DAG node carries a blank addressed_critique_items carrier", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const scaffold = buildImplementationDagScaffold(ledger, ["CE-001"]);
    expect(scaffold.nodes.every((n) => Array.isArray(n.addressed_critique_items) && n.addressed_critique_items.length === 0)).toBe(true);
  });

  it("B3: advisoryCritiqueItems extracts only advisory-severity items with ids", () => {
    const items = advisoryCritiqueItems({
      items: [
        { id: "C-1", severity: "blocking", description: "must fix" },
        { id: "C-2", severity: "advisory", description: "consider X" },
        { id: "", severity: "advisory", description: "no id" },
        { severity: "advisory", description: "missing id" },
        { id: "C-3", severity: "advisory", description: "consider Y" },
      ],
    });
    expect(items).toEqual([
      { id: "C-2", description: "consider X" },
      { id: "C-3", description: "consider Y" },
    ]);
    expect(advisoryCritiqueItems(undefined)).toEqual([]);
  });

  it("acceptedCounterexampleIds extracts only judge-accepted ids", () => {
    const ids = acceptedCounterexampleIds({
      classifications: [
        { counterexample_id: "CE-1", classification: "accepted" },
        { counterexample_id: "CE-2", classification: "invalid" },
        { counterexample_id: "CE-3", classification: "accepted" },
      ],
    });
    expect(ids).toEqual(["CE-1", "CE-3"]);
    expect(acceptedCounterexampleIds(undefined)).toEqual([]);
  });
});

describe("C4: single-sourced obligation-membership predicates", () => {
  it("isTestablePhaseObligation: testable→true, structural→false, unknown-kind→true (conservative)", () => {
    expect(isTestablePhaseObligation("invariant")).toBe(true);
    expect(isTestablePhaseObligation("behavioral")).toBe(true);
    expect(isTestablePhaseObligation("structural")).toBe(false);
    // Unknown / unexpected kind fails OPEN into the paired-test gate.
    expect(isTestablePhaseObligation("mystery")).toBe(true);
  });

  it("isDagPhaseObligation: every kind is covered by the implementation DAG", () => {
    for (const k of ["invariant", "behavioral", "structural", "mystery"]) {
      expect(isDagPhaseObligation(k)).toBe(true);
    }
  });

  it("a structural obligation goes to the DAG only — never the test plan", () => {
    // The contract-conformance obligation per module is structural; with no
    // invariants/failure modes the ledger is structural-only.
    const ledger = deriveObligationLedger(
      {
        goal_id: "G1",
        module_contracts: [
          { name: "m", inputs: [], outputs: [], invariants: [], failure_modes: [], validation_boundary: "" },
        ],
      },
      { created_at: CREATED_AT },
    );
    expect(ledger.obligations.every((o) => o.kind === "structural")).toBe(true);
    expect(buildTestValidatorPlanScaffold(ledger).test_specs).toHaveLength(0);
    expect(buildImplementationDagScaffold(ledger, []).nodes).toHaveLength(
      ledger.obligations.length,
    );
  });

  it("a testable obligation goes to BOTH scaffolds", () => {
    const ledger = deriveObligationLedger(
      {
        goal_id: "G1",
        module_contracts: [
          { name: "m", inputs: [], outputs: [], invariants: ["x must hold"], failure_modes: [], validation_boundary: "" },
        ],
      },
      { created_at: CREATED_AT },
    );
    const inv = ledger.obligations.find((o) => o.kind === "invariant")!;
    expect(buildTestValidatorPlanScaffold(ledger).test_specs.map((s) => s.obligation_id)).toContain(inv.id);
    expect(buildImplementationDagScaffold(ledger, []).nodes.flatMap((n) => n.satisfies_obligations)).toContain(inv.id);
  });

  it("parity: both scaffolds' membership equals the shared predicates", () => {
    const ledger = deriveObligationLedger(finalizedContracts(), { created_at: CREATED_AT });
    const testPlan = buildTestValidatorPlanScaffold(ledger);
    const dag = buildImplementationDagScaffold(ledger, []);

    const expectedTestable = ledger.obligations
      .filter((o) => isTestablePhaseObligation(o.kind))
      .map((o) => o.id)
      .sort();
    expect(testPlan.test_specs.map((s) => s.obligation_id).sort()).toEqual(expectedTestable);

    const expectedDag = ledger.obligations
      .filter((o) => isDagPhaseObligation(o.kind))
      .map((o) => o.id)
      .sort();
    expect(dag.nodes.flatMap((n) => n.satisfies_obligations).sort()).toEqual(expectedDag);
  });
});

describe("validate-artifact CLI (S3 write-time validator)", () => {
  it("registers a validate-artifact command requiring --name with an optional --file", () => {
    const cmd = program.commands.find((c) => c.name() === "validate-artifact");
    expect(cmd, "validate-artifact command is registered").toBeTruthy();
    const optionFlags = cmd!.options.map((o) => o.long);
    expect(optionFlags).toContain("--name");
    expect(optionFlags).toContain("--file");
    const nameOption = cmd!.options.find((o) => o.long === "--name");
    expect(nameOption?.required).toBe(true);
  });
});
