import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBounded, spawnSyncHidden } from "../helpers/spawn.mjs";
import type { RemediationHostWorkload, RemediationHostWorkItem } from "../../src/remediate/steps/dispatch/hostContracts.js";
import { afterEach, expect, test } from "vitest";
import { StateStore, REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { hostDependencyLevels, permanentlyDeadPendingUnits, prepareRemediationHostHandoff, remediationSubmissionBinding } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_HOST_DECISION_CONTRACT_VERSION, REMEDIATION_HOST_RESULT_CONTRACT_VERSION, type RemediationStep } from "../../src/remediate/steps/types.js";
import { deriveResultId } from "../../src/shared/submission/hostHandoffCore.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "execution-unit-runtime-")); roots.push(value); return value; }
function state(): RemediationState {
  const units = [canonicalUnitFixture("UNIT-one"), canonicalUnitFixture("UNIT-two", { dependencies: ["UNIT-one"] })];
  return {
    run_start_dirty: [], run_start_dirty_encoding: "git-z/v1", contract_version: REMEDIATION_STATE_CONTRACT_VERSION, status: "implementing",
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

function withUnits(units: NonNullable<RemediationState["plan"]>["units"]): RemediationState {
  const value = state();
  value.plan!.units = units;
  value.plan!.requirements = units.map(unit => ({
    id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: [],
    change_kind: "structural", assertions: [], inapplicable_reason: "Only synthetic dispatch and result binding are exercised",
  }));
  value.items = Object.fromEntries(units.map(unit => [unit.id, { unit_id: unit.id, status: "pending" }]));
  return value;
}

test("write-disjoint waves use fixed ID order, actual directory boundaries, and no new dependencies", () => {
  const units = [
    canonicalUnitFixture("Z-file", { allowed_files: ["src/main.ts"] }),
    canonicalUnitFixture("Y-dir", { allowed_files: ["src/nested/"] }),
    canonicalUnitFixture("D-other", { allowed_files: ["src-backup/main.ts", "package.json.extra"] }),
    canonicalUnitFixture("C-package", { allowed_files: ["package.json"] }),
    canonicalUnitFixture("B-package", { allowed_files: ["package.json"] }),
    canonicalUnitFixture("A-dir", { allowed_files: ["src/"] }),
    canonicalUnitFixture("E-needs-A", { allowed_files: ["other.ts"], dependencies: ["A-dir"] }),
  ];
  const value = withUnits(units);
  const waves = (state: RemediationState) => hostDependencyLevels(state).map(level => level.map(unit => unit.id));
  expect(waves(value)).toEqual([["A-dir", "B-package", "D-other"], ["C-package", "E-needs-A", "Y-dir", "Z-file"]]);
  expect(waves(withUnits([...units].reverse()))).toEqual(waves(value));
  expect(permanentlyDeadPendingUnits(value)).toEqual([]);
  value.items!["A-dir"]!.status = "ignored";
  expect(waves(value)[0]).toEqual(["B-package", "D-other", "Y-dir", "Z-file"]);
  expect(permanentlyDeadPendingUnits(value).map(unit => unit.id)).toEqual(["E-needs-A"]);
  expect(value.plan!.units.find(unit => unit.id === "Z-file")!.dependencies).toEqual([]);
});

test("Windows case aliases are scheduled separately without changing exact grant spelling", () => {
  const original = canonicalUnitFixture("A", { allowed_files: ["source/Foo.ts"] });
  const alias = canonicalUnitFixture("B", { allowed_files: ["SOURCE/foo.ts"] });
  const waveIds = hostDependencyLevels(withUnits([alias, original])).map(level => level.map(unit => unit.id));
  expect(waveIds).toEqual(process.platform === "win32" ? [["A"], ["B"]] : [["A", "B"]]);
  expect(alias.allowed_files).toEqual(["SOURCE/foo.ts"]);
});

test("next-step binds one conflict-free wave and keeps already-issued work through partial ingestion", async () => {
  const dir = await root();
  const artifactsDir = join(dir, ".audit-tools", "remediation");
  const git = (...args: string[]): string => {
    const result = spawnSyncHidden("git", args, { cwd: dir, encoding: "utf8" });
    expect(result.status, String(result.stderr)).toBe(0);
    return String(result.stdout).trim();
  };
  const put = async (file: string, text: string) => {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await put(".gitignore", ".audit-tools/\n");
  await put("src/a.ts", "export const a = 1;\n");
  await put("src/shared.ts", "export const shared = 1;\n");
  git("init", "-q"); git("config", "user.name", "Dispatch Test"); git("config", "user.email", "dispatch@example.com");
  git("add", "."); git("commit", "--no-gpg-sign", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD");
  const value = withUnits([
    canonicalUnitFixture("A-foundation"),
    canonicalUnitFixture("B-newly-ready", { dependencies: ["A-foundation"], allowed_files: ["src/shared.ts"] }),
    canonicalUnitFixture("Z-issued", { allowed_files: ["src/shared.ts"] }),
    canonicalUnitFixture("ZZ-overlap", { allowed_files: ["src/"] }),
  ]);
  await put(".audit-tools/remediation/intent_checkpoint.json", JSON.stringify({
    schema_version: "intent-checkpoint/v1", confirmed_at: new Date().toISOString(),
    scope_summary: "Synthetic conflict-free dispatch", intent_summary: "Exercise the approved units", confirmed_by: "host",
  }));
  await writeApprovedPlanFixture(artifactsDir, value);
  const store = new StateStore(artifactsDir);
  await store.saveState(value);
  const cli = fileURLToPath(new URL("../../remediate-code.mjs", import.meta.url));
  const readNext = async (...flags: string[]) => {
    const output = await runBounded(process.execPath, [cli, "next-step", "--root", dir, "--artifacts-dir", artifactsDir, ...flags], { cwd: dir });
    return { output, step: JSON.parse(output.stdout) as RemediationStep };
  };
  const next = async (...flags: string[]) => {
    const { output, step } = await readNext(...flags);
    expect(step.step_kind, output.stderr + output.stdout).toBe("dispatch_implement");
    return JSON.parse(await readFile(step.artifact_paths.host_workload!, "utf8")) as RemediationHostWorkload;
  };
  const submitLanded = async (run: RemediationHostWorkload, item: RemediationHostWorkItem, path: string, text: string) => {
    await put(path, text);
    git("add", path); git("commit", "--no-gpg-sign", "-qm", item.id);
    const landed = git("rev-parse", "HEAD");
    await put(item.result_path, JSON.stringify({
      contract_version: REMEDIATION_HOST_RESULT_CONTRACT_VERSION,
      result_id: deriveResultId(item.id, item.prompt.sha256), run_id: run.run_id,
      work_item_id: item.id, prompt_sha256: item.prompt.sha256, landed_commit: landed,
      obligation_evidence: item.obligation_ids.map(obligation_id => ({ obligation_id, evidence: [path] })),
    }));
    return landed;
  };
  await put(".audit-tools/remediation/confirm_resume_ack.json", JSON.stringify({ choice: "resume" }));
  const first = await next();
  expect(first.work_items.map(item => item.id)).toEqual(["A-foundation", "Z-issued"]);
  expect(first.work_items.every(item => item.baseline_commit === baseline)).toBe(true);
  await submitLanded(first, first.work_items[0]!, "src/a.ts", "export const a = 2;\n");
  const resumed = await next();
  expect(resumed).toEqual(first);
  expect((await store.loadState())?.items?.["A-foundation"]?.status).toBe("resolved");
  const landed = await submitLanded(first, first.work_items[1]!, "src/shared.ts", "export const shared = 2;\n");
  const review = (await readNext()).step;
  expect(review.step_kind).toBe("review_wave_simplification");
  const prompt = await readFile(review.prompt_path, "utf8");
  expect(prompt).toContain("git diff --no-ext-diff --no-textconv " + baseline + " " + landed);
  expect(prompt).toMatch(/reuse or duplication.*quality and simplicity.*inefficiency.*unnecessary abstraction/);
  const before = await store.loadState();
  expect(before?.items?.["Z-issued"]?.status).toBe("resolved");
  expect(before?.wave_simplifications?.[0]).toMatchObject({ baseline, integrated: landed, unit_ids: ["A-foundation", "Z-issued"] });
  expect(before?.host_handoff).toBeUndefined();
  const binding = before!.wave_simplifications![0]!;
  expect((await readNext("--force-replan")).step.step_kind).toBe("review_wave_simplification");
  expect((await store.loadState())?.wave_simplifications?.[0]?.receipt).toBe(binding.receipt);
  const response = review.artifact_paths.wave_simplification_response!;
  await writeFile(response, JSON.stringify({ receipt: binding.receipt, disposition: "no_changes", note: "No avoidable duplication in combined changes" }));
  const revisionBoundary = (await readNext("--force-replan")).step;
  expect(revisionBoundary.step_kind).toBe("contract_pipeline");
  expect(revisionBoundary.allowed_commands).toEqual(["remediate-code next-step --force-replan"]);
  expect((await store.loadState())?.host_handoff).toBeUndefined();
  expect((await store.loadState())?.wave_simplifications?.[0]?.response?.disposition).toBe("no_changes");
  const second = await next("--force-replan");
  expect(second.work_items.map(item => [item.id, item.baseline_commit])).toEqual([["B-newly-ready", landed]]);
  expect((await store.loadState())?.wave_simplifications?.[0]?.response?.disposition).toBe("no_changes");
  // Replay after acknowledgement: ignored by the active next wave, which
  // remains byte-equivalent. A no-op must not invent a new commit.
  await writeFile(response, JSON.stringify({ receipt: binding.receipt, disposition: "unavailable", note: "Stale replay" }));
  await put(".audit-tools/remediation/confirm_resume_ack.json", JSON.stringify({ choice: "resume" }));
  expect(await next()).toEqual(second);
  expect(git("rev-parse", "HEAD")).toBe(landed);
  expect((await store.loadState())?.wave_simplifications?.[0]?.response?.disposition).toBe("no_changes");
  const solo = await submitLanded(second, second.work_items[0]!, "src/shared.ts", "export const shared = 3;\n");
  const third = await next();
  expect(third.work_items.map(item => [item.id, item.baseline_commit])).toEqual([["ZZ-overlap", solo]]);
  expect((await store.loadState())?.wave_simplifications).toHaveLength(1);
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
