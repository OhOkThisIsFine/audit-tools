import { afterEach, expect, test } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "../../src/shared/index.js";
import type { IntentCheckpoint } from "../../src/shared/types/intentCheckpoint.js";
import {
  ingestExecutionPlan, readCanonicalPlan, readExecutionIntent, readPlanSource, readApprovedExecutionPlan, readPlanReviewHistory,
} from "../../src/remediate/contractPipeline/executionPlan.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { canonicalPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { createExecutablePlanFixture, approveExecutablePlanFixture } from "./helpers/executablePlanFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const value = await createExecutablePlanFixture();
  roots.push(value.root);
  return value;
}
async function submit(f: Awaited<ReturnType<typeof fixture>>) {
  const prior = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(f.paths.submission, { base_revision_sha256: prior.revision_sha256, plan: f.plan, retired_requirements: [] });
  return ingestExecutionPlan(f.options);
}
async function bindIntent(f: Awaited<ReturnType<typeof fixture>>, scope: Partial<IntentCheckpoint>) {
  await writeJsonFile(join(f.artifactsDir, "intent_checkpoint.json"), {
    schema_version: "intent-checkpoint/v1", confirmed_at: "2026-09-30", confirmed_by: "host",
    scope_summary: "Approved source", intent_summary: "Implement greeting", ...scope,
  });
  await writeJsonFile(f.paths.source, { ...(await readPlanSource(f.artifactsDir))!, intent: await readExecutionIntent(f.artifactsDir) });
}

test("mechanical path normalization precedes independent review and produces dispatchable grants", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "src"));
  const sourceBytes = await readFile(f.paths.source, "utf8");
  f.plan.units[0]!.read_paths = [join(f.root, "request.txt")];
  f.plan.units[0]!.allowed_files = ["./greeting.ts", ".\\src\\"];
  f.plan.requirements[0]!.assertions[0]!.scope_paths = [".\\greeting.ts"];
  expect((await submit(f)).issues).toEqual([]);
  const canonical = (await readCanonicalPlan(f.artifactsDir))!;
  expect(canonical.plan.units[0]!.read_paths).toEqual(["request.txt"]);
  expect(canonical.plan.units[0]!.allowed_files).toEqual(["greeting.ts", "src/"]);
  expect(canonical.plan.requirements[0]!.assertions[0]!.scope_paths).toEqual(["greeting.ts"]);
  expect(await readFile(f.paths.source, "utf8")).toBe(sourceBytes);
  await approveExecutablePlanFixture(f);
  const source = (await readPlanSource(f.artifactsDir))!;
  const state: RemediationState = {
    contract_version: REMEDIATION_STATE_CONTRACT_VERSION, status: "implementing",
    plan: canonicalPlanFixture({ ...canonical.plan, review_revision_sha256: canonical.revision_sha256,
      findings: source.findings, request: source.request, audit_read: source.audit_read ?? undefined }),
    items: Object.fromEntries(canonical.plan.units.map(unit => [unit.id, { unit_id: unit.id, status: "pending" }])),
  };
  const prepared = await prepareRemediationHostHandoff({ ...f.options, baselineCommit: "1".repeat(40), state });
  expect(prepared).not.toBe("unsupported_retired_state");
  if (prepared === "unsupported_retired_state") throw new Error(prepared);
  expect(prepared.workload.work_items[0]!.allowed_files).toEqual(["greeting.ts", "src/"]);
});

test.each(["../outside.ts", "..\\outside.ts"])("normalization never turns escape %s into a grant", async path => {
  const f = await fixture();
  const before = await readFile(f.paths.canonical, "utf8");
  f.plan.units[0]!.allowed_files = [path];
  expect((await submit(f)).issues.join(" ")).toMatch(/escapes|beneath/);
  expect(await readFile(f.paths.canonical, "utf8")).toBe(before);
});

test("a path alias cannot evade an owner exclusion before canonical review", async () => {
  const f = await fixture();
  await bindIntent(f, { must_not_touch: ["greeting.ts"] });
  f.plan.units[0]!.allowed_files = ["./greeting.ts"];
  expect((await submit(f)).issues.join(" ")).toMatch(/forbidden.*greeting\.ts/);
});

test.each(["excluded", "generated", "vendor"] as const)("directory grants cannot include %s disposition overrides", async status => {
  const f = await fixture();
  await mkdir(join(f.root, "src"));
  await bindIntent(f, { disposition_overrides: [{ path: "src/protected", status, reason: "Owner excluded generated/vendor material" }] });
  f.plan.units[0]!.allowed_files = ["src/"];
  expect((await submit(f)).issues.join(" ")).toMatch(/directory grant.*src\/protected/);
});

