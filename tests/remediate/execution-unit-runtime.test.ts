import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StateStore, REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { hostDependencyLevels, permanentlyDeadPendingUnits, prepareRemediationHostHandoff, remediationSubmissionBinding } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_HOST_DECISION_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import { deriveResultId } from "../../src/shared/submission/hostHandoffCore.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "execution-unit-runtime-")); roots.push(value); return value; }
function state(): RemediationState {
  const units = [canonicalUnitFixture("UNIT-one"), canonicalUnitFixture("UNIT-two", { dependencies: ["UNIT-one"] })];
  return { contract_version: REMEDIATION_STATE_CONTRACT_VERSION, status: "implementing",
    plan: canonicalPlanFixture({ units, requirements: units.map(unit => ({
      id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: [], change_kind: "structural", assertions: [],
    })), request: { id: "REQUEST-user", text: "Improve the API", source_paths: ["src/a.ts"] } }),
    items: Object.fromEntries(units.map(unit => [unit.id, { unit_id: unit.id, status: "pending" }])),
  };
}

test("request-only execution units are the dispatch authority without fake findings", async () => {
  const value = state();
  const dir = await root();
  await writeApprovedPlanFixture(join(dir, ".audit-tools/remediation"), value);
  const prepared = await prepareRemediationHostHandoff({ root: dir, artifactsDir: join(dir, ".audit-tools/remediation"), runId: value.plan!.plan_id, baselineCommit: "1".repeat(40), state: value });
  expect(prepared).not.toBe("unsupported_retired_state");
  if (prepared === "unsupported_retired_state") throw new Error(prepared);
  expect(prepared.workload.work_items.map(item => item.id)).toEqual(["UNIT-one"]);
  expect(prepared.workload.work_items[0]!.source_finding_ids).toEqual([]);
  expect(prepared.workload.work_items[0]!.obligation_ids).toEqual(["REQ-UNIT-one"]);
  expect(prepared.workload.work_items[0]!.prompt.text).toContain('"requirements"');
  expect(value.plan!.findings).toEqual([]);
});

test("pending and question-held dependencies stay live; skipped dependencies never satisfy a unit", () => {
  const value = state();
  expect(hostDependencyLevels(value).map(level => level.map(unit => unit.id))).toEqual([["UNIT-one"], ["UNIT-two"]]);
  value.items!["UNIT-one"].status = "needs_clarification";
  expect(hostDependencyLevels(value)).toEqual([]);
  expect(permanentlyDeadPendingUnits(value)).toEqual([]);
  value.items!["UNIT-one"].status = "ignored";
  expect(permanentlyDeadPendingUnits(value).map(unit => unit.id)).toEqual(["UNIT-two"]);
  value.items!["UNIT-one"].status = "resolved";
  expect(hostDependencyLevels(value)[0]!.map(unit => unit.id)).toEqual(["UNIT-two"]);
});

test("the store refuses old runtime authority without altering retained evidence", async () => {
  const dir = await root();
  const path = join(dir, "state.json");
  const bytes = JSON.stringify({ contract_version: "remediate-code-state/v1alpha1", status: "implementing", plan: { blocks: [] }, items: {}, evidence: "keep me" });
  await writeFile(path, bytes);
  await expect(new StateStore(dir).loadState()).rejects.toThrow(/version|contract|schema/i);
  expect(await readFile(path, "utf8")).toBe(bytes);
});

test("an integration phase waits for the preceding phase to verify", () => {
  const value = state();
  value.plan!.units[1]!.phase_ordinal = 1;
  expect(hostDependencyLevels(value).map(level => level.map(unit => unit.id))).toEqual([["UNIT-one"]]);
  expect(permanentlyDeadPendingUnits(value)).toEqual([]);
  value.items!["UNIT-one"].status = "resolved";
  expect(hostDependencyLevels(value)[0]!.map(unit => unit.id)).toEqual(["UNIT-two"]);
});

test("the store enforces unit-key identity and exact unit coverage", async () => {
  const dir = await root();
  const value = state();
  value.items!["UNIT-one"].unit_id = "UNIT-two";
  await expect(new StateStore(dir).saveState(value)).rejects.toThrow(/unit_id/);
  delete value.items!["UNIT-one"];
  await expect(new StateStore(dir).saveState(value)).rejects.toThrow(/no runtime item/);
});


test("a changed execution contract or immutable source cannot use an old approval", async () => {
  const value = state();
  const dir = await root();
  const artifactsDir = join(dir, ".audit-tools/remediation");
  await writeApprovedPlanFixture(artifactsDir, value);
  const args = { root: dir, artifactsDir, runId: value.plan!.plan_id, baselineCommit: "1".repeat(40), state: value };
  value.plan!.units[0]!.description = "Perform unrelated work";
  await expect(prepareRemediationHostHandoff(args)).rejects.toThrow(/approved revision/);
  await writeApprovedPlanFixture(artifactsDir, value);
  await expect(prepareRemediationHostHandoff(args)).resolves.not.toBe("unsupported_retired_state");
  value.plan!.requirements[0]!.description = "Change the approved obligation";
  await expect(prepareRemediationHostHandoff(args)).rejects.toThrow(/approved revision/);
});

test("implementation workers cannot manufacture owner ignore or rejection decisions", async () => {
  const value = state(), dir = await root(), artifactsDir = join(dir, ".audit-tools/remediation");
  await writeApprovedPlanFixture(artifactsDir, value);
  const prepared = await prepareRemediationHostHandoff({ root: dir, artifactsDir, runId: value.plan!.plan_id, baselineCommit: "1".repeat(40), state: value });
  if (prepared === "unsupported_retired_state") throw new Error(prepared);
  const item = prepared.workload.work_items[0]!;
  const binding = await remediationSubmissionBinding({ root: dir, artifactsDir, runId: value.plan!.plan_id, workItemId: item.id });
  const result = { contract_version: REMEDIATION_HOST_DECISION_CONTRACT_VERSION, result_id: deriveResultId(item.id, item.prompt.sha256), run_id: value.plan!.plan_id, work_item_id: item.id, prompt_sha256: item.prompt.sha256, outcome: { status: "blocked", failure_reason: "A required user decision is missing" } };
  expect(binding).not.toBeNull();
  expect(binding!.validate(result)).toBeNull();
  for (const status of ["ignored", "deemed_inappropriate"]) {
    expect(binding!.validate({ ...result, outcome: { ...result.outcome, status } })?.code).toBe("submission_contract_invalid");
  }
});


test("in-memory current boundary uses the active state contract rather than a retired literal", async () => {
  const { currentHostBoundaryState } = await import("../../src/remediate/state/runIdentity.js");
  const { REMEDIATION_STATE_CONTRACT_VERSION } = await import("../../src/remediate/state/store.js");
  expect(currentHostBoundaryState({ status: "pending" }).contract_version).toBe(REMEDIATION_STATE_CONTRACT_VERSION);
});
