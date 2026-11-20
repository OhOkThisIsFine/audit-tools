import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await writeFile(join(artifacts, "audit_tasks.json"), JSON.stringify([{
      task_id: "task", unit_id: "unit", pass_id: "pass", lens: "correctness", file_paths: ["a.ts"], rationale: "Smoke",
    }]));
    await writeFile(join(root, ".audit-tools", "audit-report.md"), "# Audit Report\n");
    await writeFile(join(root, ".audit-tools", "audit-findings.json"), "{}");
    await writeFile(join(artifacts, "run-ended.json"), "{}");
    const steps = [
      ...pauses.map(hash => ["analyzer_consent", hash]),
      ["dispatch_review", "ready"],
      ...finalPauses.map(hash => ["synthesis_narrative", hash]),
      ["present_report", "complete"], ["functional_preflight", "next-run"],
    ];
    const respondToSmokeCommand = async (_cmd: string, args: string[]) => {
      if (args[0] !== "next-step") return { stdout: JSON.stringify({ selected_executor: "result_ingestion_executor" }) };
      const entry = steps[index++];
      if (!entry) throw new Error("Producer ran out of steps");
      const [kind, hash] = entry;
      await writeFile(join(artifacts, "artifact_metadata.json"), JSON.stringify({ artifacts: { "audit_tasks.json": { content_hash: hash } } }));
      return { stdout: JSON.stringify({ step_kind: kind, status: kind === "present_report" ? "complete" : "ready",
        contract_version: STEP_CONTRACT_VERSION, run_id: "run", agent_id: "process-" + index,
        prompt_path: join(artifacts, "steps", "process-" + index, "current-prompt.md"), artifacts_dir: artifacts,
        artifact_paths: { analyzer_consent_decisions: join(artifacts, "consent.json"), synthesis_narrative_results: join(artifacts, "narrative.json") } }) };
    };
    await runAuditFlowPhase({ root, runCommand: respondToSmokeCommand, log: { step() {}, detail() {}, elapsed() {} }, smokeLabel: "fixture",
      auditCodeCommand: "audit-code", distCliPath: "fixture-cli" });
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
