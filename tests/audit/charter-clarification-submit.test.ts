import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ClarificationAnswersSubmissionSchema, writeJsonFile } from "audit-tools/shared";
import { submitGateResult } from "../../src/audit/cli/submitGateResult.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { auditReviewBinding } from "../../src/audit/cli/reviewSubmission.js";
import { designReviewInputRevision } from "../../src/audit/orchestrator/designReviewProjection.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";
import { tryConsumeSubmission } from "../../src/audit/cli/nextStepHelpers.js";
import { renderCharterClarificationPrompt } from "../../src/audit/cli/charterClarificationPrompt.js";
import { runCharterClarificationExecutor } from "../../src/audit/orchestrator/charterClarificationExecutor.js";
import { loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";

const lane = GATE_LANES.charter_clarification;

function pendingBundle(): ArtifactBundle {
  const bundle: ArtifactBundle = {
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1", confirmed_at: "2026-11-08T00:00:00Z", confirmed_by: "host",
      scope_summary: "source", intent_summary: "review source",
      design_review: { answered_at: "2026-11-08T00:00:00Z", ceiling: { rung: "deep" }, attention: "all" },
    },
    charter_register: {
      ...EMPTY_REGISTER_BODY, schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-11-08T00:00:00Z", target: "charter", ceiling: { rung: "deep" },
      differences: ["d1", "d2"].map(difference_id => ({
        difference_id, correspondence_id: "c1", dimension: "scope", relation: "incompatible",
        accounts: [
          { kind: "stated", claim: "Review all source", provenance: [] },
          { kind: "revealed", claim: "Review security only", provenance: [] },
        ],
        gap: "Scope differs", routed_to: "clarification", finding_candidate: true,
        fidelity: { verdict: "supported", rationale: "Both accounts are present", decided_by: "lane" },
      })),
    },
  };
  return runCharterClarificationExecutor(bundle).updated;
}

async function writeBundle(artifactsDir: string, bundle: ArtifactBundle): Promise<void> {
  for (const key of ["intent_checkpoint", "charter_register", "charter_clarification"] as const) {
    if (bundle[key]) await writeJsonFile(join(artifactsDir, `${key}.json`), bundle[key]);
  }
}

