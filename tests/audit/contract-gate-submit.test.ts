import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeJsonFile } from "audit-tools/shared";
import { submitGateResult } from "../../src/audit/cli/submitGateResult.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, GATE_LANES } from "../../src/audit/cli/laneSubmissions.js";
import { auditReviewBinding } from "../../src/audit/cli/reviewSubmission.js";
import { handleDesignReviewBranch, tryConsumeSubmission } from "../../src/audit/cli/nextStepHelpers.js";
import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { designReviewInputRevision } from "../../src/audit/orchestrator/designReviewProjection.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";
import { withArtifactTreeHold } from "../../src/shared/io/artifactTreeHold.js";
import { artifactTreeLockPath } from "../../src/shared/io/auditToolsPaths.js";
import * as fileLock from "../../src/shared/io/fileLock.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const lane = GATE_LANES.design_review_contract;
const finding = {
  id: "DR-1", title: "Conflicting limits", category: "inferred_contract_gap", severity: "high",
  confidence: "medium", lens: "architecture", summary: 'Preserve \\s and "quotes"', affected_files: [],
};

async function fixture() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "contract-submit-")); roots.push(artifactsDir);
  const bundle: ArtifactBundle = {
    design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false },
    repo_manifest: { repository: { name: "fixture" }, generated_at: "now", files: [{ path: "known.ts", language: "typescript", size_bytes: 1 }] },
  };
  await writeJsonFile(join(artifactsDir, "design_assessment.json"), bundle.design_assessment);
  await writeJsonFile(join(artifactsDir, "repo_manifest.json"), bundle.repo_manifest);
  const contextPath = join(artifactsDir, "context.json");
  await writeFile(contextPath, "{}");
  const fanout = await materializeFanoutLanes({ artifactsDir, sourceRoot: artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
    lanes: [{ id: lane, label: "Contract review", promptFilename: "contract.md", promptText: "Review the contract.",
      fileCount: 1, riskScore: 0.8, semanticInputRevision: designReviewInputRevision(bundle), contextPaths: [contextPath] }] });
  const binding = await auditReviewBinding(artifactsDir, lane);
  const envelope = { contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
    review: { mode: "independent", reason: "This context did not author the contract." }, result: { findings: [finding] } };
  return { artifactsDir, bundle, contextPath, materialized: fanout.lanes[0]!, envelope,
    submit: (value: unknown) => submitGateResult({ artifactsDir, lane, source: JSON.stringify(value) }) };
}

test("contract gate writes the full envelope without advancing and feeds the existing consumer", async () => {
  const f = await fixture();
  for (const result of [[finding], { findings: [finding] }, { alternate: [finding] }, []]) {
    const envelope = { ...f.envelope, result };
    expect(await f.submit(envelope)).toMatchObject({ written: true, path: f.materialized.resultPath, issues: [] });
    expect(JSON.parse(await readFile(f.materialized.resultPath, "utf8"))).toEqual(envelope);
    expect((await loadArtifactBundle(f.artifactsDir)).design_assessment).toEqual(f.bundle.design_assessment);
    expect((await readSubmissionLedger(f.artifactsDir)).some(event => event.kind === "accepted")).toBe(false);
    expect(await tryConsumeSubmission(f.artifactsDir, lane, undefined, designReviewInputRevision(f.bundle)))
      .toMatchObject({ status: "ok", value: result });
  }
  await f.submit(f.envelope);
  const tx = createFoldTransaction();
  const branch = await handleDesignReviewBranch({ artifactsDir: f.artifactsDir }, f.bundle, { status: "active", obligations: [] }, tx);
  const bundle = branch.action === "continue" ? branch.bundle : branch.result.bundle;
  expect(bundle.design_assessment?.contract_reviewed).toBe(true);
  expect(bundle.design_assessment?.contract_findings).toEqual([expect.objectContaining({ id: finding.id, severity: "high" })]);
  expect(tx.staged.some(item => item.applied)).toBe(true);
});

test("contract admission refuses malformed, self, stale and invalid findings without replacing valid bytes", async () => {
  const f = await fixture();
  expect((await f.submit(f.envelope)).written).toBe(true);
  const bytes = await readFile(f.materialized.resultPath, "utf8");
  for (const value of [
    f.envelope.result, [], { ...f.envelope, prompt_sha256: "0".repeat(64) },
    { ...f.envelope, review: { mode: "degraded", reason: "Same context" } },
    { ...f.envelope, review: { mode: "unavailable", reason: "No reviewer" }, result: null },
    { ...f.envelope, result: {} }, { ...f.envelope, result: { findings: [], other: [] } },
    ...[null, { ...finding, severity: "high or low" }, { ...finding, evidence_lane: "design-review-lane" },
      { ...finding, verification_status: "verified" }].map(item => ({ ...f.envelope, result: [item] })),
  ]) {
    expect((await f.submit(value)).written, JSON.stringify(value)).toBe(false);
    expect(await readFile(f.materialized.resultPath, "utf8")).toBe(bytes);
  }
  expect((await submitGateResult({ artifactsDir: f.artifactsDir, lane, source: "{" })).written).toBe(false);
  for (const unsupported of [GATE_LANES.design_review_conceptual, GATE_LANES.analyzer_consent, "../../escape"]) {
    expect(await submitGateResult({ artifactsDir: f.artifactsDir, lane: unsupported, source: JSON.stringify(f.envelope) }))
      .toMatchObject({ written: false, issues: [{ code: "unsupported_lane" }] });
  }
  expect(await readFile(f.materialized.resultPath, "utf8")).toBe(bytes);
});