test("directory grants outside the excluded subtree remain valid", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "src", "allowed"), { recursive: true });
  await bindIntent(f, { disposition_overrides: [{ path: "src/protected", status: "excluded", reason: "Owner scope" }] });
  f.plan.units[0]!.allowed_files = ["src/allowed/"];
  expect((await submit(f)).issues).toEqual([]);
});

test("normalization does not split or authorize shell command chains", async () => {
  const f = await fixture();
  f.plan.units[0]!.required_tests = ["node --test && node deploy.js"];
  expect((await submit(f)).issues.join(" ")).toMatch(/one invocation/);
});

test("a cached judge receipt with invalid independence yields a fresh review instead of an activation loop", async () => {
  const f = await fixture();
  await approveExecutablePlanFixture(f);
  const judge = (await readOptionalJsonFile<{ provenance: { review: { mode: string } } }>(f.paths.review("judge").accepted))!;
  judge.provenance.review.mode = "degraded";
  await writeJsonFile(f.paths.review("judge").accepted, judge);
  await rm(f.paths.review("judge").submission);
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
  const step = await buildNextContractPipelineStep(f.options);
  expect(step?.step_kind).toBe("contract_pipeline");
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});

test("malformed residual-risk acceptance pauses rather than repeatedly issuing unusable approval", async () => {
  const f = await fixture();
  const canonical = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(join(f.paths.directory, "owner-decision.json"), {
    revision_sha256: canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: [f.plan.units[0]!.id], declined_units: [],
  });
  for (const role of ["critique", "critic", "judge"] as const) {
    await buildNextContractPipelineStep(f.options);
    const request = (await readOptionalJsonFile<{ prompt_sha256: string }>(f.paths.review(role).request))!;
    const result = role === "critique" ? { verdict: "approved", issues: [] } : role === "critic" ? {
      counterexamples: [{ id: "CE-risk", claim: "Unicode handling is limited", reproduction_steps: ["Pass an unusual Unicode name"],
        expected: "Greeting", actual: "Unknown", requirement_ids: ["REQ-greeting"], unit_ids: ["UNIT-greeting"] }],
    } : {
      verdict: "approved", classifications: [{ counterexample_id: "CE-risk", classification: "residual_risk", rationale: "Explicit owner choice" }],
      requirement_assessments: [{ requirement_id: "REQ-greeting", verdict: "satisfied", evidence: ["Checked ordinary case"] }], disposition_assessments: [],
    };
    await writeJsonFile(f.paths.review(role).submission, { contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
      review: { mode: "independent", reason: "Independent fixture reviewer" }, result });
  }
  expect((await buildNextContractPipelineStep(f.options))?.status).toBe("blocked");
  await writeJsonFile(join(f.paths.directory, "risk-decisions.json"), {
    revision_sha256: canonical.revision_sha256, confirmed_by: "host", accepted_counterexample_ids: "CE-risk",
  });
  expect((await buildNextContractPipelineStep(f.options))?.status).toBe("blocked");
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});

test("conceptual repairs have an eight-decision bound and repeated author pauses do not consume it", async () => {
  const f = await fixture();
  for (let round = 0; round <= 8; round++) {
    const canonical = (await readCanonicalPlan(f.artifactsDir))!;
    await writeJsonFile(join(f.paths.directory, "owner-decision.json"), {
      revision_sha256: canonical.revision_sha256, confirmed_by: "host", approved_unit_ids: [f.plan.units[0]!.id], declined_units: [],
    });
    await buildNextContractPipelineStep(f.options);
    const request = (await readOptionalJsonFile<{ prompt_sha256: string }>(f.paths.review("critique").request))!;
    await writeJsonFile(f.paths.review("critique").submission, { contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
      review: { mode: "independent", reason: "Independent conceptual reviewer" },
      result: { verdict: "needs_repair", issues: [{ id: "ISSUE-scope", description: "The changed interface remains unspecified",
        requirement_ids: ["REQ-greeting"], unit_ids: ["UNIT-greeting"], blocking: true }] },
    });
    const step = await buildNextContractPipelineStep(f.options);
    if (round === 8) {
      expect(step?.status).toBe("blocked");
      expect((await readPlanReviewHistory(f.artifactsDir)).repair_rounds).toBe(8);
      break;
    }
    expect(step?.status).toBe("ready");
    expect((await readPlanReviewHistory(f.artifactsDir)).repair_rounds).toBe(round + 1);
    await buildNextContractPipelineStep(f.options);
    expect((await readPlanReviewHistory(f.artifactsDir)).repair_rounds).toBe(round + 1);
    f.plan.objective = `Clarify the affected greeting interface, revision ${round + 1}`;
    expect((await submit(f)).issues).toEqual([]);
  }
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});