test("charter gate preserves partial and empty file submissions without applying answers", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "charter-gate-"));
  try {
    const bundle = pendingBundle();
    expect(bundle.charter_clarification!.asked.map(question => question.request_id)).toEqual(["d1:q", "d2:q"]);
    await writeBundle(artifactsDir, bundle);
    const original = await readFile(join(artifactsDir, "charter_clarification.json"), "utf8");
    for (const result of [
      { answers: [{ request_id: "d1:q", answer: { governs: "stated" } }] },
      { answers: [{ request_id: "d1:q", answer: "rewrite_all" }] },
      { answers: [] }, {},
    ]) {
      expect(await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) }))
        .toMatchObject({ written: true, path: laneSubmissionPath(artifactsDir, lane), issues: [] });
      expect(await readFile(join(artifactsDir, "charter_clarification.json"), "utf8")).toBe(original);
      const consumed = await tryConsumeSubmission(artifactsDir, lane);
      expect(consumed).toMatchObject({ status: "ok", value: result });
      if (consumed.status !== "ok") throw new Error("Expected accepted answers");
      const applied = runCharterClarificationExecutor(await loadArtifactBundle(artifactsDir), ClarificationAnswersSubmissionSchema.parse(consumed.value));
      expect(applied.updated.charter_clarification!.asked[0]!.answer).toEqual(result.answers?.[0]?.answer ?? "leave_open");
      expect(applied.updated.charter_clarification!.asked[1]!.answer).toBe("leave_open");
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("charter gate rejects malformed or unasked answers and inactive queues without replacing a submission", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "charter-refuse-"));
  try {
    const bundle = pendingBundle();
    const path = laneSubmissionPath(artifactsDir, lane);
    await writeBundle(artifactsDir, bundle);
    await writeJsonFile(path, { answers: [{ request_id: "d1:q", answer: "leave_open" }] });
    const bytes = await readFile(path, "utf8");
    for (const source of ["{", "[]", '{"answers":null}', '{"extra":true}',
      JSON.stringify({ answers: [{ request_id: "d1:q", answer: "invalid" }] }),
      JSON.stringify({ answers: [{ request_id: "unknown", answer: "leave_open" }] }),
      JSON.stringify({ answers: [{ request_id: "d1:q", answer: "leave_open" }, { request_id: "unknown", answer: "leave_open" }] }),
    ]) {
      expect((await submitGateResult({ artifactsDir, lane, source })).written).toBe(false);
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    const register = bundle.charter_clarification!;
    for (const inactive of [
      { ...register, status: "omitted" as const },
      { ...register, asked: [] },
      { ...register, asked: register.asked.map(question => ({ ...question, answer: "leave_open" as const })) },
    ]) {
      await writeJsonFile(join(artifactsDir, "charter_clarification.json"), inactive);
      expect(await submitGateResult({ artifactsDir, lane, source: "{}" }))
        .toMatchObject({ written: false, issues: [{ code: "charter_clarification_not_pending" }] });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    await rm(join(artifactsDir, "charter_clarification.json"));
    expect(await submitGateResult({ artifactsDir, lane, source: "{}" }))
      .toMatchObject({ written: false, issues: [{ code: "charter_clarification_not_pending" }] });
    expect(await readFile(path, "utf8")).toBe(bytes);
    await writeBundle(artifactsDir, bundle);
    await writeJsonFile(join(artifactsDir, "charter_register.json"), { ...bundle.charter_register, status: "omitted" });
    expect((await submitGateResult({ artifactsDir, lane, source: "{}" })).written).toBe(false);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await rm(join(artifactsDir, "charter_register.json"));
    expect((await submitGateResult({ artifactsDir, lane, source: "{}" })).written).toBe(false);
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("charter admission honors the omit policy and consumption rechecks changed question IDs", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "charter-policy-"));
  try {
    const bundle = pendingBundle();
    await writeBundle(artifactsDir, bundle);
    const result = { answers: [{ request_id: "d1:q", answer: "leave_open" }] };
    expect((await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) })).written).toBe(true);
    const bytes = await readFile(laneSubmissionPath(artifactsDir, lane), "utf8");
    for (const design_review of [
      { ...bundle.intent_checkpoint!.design_review!, attention: 0 },
      { ...bundle.intent_checkpoint!.design_review!, ceiling: { rung: "shallow" as const } },
    ]) {
      await writeJsonFile(join(artifactsDir, "intent_checkpoint.json"), { ...bundle.intent_checkpoint, design_review });
      expect((await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) })).written).toBe(false);
      expect(await readFile(laneSubmissionPath(artifactsDir, lane), "utf8")).toBe(bytes);
    }
    await writeBundle(artifactsDir, bundle);
    const consumed = await tryConsumeSubmission(artifactsDir, lane);
    if (consumed.status !== "ok") throw new Error("Expected stored answers");
    const changed = { ...bundle, charter_clarification: { ...bundle.charter_clarification!, asked: [] } };
    expect(() => runCharterClarificationExecutor(changed, ClarificationAnswersSubmissionSchema.parse(consumed.value)))
      .toThrow(/never asked/);
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("built MCP charter and contract gates coexist without cross-writing or advancing", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "charter-mcp-"));
  const client = new Client({ name: "charter-test-host", version: "test" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/audit/cli.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe" });
  try {
    const bundle = pendingBundle();
    await writeBundle(artifactsDir, bundle);
    await client.connect(transport);
    const result = { answers: [{ request_id: "d1:q", answer: "leave_open" }] };
    const args = { root: artifactsDir, artifacts_dir: artifactsDir, lane, result };
    expect((await client.callTool({ name: "submit_gate", arguments: args })).isError).not.toBe(true);
    const path = laneSubmissionPath(artifactsDir, lane);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    expect((await client.callTool({ name: "submit_gate", arguments: {
      ...args, result: { answers: [{ request_id: "unknown", answer: "leave_open" }] },
    } })).isError).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    const prompt = renderCharterClarificationPrompt(bundle, { answersPath: path, continueCommand: "audit-code next-step" });
    expect(prompt).toContain("submit_gate");
    expect(prompt).toContain("charter_clarification");
    expect(prompt).toContain(path);
    expect(prompt).toContain("audit-code next-step");
    expect(prompt.indexOf("submit_gate")).toBeLessThan(prompt.indexOf(path));

    const contractLane = GATE_LANES.design_review_contract;
    const assessment = { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false };
    await writeJsonFile(join(artifactsDir, "design_assessment.json"), assessment);
    const before = await loadArtifactBundle(artifactsDir);
    const workflowPaths = ["intent_checkpoint", "charter_register", "charter_clarification", "design_assessment"]
      .map(name => join(artifactsDir, `${name}.json`));
    const workflowBytes = await Promise.all(workflowPaths.map(path => readFile(path, "utf8")));
    const fanout = await materializeFanoutLanes({ artifactsDir, sourceRoot: artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [{ id: contractLane, label: "Contract review", promptFilename: "contract-review.md", promptText: "Review the contract.",
        semanticInputRevision: designReviewInputRevision(before), fileCount: 0, riskScore: 0.8 }] });
    const binding = await auditReviewBinding(artifactsDir, contractLane);
    const envelope = { contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
      review: { mode: "independent", reason: "A separate context reviewed the contract." }, result: { findings: [] } };
    const contractArgs = { ...args, lane: contractLane, result: envelope };
    expect((await client.callTool({ name: "submit_gate", arguments: contractArgs })).isError).not.toBe(true);
    const contractPath = fanout.lanes[0]!.resultPath;
    const contractBytes = await readFile(contractPath, "utf8");
    const charterBytes = await readFile(path, "utf8");
    expect(contractPath).not.toBe(path);
    expect(JSON.parse(contractBytes)).toEqual(envelope);
    expect(JSON.parse(charterBytes)).toEqual(result);
    for (const wrong of [{ ...args, result: envelope }, { ...contractArgs, result }]) {
      expect((await client.callTool({ name: "submit_gate", arguments: wrong })).isError).toBe(true);
      expect(await readFile(contractPath, "utf8")).toBe(contractBytes);
      expect(await readFile(path, "utf8")).toBe(charterBytes);
    }
    expect(await Promise.all(workflowPaths.map(path => readFile(path, "utf8")))).toEqual(workflowBytes);
    expect((await readSubmissionLedger(artifactsDir)).some(event => event.kind === "accepted")).toBe(false);
  } finally {
    await client.close(); await transport.close();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
