import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { buildRemediationOutcomesReport, buildVerificationReport } from "../../src/remediate/phases/close.js";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import { validateArtifacts } from "../../src/remediate/validation/artifacts.js";
import { scratchDir } from "../helpers/scratch.js";
import { makePlanningState } from "./helpers/nextStepHarness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-artifact-validation");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function saveState(overrides: Partial<RemediationState> = {}): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(makePlanningState(overrides));
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("validateArtifacts", () => {
  it("passes a minimal valid runtime state", async () => {
    await saveState();

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("ok");
    expect(result.issues).toEqual([]);
  });

});

describe("validateCurrentStep (ValidationIssue[] return style)", () => {
  it("returns issues when required string fields are missing", async () => {
    // Access via validateArtifacts integration: write a malformed current-step.json
    await saveState();
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), {
      // missing contract_version, step_kind, status, etc.
      not_a_step: true,
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/contract_version|step_kind|status/i);
  });

  /** A current-step object that is well-formed apart from `run_id`'s value. */
  async function writeWellFormedStep(runId: unknown): Promise<void> {
    const { REMEDIATION_STEP_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    const promptPath = join(ARTIFACTS_DIR, "steps", "current-prompt.md");
    await mkdir(join(ARTIFACTS_DIR, "steps"), { recursive: true });
    await writeFile(promptPath, "# prompt\n", "utf8");
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), {
      contract_version: REMEDIATION_STEP_CONTRACT_VERSION,
      step_kind: "implement",
      status: "ready",
      prompt_path: promptPath,
      /** The nullable field under test — spelled explicitly, `undefined` included. */
      run_id: runId,
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      stop_condition: "done",
      allowed_commands: ["npm test"],
      artifact_paths: {},
    });
  }

  function stepIssuesOf(result: { issues: string[] }): string[] {
    return result.issues.filter((i) => i.includes("current-step.json"));
  }

  it("does not report issues for a well-formed current-step object", async () => {
    await saveState();
    await writeWellFormedStep("run-1");

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    // current-step issues shouldn't appear in the output
    expect(stepIssuesOf(result)).toHaveLength(0);
  });

  // `RemediationStep.run_id` is `string | null`: a planless complete run names
  // no run and writes `null` (the legacy `"run"` fallback key is gone). The
  // validator demanding a string rejected the tool's own just-written step, so
  // such a run reported itself broken for having told the truth.
  it("accepts a NULL run_id — the planless complete step the tool itself writes", async () => {
    await saveState();
    await writeWellFormedStep(null);

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(stepIssuesOf(result)).toHaveLength(0);
  });

  // The other half: nullability is not permissiveness. An ABSENT run_id is a
  // different answer from a null one and is still an issue.
  it("still reports an ABSENT run_id", async () => {
    await saveState();
    await writeWellFormedStep(undefined);

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(stepIssuesOf(result).join("\n")).toMatch(/run_id must be a string or null/);
  });
});