test("contract admission waits for the artifact hold before reading current inputs", async () => {
  const f = await fixture();
  let pending!: ReturnType<typeof f.submit>;
  let completed = false;
  await withArtifactTreeHold(f.artifactsDir, undefined, async () => {
    let requested!: () => void;
    const lockRequested = new Promise<void>(resolve => { requested = resolve; });
    const actual = fileLock.withFileLock;
    const observer = vi.spyOn(fileLock, "withFileLock").mockImplementation((...args) => {
      if (args[0] === artifactTreeLockPath(f.artifactsDir)) requested();
      return actual(...args);
    });
    try {
      pending = f.submit(f.envelope).then(result => { completed = true; return result; });
      expect(await Promise.race([lockRequested.then(() => "lock"), pending.then(() => "completed")])).toBe("lock");
      expect(completed).toBe(false);
      await writeJsonFile(join(f.artifactsDir, "repo_manifest.json"), { repository: { name: "changed under hold" }, generated_at: "now", files: [] });
    } finally { observer.mockRestore(); }
  });
  expect(await pending).toMatchObject({ written: false, issues: [{ code: "binding_stale" }] });
  await expect(readFile(f.materialized.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("contract consumption recomputes supplied grounding instead of trusting it", async () => {
  const f = await fixture();
  expect((await f.submit({ ...f.envelope, result: [{ ...finding, grounding: { status: "grounded" } }] })).written).toBe(true);
  const branch = await handleDesignReviewBranch({ artifactsDir: f.artifactsDir }, f.bundle, { status: "active", obligations: [] }, createFoldTransaction());
  const bundle = branch.action === "continue" ? branch.bundle : branch.result.bundle;
  expect(bundle.design_assessment?.contract_reviewed).toBe(true);
  expect(bundle.design_assessment?.contract_findings).toEqual([
    expect.objectContaining({ id: finding.id, grounding: expect.objectContaining({ status: "ungrounded" }) }),
  ]);
});

test("contract admission and later consumption both refuse changed semantic inputs", async () => {
  const f = await fixture();
  expect((await f.submit(f.envelope)).written).toBe(true);
  const bytes = await readFile(f.materialized.resultPath, "utf8");
  const manifest = { repository: { name: "changed" }, generated_at: "now", files: [] };
  await writeJsonFile(join(f.artifactsDir, "repo_manifest.json"), manifest);
  expect(await f.submit(f.envelope)).toMatchObject({ written: false, issues: [{ code: "binding_stale" }] });
  expect(await readFile(f.materialized.resultPath, "utf8")).toBe(bytes);
  const current = await loadArtifactBundle(f.artifactsDir);
  expect(await tryConsumeSubmission(f.artifactsDir, lane, undefined, designReviewInputRevision(current)))
    .toMatchObject({ status: "malformed" });
});

test("contract admission refuses missing bindings and changed bound context", async () => {
  const f = await fixture();
  expect((await f.submit(f.envelope)).written).toBe(true);
  const bytes = await readFile(f.materialized.resultPath, "utf8");
  await writeFile(f.contextPath, '{"changed":true}');
  expect(await f.submit(f.envelope)).toMatchObject({ written: false, issues: [{ code: "binding_missing" }] });
  expect(await readFile(f.materialized.resultPath, "utf8")).toBe(bytes);
  const other = await mkdtemp(join(tmpdir(), "contract-no-binding-")); roots.push(other);
  expect(await submitGateResult({ artifactsDir: other, lane, source: JSON.stringify(f.envelope) }))
    .toMatchObject({ written: false, issues: [{ code: "binding_missing" }] });
});

test("contract prompt offers structured submission with the entire envelope and keeps file fallback", async () => {
  const f = await fixture();
  const prompt = await readFile(f.materialized.promptPath, "utf8");
  expect(prompt).toContain("submit_gate");
  expect(prompt).toContain('"lane":"design_review_contract"');
  expect(prompt).toContain("entire review envelope");
  expect(prompt).toContain("If this lane cannot write files");
  expect(prompt).not.toContain("next-step");
  const other = await materializeFanoutLanes({ artifactsDir: f.artifactsDir, sourceRoot: f.artifactsDir, runId: AUDIT_GATE_SUBMISSION_SCOPE,
    lanes: [{ id: GATE_LANES.design_review_conceptual, label: "Conceptual", promptFilename: "conceptual.md", promptText: "Review", fileCount: 1, riskScore: 0.8 }] });
  expect(await readFile(other.lanes[0]!.promptPath, "utf8")).not.toContain("submit_gate");
});

test("built MCP contract gate accepts a bound envelope and rejects raw findings", async () => {
  const f = await fixture();
  const client = new Client({ name: "contract-gate-test", version: "test" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/audit/cli.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe" });
  try {
    await client.connect(transport);
    const args = { root: f.artifactsDir, artifacts_dir: f.artifactsDir, lane };
    expect((await client.callTool({ name: "submit_gate", arguments: { ...args, result: f.envelope } })).isError).not.toBe(true);
    const bytes = await readFile(f.materialized.resultPath, "utf8");
    expect(JSON.parse(bytes)).toEqual(f.envelope);
    expect((await client.callTool({ name: "submit_gate", arguments: { ...args, result: f.envelope.result } })).isError).toBe(true);
    expect(await readFile(f.materialized.resultPath, "utf8")).toBe(bytes);
  } finally { await client.close(); await transport.close(); }
});
