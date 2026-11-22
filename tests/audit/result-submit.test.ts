/** The CLI and MCP command use the same durable question-review submission route. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";
import { deriveCurrentQuestionBindings } from "../../src/audit/cli/questionReviewCycle.js";
import { writeCoreArtifacts, loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { ensureRunSourceRoot } from "../../src/audit/io/runSnapshot.js";
import { hashContent } from "../../src/shared/hash.js";
import { cmdSubmit, submitWorkItemResult } from "../../src/audit/cli/submitCommand.js";
import { ingestAuditQuestionResults, publishAuditQuestionWorkload } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewSubmission } from "../../src/shared/types/reviewQuestion.js";
import { captureConsole } from "./helpers/captureConsole.mjs";

const cli = fileURLToPath(new URL("../../dist/audit/cli.js", import.meta.url));
const runId = "question-review-51c7103a-91f9-4446-9882-58106c448b50";
const identity = { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, question_id: "resume", revision_id: "r1", snapshot_id: "frozen" } as const;
const ref = { path: "src/resume.ts", start_line: 1 };
const submission: ReviewSubmission = {
  ...identity, assignment_id: "assignment-a", submission_id: "submission-a", inspected_sources: [ref], evidence_ids: [], limitations: ["Scheduled resume not inspected"],
  answer: { outcome: "clean", findings: [], parts: [{ part_id: "manual", outcome: "clean", observation_ids: ["obs"] }],
    observations: [{ ...identity, part_id: "manual", observation_id: "obs", kind: "source_confirmed", statement: "The manual path retains unfinished work", source_refs: [ref], evidence_refs: [] }] },
};

async function fixture(run: (params: { root: string; artifactsDir: string; runId: string; ledgerPath: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "audit-question-submit-"));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const ledgerPath = join(artifactsDir, "runs", runId, "host-accepted-results-ledger.json");
  try {
    await mkdir(artifactsDir, { recursive: true });
    await run({ root, artifactsDir, runId, ledgerPath });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function issue(params: { root: string; artifactsDir: string; runId: string }, publish = true) {
  await writeFile(join(params.artifactsDir, "review_session.json"), JSON.stringify({
    schema_version: "audit-tools/question-review-session/v1", run_id: params.runId,
  }));
  const source = "export const pending = true;\n";
  await mkdir(join(params.root, "src"), { recursive: true });
  await writeFile(join(params.root, ref.path), source);
  const sourceRoot = await ensureRunSourceRoot(params.root, params.artifactsDir);
  const fingerprint = hashContent(source);
  const dependency = { kind: "source" as const, key: ref.path, fingerprint };
  const bundle: ArtifactBundle = {
    repo_manifest: { repository: { name: "submit fixture" }, generated_at: "2026-11-22T00:00:00Z",
      files: [{ path: ref.path, language: "ts", size_bytes: Buffer.byteLength(source), hash: fingerprint }] },
    file_disposition: { files: [{ path: ref.path, status: "included" }] },
    review_plan: {
      schema_version: identity.schema_version, snapshot_id: identity.snapshot_id,
      inventory: [{ inventory_item_id: "resume", kind: "operation", title: "Resume",
        source_refs: [ref], contract_refs: [], scope: "in_scope" }],
      questions: [{
        ...identity, lens: "behavior", inventory_item_ids: ["resume"], expected_outcome: "retain unfinished work",
        requested_parts: [{ part_id: "manual", expectation: "retain work" }, { part_id: "scheduled", expectation: "retain work" }],
        source_dependencies: [dependency], evidence_dependencies: [], plan_status: "pending",
      }],
      lens_decisions: [], omissions: [],
    },
  };
  await writeCoreArtifacts(params.artifactsDir, bundle);
  const { bindings } = await deriveCurrentQuestionBindings(bundle, sourceRoot);
  if (publish) await publishAuditQuestionWorkload({ ...params, sourceRoot, bindings });
  return { sourceRoot, answer: { ...submission, assignment_id: bindings[0]!.assignment.assignment_id } };
}


test("CLI submission durably records the answer and exact replay does not rewrite the ledger", async () => {
  await fixture(async (params) => {
    const { answer } = await issue(params);
    const from = join(params.root, "answer.json");
    const argv = ["--root", params.root, "--artifacts-dir", params.artifactsDir, "--work-item", answer.assignment_id, "--from", from];
    await writeFile(from, JSON.stringify({ contract_version: "audit-host-result/v1alpha1", work_item_id: answer.assignment_id, file_coverage: [], findings: [] }));
    await expect(cmdSubmit(argv)).rejects.toThrow();
    await expect(readFile(params.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(from, JSON.stringify(answer));
    const first = await captureConsole(() => cmdSubmit(argv));
    expect(JSON.parse(first.stdout)).toMatchObject({ disposition: "accepted", submission_id: answer.submission_id, written: true });
    const before = await readFile(params.ledgerPath, "utf8");
    const second = await captureConsole(() => cmdSubmit(argv));
    expect(JSON.parse(second.stdout)).toMatchObject({ disposition: "replay", written: true });
    expect(await readFile(params.ledgerPath, "utf8")).toBe(before);
    expect((await ingestAuditQuestionResults(params)).answers.map((answer) => answer.submission)).toEqual([answer]);
  });
});

test("built MCP submit_result accepts the exact question assignment and refuses conflicting reuse", async () => {
  await fixture(async (params) => {
    const { answer } = await issue(params);
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"] });
    const client = new Client({ name: "question-submission-test", version: "1" });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      expect(tools.map(({ name }) => name)).toEqual(["submit_result", "submit_gate"]);
      expect(tools[0]?.description).toContain("durably accepts");
      const request = { root: params.root, artifacts_dir: params.artifactsDir, work_item_id: answer.assignment_id };
      const submit = (result: ReviewSubmission) => client.callTool({ name: "submit_result", arguments: { ...request, result } });
      const first = await submit(answer);
      expect(first.isError).not.toBe(true);
      expect(first.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"accepted"') })]);
      const conflict = await submit({ ...answer, limitations: ["different observation limits"] });
      expect(conflict.isError).toBe(true);
      expect(conflict.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/Conflicting reuse/) })]);
      expect((await ingestAuditQuestionResults(params)).answers).toHaveLength(1);
    } finally { await client.close(); }
  });
});

test("submit refuses an archive and a session without issued work without writing a ledger", async () => {
  await fixture(async (params) => {
    const send = () => submitWorkItemResult({ ...params, workItemId: submission.assignment_id, source: JSON.stringify(submission) });
    const archive = join(params.artifactsDir, "dispatch");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "current-review-run.json"), JSON.stringify({ run_id: "legacy-archived-run" }));
    await expect(send()).rejects.toThrow(/legacy file-review runs are archival/i);
    await issue(params, false);
    await expect(send()).rejects.toThrow();
    await expect(readFile(params.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await issue(params);
    await writeFile(join(params.artifactsDir, "run-ended.json"), "{}");
    await expect(send()).rejects.toThrow(/no active question-review run/i);
    await expect(readFile(params.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test.each(["changed frozen bytes", "replanned revision"] as const)(
  "direct submission refuses %s without appending old history",
  async change => fixture(async params => {
    const { answer, sourceRoot } = await issue(params);
    const send = () => submitWorkItemResult({
      ...params, workItemId: answer.assignment_id, source: JSON.stringify(answer),
    });
    if (change === "changed frozen bytes") {
      const path = join(sourceRoot, ref.path);
      await writeFile(path, (await readFile(path, "utf8")).replace("pending", "settled"));
    } else {
      const bundle = await loadArtifactBundle(params.artifactsDir);
      const plan = bundle.review_plan!;
      await writeCoreArtifacts(params.artifactsDir, {
        review_plan: { ...plan, questions: [{ ...plan.questions[0]!, revision_id: "new-revision" }] },
      });
    }
    await expect(send()).rejects.toThrow(/frozen source changed|issued review assignment is no longer current/);
    await expect(readFile(params.ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
  }),
);
