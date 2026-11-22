import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuditFlowPhase, STEP_CONTRACT_VERSION } from "../../scripts/audit/smoke-audit-flow.mjs";

async function exercise(pauses: string[], finalPauses: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "audit-smoke-progress-"));
  const artifacts = join(root, ".audit-tools", "audit");
  let index = 0;
  try {
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(root, "a.ts"), "export {};\n");
    const contractVersion = "audit-tools/question-review/v1";
    const question = { question_id: "question", revision_id: "revision", snapshot_id: "snapshot", requested_parts: [{ part_id: "part" }] };
    const assignment = { assignment_id: "assignment" };
    const hostWorkload = join(artifacts, "host-workload.json");
    await writeFile(hostWorkload, JSON.stringify({ contract_version: contractVersion, run_id: "run",
      work_items: [{ binding: { question, assignment } }] }));
    await writeFile(join(artifacts, "review_plan.json"), "{}");
    const accepted: { submission: { submission_id: string } }[] = [];
    const steps = [
      ...pauses.map(hash => ["analyzer_consent", hash]),
      ["dispatch_review", "ready"],
      ...finalPauses.map(hash => ["synthesis_narrative", hash]),
      ["present_report", "complete"], ["functional_preflight", "next-run"],
    ];
    const respondToSmokeCommand = async (_cmd: string, args: string[]) => {
      if (args[0] !== "next-step") {
        expect(args.slice(0, 4)).toEqual(["submit", "--work-item", assignment.assignment_id, "--from"]);
        const submission = JSON.parse(await readFile(args[4]!, "utf8"));
        expect(submission).toMatchObject({
          schema_version: contractVersion, assignment_id: assignment.assignment_id,
          question_id: question.question_id, revision_id: question.revision_id, snapshot_id: question.snapshot_id,
          answer: { outcome: "inconclusive", findings: [], observations: [], parts: [{ part_id: "part", outcome: "inconclusive" }] },
        });
        accepted.push({ submission });
        return { stdout: JSON.stringify({ disposition: "accepted", submission_id: submission.submission_id }) };
      }
      const entry = steps[index++];
      if (!entry) throw new Error("Producer ran out of steps");
      const [kind, hash] = entry;
      if (kind === "present_report") {
        expect(accepted).toHaveLength(1);
        await writeFile(join(root, ".audit-tools", "audit-report.md"), "# Audit Report\n");
        await writeFile(join(root, ".audit-tools", "audit-findings.json"), JSON.stringify({
          findings: [], question_review: { completion: "incomplete", accepted, questions: [{ parts: [{ state: "inconclusive" }] }] },
        }));
        await writeFile(join(artifacts, "run-ended.json"), "{}");
      }
      await writeFile(join(artifacts, "artifact_metadata.json"), JSON.stringify({ artifacts: { "review_plan.json": { content_hash: hash } } }));
      return { stdout: JSON.stringify({ step_kind: kind, status: kind === "present_report" ? "complete" : "ready",
        contract_version: STEP_CONTRACT_VERSION, run_id: "run", agent_id: "process-" + index,
        prompt_path: join(artifacts, "steps", "process-" + index, "current-prompt.md"), artifacts_dir: artifacts,
        artifact_paths: { host_workload: hostWorkload, analyzer_consent_decisions: join(artifacts, "consent.json"), synthesis_narrative_results: join(artifacts, "narrative.json") } }) };
    };
    await runAuditFlowPhase({ root, runCommand: respondToSmokeCommand, log: { step() {}, detail() {}, elapsed() {} },
      auditCodeCommand: "audit-code" });
    return index;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("both smoke walks continue while the producer changes its artifacts", async () => {
  const revisions = Array.from({ length: 9 }, (_, i) => "content-" + i);
  expect(await exercise(revisions, revisions)).toBe(21);
});

test("returning to a previously answered obligation and artifact state fails with its gate name", async () => {
  await expect(exercise(["first", "second", "first"])).rejects.toThrow(/analyzer_consent.*(?:repeated|progress)|(?:repeated|progress).*analyzer_consent/i);
  await expect(exercise([], ["first", "first"])).rejects.toThrow(/synthesis_narrative.*(?:repeated|progress)|(?:repeated|progress).*synthesis_narrative/i);
});
