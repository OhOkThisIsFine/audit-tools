import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as shared from "audit-tools/shared";
import { changeOperatorLifecycle, decideNextStep } from "../../src/remediate/steps/nextStep.js";
import * as pipeline from "../../src/remediate/steps/contractPipeline.js";
import * as stepWriter from "../../src/remediate/steps/stepWriter.js";
import { executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readApprovedExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { StateStore, OPERATOR_LIFECYCLE_FILENAME, type RemediationState } from "../../src/remediate/state/store.js";
import { RemediationDirtyBaselineError } from "../../src/remediate/state/dirtyBaseline.js";
import { decisionContextDigest, readDecisionSnapshot } from "../../src/remediate/state/decisionConsumption.js";
import { buildDocumentSourceManifest, intakePaths } from "../../src/remediate/intake.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

// Discovery is controlled at its public seam. All admission, no-state routing,
// activation, state persistence, replanning and cleanup entry points stay real.
vi.mock("audit-tools/shared", async original => {
  const actual = await original<typeof import("audit-tools/shared")>();
  return {
    ...actual,
    stagedAndUntracked: vi.fn(actual.stagedAndUntracked),
    applyGuidanceFile: vi.fn(actual.applyGuidanceFile),
    applyGuidanceText: vi.fn(actual.applyGuidanceText),
    writeJsonFile: vi.fn(actual.writeJsonFile),
  };
});

const h = createNextStepHarness(".test-dirty-baseline-capture");
const { REPO_DIR: root, ARTIFACTS_DIR: artifactsDir } = h;
const options = { root, artifactsDir, finalGateRunner: h.finalGateRunner };
const statePath = join(artifactsDir, "state.json");
const planPath = join(artifactsDir, "remediation_plan.json");
const rawPaths = ["z-last.ts", " leading and trailing ", "line\nbreak", "quote\"name", "back\\slash", "é-first.ts"];
const joins = ["already approved", "existing source awaiting approval publication", "ready intake approval arrival"] as const;
type Join = typeof joins[number];

beforeEach(async () => {
  await h.resetTestRepo();
  const actual = await vi.importActual<typeof import("audit-tools/shared")>("audit-tools/shared");
  vi.mocked(shared.stagedAndUntracked).mockReset().mockImplementation(actual.stagedAndUntracked);
  vi.mocked(shared.applyGuidanceFile).mockReset().mockImplementation(actual.applyGuidanceFile);
  vi.mocked(shared.applyGuidanceText).mockReset().mockImplementation(actual.applyGuidanceText);
  vi.mocked(shared.writeJsonFile).mockReset().mockImplementation(actual.writeJsonFile);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanupTestRepo();
});

async function prepareJoin(route: Join): Promise<void> {
  await h.writeIntentCheckpoint();
  if (route !== "ready intake approval arrival") {
    await h.writeApprovedExecutionPlan();
    if (route === "existing source awaiting approval publication") {
      // Real accepted reviews remain; the real pipeline recreates its missing
      // approval receipt, making the second join reachable without a stub plan.
      await rm(executionPlanPaths(artifactsDir).approval);
      expect(await readApprovedExecutionPlan(artifactsDir)).toBeUndefined();
    }
    return;
  }

  const intake = intakePaths(artifactsDir);
  await mkdir(intake.dir, { recursive: true });
  const request = join(intake.dir, "original-request.md");
  await writeFile(request, "Clean up the auth flow while retaining its behavior.\n");
  await writeFile(intake.sourceManifest, JSON.stringify(buildDocumentSourceManifest([request], "input")));
  await writeFile(intake.summary, JSON.stringify(intakeSummaryFixture({ affected_files: [{ path: "src/auth.ts" }] })));
  const realBuild = pipeline.buildNextContractPipelineStep;
  // Controlled artifact-arrival seam: ordinarily author/review submissions
  // arrive across several host pauses. Publish genuinely reviewed fixtures at
  // first pipeline entry to reach the third physical no-state activation join.
  // The production pipeline, approved-plan read and activation still execute.
  vi.spyOn(pipeline, "buildNextContractPipelineStep").mockImplementationOnce(async args => {
    expect(args.sourcePaths).toContain(intake.brief);
    expect(existsSync(executionPlanPaths(artifactsDir).source)).toBe(false);
    await h.writeApprovedExecutionPlan();
    return realBuild(args);
  });
}

describe("no-state dirty baseline activation", () => {
  for (const route of joins) {
    it.each([{ paths: [] as string[] }, { paths: rawPaths }])(`captures once and atomically saves both fields through ${route}: $paths`, async ({ paths }) => {
      await prepareJoin(route);
      expect(existsSync(statePath)).toBe(false);
      const discovered = [...paths];
      vi.mocked(shared.stagedAndUntracked).mockResolvedValue(discovered);
      const saves: RemediationState[] = [];
      const originalSave = StateStore.prototype.saveState;
      vi.spyOn(StateStore.prototype, "saveState").mockImplementation(async function (this: StateStore, state) {
        expect(state.run_start_dirty).not.toBe(discovered);
        expect(state.run_start_dirty).toEqual(paths);
        expect(state.run_start_dirty_encoding).toBe("git-z/v1");
        saves.push(structuredClone(state));
        await originalSave.call(this, state);
      });
      const actual = await vi.importActual<typeof import("audit-tools/shared")>("audit-tools/shared");
      let planPublished = false;
      vi.mocked(shared.writeJsonFile).mockImplementation(async (path, value) => {
        if (path === planPath) {
          const persisted = JSON.parse(await readFile(statePath, "utf8"));
          expect(persisted.run_start_dirty).toEqual(paths);
          expect(persisted.run_start_dirty_encoding).toBe("git-z/v1");
          expect(saves).toHaveLength(1);
          planPublished = true;
        }
        return actual.writeJsonFile(path, value);
      });

      await decideNextStep({ ...options, planOnly: true });
      expect(planPublished).toBe(true);
      expect(saves[0]?.status).toBe("planning");
      expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledWith(root);
      const persisted = await new StateStore(artifactsDir).loadState();
      expect(persisted?.run_start_dirty).toEqual(paths);
      expect(persisted?.run_start_dirty_encoding).toBe("git-z/v1");

      // A second real invocation sees the paused existing run, never a new
      // capture opportunity, including when the captured array was empty.
      await decideNextStep(options);
      expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledTimes(1);
    });

    it(`publishes no plan-state or implementation after discovery failure through ${route}`, async () => {
      await prepareJoin(route);
      const refusal = new shared.DirtyPathDiscoveryError("status", "fixture timeout with partial output");
      vi.mocked(shared.stagedAndUntracked).mockRejectedValue(refusal);
      const save = vi.spyOn(StateStore.prototype, "saveState");
      const publish = vi.spyOn(stepWriter, "writeCurrentStep");
      await expect(decideNextStep({ ...options, planOnly: true })).rejects.toBe(refusal);
      expect(save).not.toHaveBeenCalled();
      expect(existsSync(statePath)).toBe(false);
      expect(existsSync(planPath)).toBe(false);
      expect(publish.mock.calls.some(([args]) => args.stepKind === "dispatch_implement")).toBe(false);
      expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledWith(root);
    });
  }

  it("durably saves the baseline before actual implementation dispatch is exposed", async () => {
    await prepareJoin("already approved");
    vi.mocked(shared.stagedAndUntracked).mockResolvedValue([...rawPaths]);
    const realWrite = stepWriter.writeCurrentStep;
    let checkedDispatch = false;
    vi.spyOn(stepWriter, "writeCurrentStep").mockImplementation(async args => {
      if (args.stepKind === "dispatch_implement") {
        const persisted = await new StateStore(artifactsDir).loadState();
        expect(persisted?.run_start_dirty).toEqual(rawPaths);
        expect(persisted?.run_start_dirty_encoding).toBe("git-z/v1");
        expect(existsSync(planPath)).toBe(true);
        checkedDispatch = true;
      }
      return realWrite(args);
    });
    const step = await decideNextStep(options);
    expect(step.step_kind).toBe("dispatch_implement");
    expect(checkedDispatch).toBe(true);
    expect(vi.mocked(shared.stagedAndUntracked)).toHaveBeenCalledTimes(1);
  });
});

async function approveRevisedObjective(): Promise<string> {
  const prior = (await readCanonicalPlan(artifactsDir))!;
  const paths = executionPlanPaths(artifactsDir);
  const plan = { ...prior.plan, objective: "Preserve the auth behavior with a newly reviewed objective" };
  await writeFile(paths.submission, JSON.stringify({ base_revision_sha256: prior.revision_sha256, plan, retired_requirements: [] }));
  expect((await ingestExecutionPlan(options)).issues).toEqual([]);
  const revision = (await readCanonicalPlan(artifactsDir))!.revision_sha256;
  await writeFile(join(paths.directory, "owner-decision.json"), JSON.stringify({
    revision_sha256: revision, confirmed_by: "host", approved_unit_ids: plan.units.map(unit => unit.id), declined_units: [],
  }));
  const reviewOptions = { ...options, runId: plan.plan_id };
  for (const role of ["critique", "critic", "judge"] as const) {
    await pipeline.buildNextContractPipelineStep(reviewOptions);
    const request = JSON.parse(await readFile(paths.review(role).request, "utf8")) as { prompt_sha256: string };
    const result = role === "critique" ? { verdict: "approved", issues: [] } : role === "critic" ? { counterexamples: [] } : {
      verdict: "approved", classifications: [], disposition_assessments: [],
      requirement_assessments: plan.requirements.map(requirement => ({ requirement_id: requirement.id, verdict: "satisfied", evidence: ["Independent fixture review of the revised objective"] })),
    };
    await writeFile(paths.review(role).submission, JSON.stringify({
      contract_version: "review-submission/v1", prompt_sha256: request.prompt_sha256,
      review: { mode: "independent", reason: "Separate review context for the revised plan" }, result,
    }));
  }
  expect(await pipeline.buildNextContractPipelineStep(reviewOptions)).toBeNull();
  expect(await readApprovedExecutionPlan(artifactsDir)).toBeDefined();
  return revision;
}

describe("actual existing-run replanning", () => {
  it.each([{ paths: [] as string[] }, { paths: rawPaths }])("preserves the original pair after live dirt changes without recapture: $paths", async ({ paths }) => {
    await prepareJoin("already approved");
    vi.mocked(shared.stagedAndUntracked).mockResolvedValue([...paths]);
    await decideNextStep({ ...options, planOnly: true });
    const before = (await new StateStore(artifactsDir).loadState())!;
    await changeOperatorLifecycle({ ...options, action: "resume" });
    await h.acknowledgeResume();
    await writeFile(join(root, "new-live-user-work.txt"), "Work created after the original baseline\n");
    const actual = await vi.importActual<typeof import("audit-tools/shared")>("audit-tools/shared");
    expect(await actual.stagedAndUntracked(root)).toContain("new-live-user-work.txt");
    const revision = await approveRevisedObjective();
    expect(revision).not.toBe(before.plan!.review_revision_sha256);
    vi.mocked(shared.stagedAndUntracked).mockClear().mockRejectedValue(new Error("Existing runs must not recapture"));

    await decideNextStep({ ...options, forceReplan: true, planOnly: true });
    const after = (await new StateStore(artifactsDir).loadState())!;
    expect(after.plan!.review_revision_sha256).toBe(revision);
    expect(after.run_start_dirty).toEqual(before.run_start_dirty);
    expect(after.run_start_dirty_encoding).toBe(before.run_start_dirty_encoding);
    expect(vi.mocked(shared.stagedAndUntracked)).not.toHaveBeenCalled();
  });

  it.each([
    { baseline: {}, validation: false },
    { baseline: { run_start_dirty: [] }, validation: false },
    { baseline: { run_start_dirty_encoding: "git-z/v1" }, validation: true },
    { baseline: { run_start_dirty: [1], run_start_dirty_encoding: "git-z/v1" }, validation: true },
    { baseline: { run_start_dirty: [], run_start_dirty_encoding: "unknown" }, validation: true },
  ])("refuses an unavailable replan baseline without capturing or repairing it: $baseline", async ({ baseline, validation }) => {
    const bytes = JSON.stringify({ ...legacyState("planning"), ...baseline });
    await writeFile(statePath, bytes);
    const spies = observeAuthority();
    const result = expect(decideNextStep({ ...options, forceReplan: true })).rejects;
    if (validation) await result.toThrow(/schema validation/);
    else await result.toThrow(RemediationDirtyBaselineError);
    await assertNoAuthorityWrites(spies, bytes);
  });
});

async function withPendingCleanup(state: RemediationState): Promise<RemediationState> {
  await writeFile(join(artifactsDir, "triage_resolution.json"), '{"items":[]}\n');
  await writeFile(join(artifactsDir, "retry-result.json"), "preserve retry evidence\n");
  const answer = (await readDecisionSnapshot(join(artifactsDir, "triage_resolution.json")))!;
  const result = (await readDecisionSnapshot(join(artifactsDir, "retry-result.json")))!;
  return { ...state, decision_applications: [{
    input: "triage_resolution.json", input_sha256: answer.sha256, input_identity_sha256: answer.identity_sha256,
    context_sha256: decisionContextDigest(state), run_id: state.plan!.plan_id,
    revision_sha256: state.plan!.review_revision_sha256, applied_at: "2026-10-14T00:00:00.000Z",
    retry_results: [{ path: "retry-result.json", sha256: result.sha256, identity_sha256: result.identity_sha256 }],
    outcome: { resolved_at: "2026-10-14T00:00:00.000Z", items: [] },
  }] };
}

function legacyState(status: RemediationState["status"] = "pending"): RemediationState {
  const state = makePlanningState({ status, step_count: 7 });
  delete state.run_start_dirty;
  delete state.run_start_dirty_encoding;
  state.plan!.test_command = "original verification";
  return state;
}

function observeAuthority() {
  return {
    save: vi.spyOn(StateStore.prototype, "saveState"),
    reconcile: vi.spyOn(StateStore.prototype, "reconcileDecisionApplications"),
    lifecycle: vi.spyOn(StateStore.prototype, "setOperatorLifecycleUnderPhaseLock"),
    pipeline: vi.spyOn(pipeline, "buildNextContractPipelineStep"),
  };
}

async function assertNoAuthorityWrites(spies: ReturnType<typeof observeAuthority>, bytes: string) {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  expect(shared.stagedAndUntracked).not.toHaveBeenCalled();
  expect(shared.applyGuidanceFile).not.toHaveBeenCalled();
  expect(shared.applyGuidanceText).not.toHaveBeenCalled();
  expect(await readFile(statePath, "utf8")).toBe(bytes);
  expect(existsSync(planPath)).toBe(false);
  expect(existsSync(join(artifactsDir, OPERATOR_LIFECYCLE_FILENAME))).toBe(false);
  expect(existsSync(join(artifactsDir, "triage-outcome.json"))).toBe(false);
  expect((await readdir(artifactsDir)).some(name => name.includes(".consumed-") || name.includes(".stale-") || name.includes(".pending-cleanup"))).toBe(false);
}

describe("locked entry refuses before pending authority work", () => {
  it.each([
    { label: "verification override", supplied: { verificationCommand: "node -e 0" } },
    { label: "pending text guidance", supplied: { guidanceText: "Apply this new guidance" } },
    { label: "pending file guidance", supplied: { guidanceFile: join(artifactsDir, "new-guidance.md") } },
    { label: "plan-only lifecycle", supplied: { planOnly: true } },
    { label: "decision cleanup only", supplied: {} },
  ])("preserves cleanup and state before $label", async ({ supplied }) => {
    const state = await withPendingCleanup(legacyState());
    const bytes = JSON.stringify(state);
    await writeFile(statePath, bytes);
    await writeFile(join(artifactsDir, "new-guidance.md"), "New guidance that must remain unapplied\n");
    const spies = observeAuthority();
    await expect(decideNextStep({ ...options, ...supplied })).rejects.toThrow(RemediationDirtyBaselineError);
    await assertNoAuthorityWrites(spies, bytes);
    expect(await readFile(join(artifactsDir, "triage_resolution.json"), "utf8")).toBe('{"items":[]}\n');
    expect(await readFile(join(artifactsDir, "retry-result.json"), "utf8")).toBe("preserve retry evidence\n");
    expect(existsSync(intakePaths(artifactsDir).conversationStart)).toBe(false);
  });

  it("admits the actual locked fresh load after a peer replaces a marked diagnostic state", async () => {
    await writeFile(statePath, JSON.stringify(makePlanningState({ status: "pending" })));
    const legacyBytes = JSON.stringify(await withPendingCleanup(legacyState()));
    const realLoad = StateStore.prototype.loadState;
    let reads = 0;
    vi.spyOn(StateStore.prototype, "loadState").mockImplementation(async function (this: StateStore) {
      const state = await realLoad.call(this);
      if (++reads === 1) {
        expect(state?.run_start_dirty_encoding).toBe("git-z/v1");
        // A controlled peer replacement between the unlocked diagnostic read
        // and mutex acquisition. The second read uses the real disk parser.
        await writeFile(statePath, legacyBytes);
      } else if (reads === 2) {
        expect(existsSync(join(artifactsDir, "phase.lock"))).toBe(true);
        expect(state?.run_start_dirty_encoding).toBeUndefined();
      }
      return state;
    });
    const spies = observeAuthority();
    await expect(decideNextStep({ ...options, verificationCommand: "node -e 0", planOnly: true })).rejects.toThrow(RemediationDirtyBaselineError);
    expect(reads).toBe(2);
    await assertNoAuthorityWrites(spies, legacyBytes);
  });

  it.each(["pending", "planning", "implementing", "closing", "triage", "waiting_for_triage", "waiting_for_clarification"] as const)("never treats an existing unmarked %s state as a new run", async status => {
    const state = { ...legacyState(status), run_start_dirty: [" old filename "] };
    const bytes = JSON.stringify(state);
    await writeFile(statePath, bytes);
    const spies = observeAuthority();
    await expect(decideNextStep({ ...options, forceReplan: true })).rejects.toThrow(RemediationDirtyBaselineError);
    await assertNoAuthorityWrites(spies, bytes);
  });
});

describe("narrow legacy complete report-only exception", () => {
  it("presents the report while leaving a real pending cleanup receipt and its inputs byte-for-byte intact", async () => {
    const state = await withPendingCleanup(legacyState("complete"));
    const bytes = JSON.stringify(state);
    await writeFile(statePath, bytes);
    const spies = observeAuthority();
    expect((await decideNextStep(options)).step_kind).toBe("present_report");
    await assertNoAuthorityWrites(spies, bytes);
    expect(await readFile(join(artifactsDir, "triage_resolution.json"), "utf8")).toBe('{"items":[]}\n');
    expect(await readFile(join(artifactsDir, "retry-result.json"), "utf8")).toBe("preserve retry evidence\n");
    expect(existsSync(join(artifactsDir, "steps", "current-step.json"))).toBe(true);
  });

  it.each(["pending submission", "canonical revision mismatch"] as const)("refuses complete with %s before cleanup, replan or state writes", async condition => {
    await prepareJoin("already approved");
    const canonical = (await readCanonicalPlan(artifactsDir))!;
    const state = await withPendingCleanup(legacyState("complete"));
    // A valid canonical file, with a deliberately different runtime revision,
    // exercises the production read/mismatch predicate rather than parse failure.
    if (condition === "pending submission") {
      state.plan!.review_revision_sha256 = canonical.revision_sha256;
      await writeFile(executionPlanPaths(artifactsDir).submission, "{}\n");
    } else {
      expect(state.plan!.review_revision_sha256).not.toBe(canonical.revision_sha256);
    }
    const bytes = JSON.stringify(state);
    await writeFile(statePath, bytes);
    const spies = observeAuthority();
    await expect(decideNextStep(options)).rejects.toThrow(RemediationDirtyBaselineError);
    await assertNoAuthorityWrites(spies, bytes);
    expect(await readFile(join(artifactsDir, "triage_resolution.json"), "utf8")).toBe('{"items":[]}\n');
    if (condition === "pending submission") expect(await readFile(executionPlanPaths(artifactsDir).submission, "utf8")).toBe("{}\n");
  });
});