// The close producer promotes these four files before removing active state.
// These fixtures exercise that retained contract; they do not claim execution.
describe("validateArtifacts after terminal cleanup", () => {
  const outputDir = dirname(ARTIFACTS_DIR);
  const completePath = join(outputDir, "remediation-state.complete.json");

  async function writeCompletedArtifacts(state = makePlanningState({ status: "complete" })) {
    const closing = { contract_version: "remediate-code-closing-result/v1alpha1" as const, action: "none" as const, status: "skipped" as const, commands: [] };
    await writeJson(completePath, state);
    const outcomes = buildRemediationOutcomesReport(state, closing);
    const verification = buildVerificationReport(
      state, { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, closing,
      { ran: false, passed: true, duration_ms: 0, output: "" },
    );
    await writeJson(join(outputDir, "remediation-outcomes.json"), outcomes);
    await writeJson(join(outputDir, "verification_report.json"), verification);
    await writeFile(join(outputDir, "remediation-report.md"), "# Retained test report\n", "utf8");
    return { state, outcomes, verification };
  }

  it("validates retained deliverables without recreating purged evidence or claiming runtime checks", async () => {
    await writeCompletedArtifacts();
    await rm(ARTIFACTS_DIR, { recursive: true });
    const before = await readFile(completePath, "utf8");

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("ok");
    expect(result.scope).toBe("completed");
    expect(result.scan).toEqual({ submissions_discovered: 0, submissions_validated: 0, gates_evaluated: 0, gates_skipped: 1 });
    expect(result.limitations.join(" ")).toMatch(/submissions.*command logs.*unavailable/i);
    expect(result.limitations.join(" ")).toMatch(/contract-pipeline.*not.*re-evaluated/i);
    expect(existsSync(ARTIFACTS_DIR)).toBe(false);
    expect(await readFile(completePath, "utf8")).toBe(before);
  });

  it.each(["remediation-outcomes.json", "verification_report.json", "remediation-report.md"])("requires retained %s", async (filename) => {
    await writeCompletedArtifacts();
    await rm(join(outputDir, filename));
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain(filename);
  });

  it.each([
    ["malformed JSON", "{"],
    ["null state", "null"],
    ["nonterminal state", JSON.stringify({ status: "planning" })],
    ["malformed plan", JSON.stringify({ status: "complete", plan: {} })],
    ["unsupported version", JSON.stringify({ status: "complete", contract_version: "future" })],
  ])("rejects %s in the complete state", async (_label, content) => {
    await writeCompletedArtifacts();
    await writeFile(completePath, content, "utf8");
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("remediation-state.complete.json");
  });

  it.each(["remediation-outcomes.json", "verification_report.json"])("rejects malformed retained %s", async (filename) => {
    await writeCompletedArtifacts();
    await writeJson(join(outputDir, filename), {});
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain(filename);
  });

  it("rejects an empty human report", async () => {
    await writeCompletedArtifacts();
    await writeFile(join(outputDir, "remediation-report.md"), " \n", "utf8");
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("remediation-report.md");
  });

  it("does not use a prior archive to hide a nonterminal current step", async () => {
    await writeCompletedArtifacts();
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), { status: "ready", step_kind: "implement" });
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toMatch(/current-step.*complete/i);
  });

  it("keeps an active state authoritative over a stale archive", async () => {
    await writeCompletedArtifacts();
    await writeFile(completePath, "invalid JSON", "utf8");
    await saveState();
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("ok");
    expect(result.scope).toBe("active");
  });

  it("does not fall back after a malformed active state", async () => {
    await writeCompletedArtifacts();
    await writeJson(join(ARTIFACTS_DIR, "state.json"), { status: "invalid" });
    await expect(validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).rejects.toThrow(/state.json/);
  });

  it("accepts legitimate planless completion", async () => {
    await writeCompletedArtifacts({ status: "complete" });
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("ok");
  });

  it.each(["broken", [], { "B-001": { unit_id: "other", status: "resolved" } }, { "B-001": { unit_id: "B-001", status: "invented" } }])("rejects malformed retained items: %j", async (items) => {
    const { state } = await writeCompletedArtifacts();
    await writeJson(completePath, { ...state, items });
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("error");
  });

  it("requires archived runtime items for every retained plan unit", async () => {
    const { state } = await writeCompletedArtifacts();
    delete state.items;
    await writeJson(completePath, state);
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("remediation-state.complete.json items");
  });

  it("joins execution and source identities across retained reports", async () => {
    const { outcomes, verification } = await writeCompletedArtifacts();
    outcomes.execution_outcomes[0]!.unit_id = "unrelated";
    outcomes.outcomes[0]!.finding_id = "unrelated";
    verification.units = [];
    verification.findings[0]!.finding_id = "unrelated";
    await writeJson(join(outputDir, "remediation-outcomes.json"), outcomes);
    await writeJson(join(outputDir, "verification_report.json"), verification);
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    for (const field of ["execution units", "verification_report.json units", "remediation-outcomes.json findings", "verification_report.json findings"]) {
      expect(result.issues.join(" ")).toContain(field);
    }
  });

  it("rejects changed unit-to-source links and duplicate report identities", async () => {
    const { outcomes, verification } = await writeCompletedArtifacts();
    outcomes.execution_outcomes[0]!.source_finding_ids = ["F-002"];
    verification.units![0]!.source_finding_ids = ["F-002"];
    outcomes.outcomes[0]!.unit_ids = ["B-002"];
    outcomes.execution_outcomes.push(outcomes.execution_outcomes[0]!);
    await writeJson(join(outputDir, "remediation-outcomes.json"), outcomes);
    await writeJson(join(outputDir, "verification_report.json"), verification);
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("B-001 sources");
    expect(result.issues.join(" ")).toContain("F-001 units");
  });

  it("joins request identity and request units to the retained plan", async () => {
    const state = makePlanningState({ status: "complete" });
    state.plan!.request = { id: "request-1", text: "Fix both findings", source_paths: [] };
    const { outcomes } = await writeCompletedArtifacts(state);
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("ok");
    outcomes.request!.id = "unrelated";
    outcomes.request_outcome!.unit_ids = [];
    await writeJson(join(outputDir, "remediation-outcomes.json"), outcomes);
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("request identity");
    expect(result.issues.join(" ")).toContain("request units");
  });

  it("retains never-planned coverage finding identities", async () => {
    const state = makePlanningState({ status: "complete" });
    const finding = { ...state.plan!.findings[0]!, id: "F-dropped" };
    state.plan_coverage = {
      contract_version: "remediate-code-coverage/v1alpha1", plan_id: state.plan!.plan_id,
      source_finding_count: 3, planned_count: 2, folded_count: 0, dropped_count: 1,
      checkpoint_dropped_count: 0, phantom_dropped_count: 0,
      entries: [{ finding_id: finding.id, finding, disposition: "dropped_no_evidence", rationale: "Fixture exclusion" }],
    };
    await writeCompletedArtifacts(state);
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("ok");
  });

  it.each([
    { contract_version: "future" }, { units: "broken" },
    { units: [{ unit_id: "B-001", source_finding_ids: "broken", traces: [], overall_status: "passed" }] },
    { units: [{ unit_id: "B-001", source_finding_ids: [], traces: [null], overall_status: "passed" }] },
  ])("rejects malformed verification contracts: %j", async (override) => {
    const { verification } = await writeCompletedArtifacts();
    await writeJson(join(outputDir, "verification_report.json"), { ...verification, ...override });
    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);
    expect(result.status).toBe("error");
    expect(result.issues.join(" ")).toContain("verification_report.json");
  });

  async function terminalStep() {
    const stepPath = join(ARTIFACTS_DIR, "steps", "current-step.json");
    const promptPath = join(ARTIFACTS_DIR, "steps", "current-prompt.md");
    await mkdir(dirname(stepPath), { recursive: true });
    await writeFile(promptPath, "Present retained report", "utf8");
    return { contract_version: "remediate-code-step/v1alpha1", step_kind: "present_report", status: "complete",
      run_id: null as string | null, repo_root: REPO_DIR, artifacts_dir: ARTIFACTS_DIR, prompt_path: promptPath,
      allowed_commands: [], stop_condition: "Present report", artifact_paths: {
        final_report: join(outputDir, "remediation-report.md"), current_step: stepPath, current_prompt: promptPath,
      } };
  }

  it("accepts the producer's null terminal run_id and bound paths", async () => {
    await writeCompletedArtifacts();
    const step = await terminalStep();
    await writeJson(step.artifact_paths.current_step, step);
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("ok");
  });

  it.each(["repo_root", "artifacts_dir", "run_id", "prompt_path"] as const)("rejects an unrelated terminal %s", async (field) => {
    await writeCompletedArtifacts();
    const step = await terminalStep();
    step[field] = join(TEST_DIR, "unrelated");
    await writeJson(step.artifact_paths.current_step, step);
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("error");
  });

  it.each(["final_report", "current_step", "current_prompt"] as const)("rejects an unrelated terminal artifact path %s", async (field) => {
    await writeCompletedArtifacts();
    const step = await terminalStep();
    const stepPath = step.artifact_paths.current_step;
    step.artifact_paths[field] = join(TEST_DIR, "unrelated");
    await writeJson(stepPath, step);
    expect((await validateArtifacts(ARTIFACTS_DIR, REPO_DIR)).status).toBe("error");
  });

});
