import { expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "../../../src/shared/index.js";
import { buildNextContractPipelineStep, writePathASeedFromFindings } from "../../../src/remediate/steps/contractPipeline.js";
import { executionPlanPaths, readPlanSource, readCanonicalPlan, ingestExecutionPlan, readPlanReviewHistory } from "../../../src/remediate/contractPipeline/executionPlan.js";
import type { Finding } from "../../../src/shared/types/finding.js";
import type { ExecutableChangePlan } from "../../../src/shared/types/executionPlan.js";


export async function createExecutablePlanFixture(findings: Finding[] = []) {
  const root = await mkdtemp(join(tmpdir(), "reviewed-execution-plan-"));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  await mkdir(artifactsDir, { recursive: true });
  const input = join(root, "request.txt"); await writeFile(input, "Add a bounded greeting function and test it.");
  const options = { root, artifactsDir, runId: "test-run", sourcePaths: [input] };
  if (findings.length) { const report={findings,audit_read:null}; await writeFile(input,JSON.stringify(report)); await writePathASeedFromFindings(artifactsDir,input,report); }
  await buildNextContractPipelineStep(options);
  const source = (await readPlanSource(artifactsDir))!;
  const plan: ExecutableChangePlan = {
    plan_id: source.plan_id, objective: "Add a greeting", non_goals: [], source_dispositions: [],
    requirements: [{ id: "REQ-greeting", description: "Return the requested greeting", source_finding_ids: findings.map(finding=>finding.id), change_kind: "addition", assertions: [{ kind: "positive", description: "Returns hello", scope_paths: ["greeting.ts"] }] }],
    units: [{ id: "UNIT-greeting", title: "Implement greeting", description: "Implement and test the greeting", source_finding_ids: findings.map(finding=>finding.id), requirement_ids: ["REQ-greeting"], dependencies: [], read_paths: ["request.txt"], allowed_files: ["greeting.ts"], required_tests: ["node --test"], affected_interfaces: [], addresses_counterexample_ids: [] }],
  };
  const paths = executionPlanPaths(artifactsDir);
  await writeJsonFile(paths.submission, { base_revision_sha256: null, plan, retired_requirements: [] });
  expect((await ingestExecutionPlan(options)).issues).toEqual([]);
  return { root, input, artifactsDir, options, plan, paths };
}
export async function approveExecutablePlanFixture(f: Awaited<ReturnType<typeof createExecutablePlanFixture>>, declined = false) {
  const canonical = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(join(f.paths.directory, "owner-decision.json"), { revision_sha256: canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: declined ? [] : f.plan.units.map(unit => unit.id), declined_units: declined ? f.plan.units.map(unit => ({ id: unit.id, reason: "Operator declined" })) : [] });
  for (const role of ["critique", "critic", "judge"] as const) {
    const step = await buildNextContractPipelineStep(f.options);
    expect(step?.step_kind).toBe("contract_pipeline");
    const request = (await readOptionalJsonFile<{ prompt_sha256: string }>(f.paths.review(role).request))!;
    expect(request?.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    const history = await readPlanReviewHistory(f.artifactsDir);
    const result = role === "critique" ? { verdict: "approved", issues: [] } : role === "critic" ? { counterexamples: [] } : { verdict: "approved", classifications: history.accepted_ids.map(id => ({counterexample_id:id,classification:"repaired",rationale:"Revised scoped assertion addresses the reproduction"})), requirement_assessments: f.plan.requirements.map(requirement => ({ requirement_id: requirement.id, verdict: "satisfied", evidence: ["Checked scoped source and assertions"] })), disposition_assessments: [] };
    await writeJsonFile(f.paths.review(role).submission, { contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256, review: { mode: "independent", reason: "A separate fixture reviewer" }, result });
  }
  expect(await buildNextContractPipelineStep(f.options)).toBeNull();
}
