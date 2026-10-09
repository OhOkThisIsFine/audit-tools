import { systemicPremiseToken } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";
import { writeBoundReviewFixture } from "./helpers/reviewSubmissionFixture.js";
import { satisfyFunctionalPreflight } from "../helpers/functionalPreflightFixture.js";
/**
 * Systemic challenge rounds need two identities at once:
 *
 * - re-emitting the same pending round must keep its bound result path, while
 * - an accepted non-empty round must mint a new path before the next round.
 *
 * The tests deliberately obtain every submission path from the real emitted
 * step contract. They therefore exercise the emitter's renderer and the
 * handler's independent derivation without spelling a proposed lane helper.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { bindCandidateTerminalStep, driveCandidateLoop } from "../helpers/candidateDriver.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import type { SystemicChallengeRegister } from "../../src/audit/types/systemicChallenge.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import { systemicChallengeLane } from "../../src/audit/cli/laneSubmissions.js";
import { laneSubmissionValidator } from "../../src/audit/cli/laneValidators.js";
import { classifyObligationBranch } from "../../src/audit/orchestrator/obligationPolicy.js";

const harness = vi.hoisted(() => ({ plannerResults: [] as unknown[] }));

// Keep the planner at the host boundary minimal so the test can reach the real
// emission scaffold and renderer without constructing the entire audit fixture.
// The handler test below imports and executes the real handler and executor.
vi.mock("../../src/audit/cli/nextStepHelpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/audit/cli/nextStepHelpers.js")>();
  return {
    ...actual,
    runDeterministicForNextStep: vi.fn(async () => {
      const result = harness.plannerResults.shift();
      if (result === undefined) throw new Error("systemic-round test planner queue is empty");
      return result;
    }),
  };
});

const { cmdNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { createFoldTransaction, commitFold } = await import(
  "../../src/audit/cli/foldTransaction.js",
);
const { handleSystemicChallengeBranch } = await import(
  "../../src/audit/cli/nextStepHelpers.js",
);

const cleanupRoots: string[] = [];

afterEach(async () => {
  harness.plannerResults.length = 0;
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function deepCheckpoint(): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "test scope",
    intent_summary: "test intent",
    design_review: { ceiling: { rung: "deep" } },
  };
}

function systemicBundle(register: SystemicChallengeRegister): ArtifactBundle {
  return {
    intent_checkpoint: deepCheckpoint(),
    repo_manifest: {
      repository: { name: "systemic-round-test", root: "/repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [],
    },
    systemic_challenge: register,
  };
}

function openRegister(
  rounds: SystemicChallengeRegister["rounds"] = [],
): SystemicChallengeRegister {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "systemic_challenge" as const,
    ceiling: { rung: "deep" },
    rounds,
    converged: false,
    findings: [],
    validation_issues: [],
  };
}

async function makeRoot(): Promise<{ root: string; sourceRoot: string; artifactsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "systemic-round-identity-"));
  cleanupRoots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await satisfyFunctionalPreflight(root, artifactsDir);
  return { root, sourceRoot: root, artifactsDir };
}

async function emitSystemicStep(
  root: string,
  artifactsDir: string,
  bundle: ArtifactBundle,
): Promise<Record<string, any>> {
  harness.plannerResults.push({
    kind: "systemic_challenge",
    state: { status: "active", obligations: [] } satisfies AuditState,
    bundle,
    // The real fold resolves the run's snapshot; this planner stub reads in place.
    sourceRoot: root,
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await cmdNextStep(["--root", root, "--artifacts-dir", artifactsDir]);
  } finally {
    log.mockRestore();
  }
  return JSON.parse(await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"));
}

function resultPath(step: Record<string, any>): string {
  const path = step.artifact_paths?.systemic_challenge_results;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("emitted systemic challenge step did not expose its result path");
  }
  return path;
}


const emptyState: AuditState = { status: "active", obligations: [] };

describe("systemic challenge round identity", () => {
  test.each([false, true])("an emitted response is checked against the live premise before folding without re-emission (changed: %s)", async (changed) => {
    const { root, artifactsDir } = await makeRoot();
    const emittedBundle = systemicBundle(openRegister([
      { round: 1, new_finding_ids: ["SYS-1"], dry: false },
    ]));
    const premiseA = systemicPremiseToken(emittedBundle);
    emittedBundle.systemic_challenge!.round_token = premiseA;
    const step = await emitSystemicStep(root, artifactsDir, emittedBundle);
    const lane = systemicChallengeLane(emittedBundle.systemic_challenge!.rounds);
    await writeBoundReviewFixture(artifactsDir, lane, { findings: [] });
    expect(JSON.parse(await readFile(resultPath(step), "utf8")).contract_version)
      .toBe("review-submission/v1");

    // No new emission occurs. The same pending lane still carries the answer
    // to A, while the fold may now carry a different upstream intent B.
    const current = structuredClone(emittedBundle);
    if (changed) current.intent_checkpoint!.intent_summary = "changed systemic premise B";
    expect(systemicPremiseToken(current) === premiseA).toBe(!changed);
    const before = structuredClone(current.systemic_challenge);
    const tx = createFoldTransaction();
    const outcome = await handleSystemicChallengeBranch({ root, sourceRoot: root, artifactsDir }, current, emptyState, tx);
    expect(outcome.action).toBe(changed ? "return" : "continue");
    if (changed) {
      if (outcome.action !== "return") throw new Error("stale premise was consumed");
      expect(outcome.result.kind).toBe("systemic_challenge");
      expect(outcome.result.bundle.systemic_challenge).toEqual(before);
      expect(tx.staged.some(submission => submission.applied)).toBe(false);
    } else {
      if (outcome.action !== "continue") throw new Error("current premise was refused");
      expect(outcome.bundle.systemic_challenge?.rounds).toHaveLength(2);
      expect(outcome.bundle.systemic_challenge?.rounds[1]?.dry).toBe(true);
      expect(outcome.bundle.systemic_challenge?.round_token).toBe(premiseA);
      expect(tx.staged.some(submission => submission.applied)).toBe(true);
    }
    expect(current.systemic_challenge).toEqual(before);
  });

  test.each(["contract_findings", "conceptual_findings", "timestamp"] as const)("systemic acceptance binds the carried prior findings without re-emission (%s)", async (change) => {
    const { root, artifactsDir } = await makeRoot();
    const issued = systemicBundle(openRegister([{ round: 1, new_finding_ids: ["SYS-1"], dry: false }]));
    const finding = {
      id: "DESIGN-A", title: "Original reviewed assessment A", category: "design",
      severity: "medium" as const, confidence: "high" as const, lens: "design",
      summary: "Previously banked assessment A", affected_files: [],
    };
    issued.design_assessment = {
      generated_at: "2026-01-01T00:00:00Z", findings: [],
      contract_findings: [finding], conceptual_findings: [],
    };
    const premise = systemicPremiseToken(issued);
    issued.systemic_challenge!.round_token = premise;
    const assessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(assessmentPath, JSON.stringify(issued.design_assessment), "utf8");
    const step = await emitSystemicStep(root, artifactsDir, issued);
    const prompt = await readFile(step.artifact_paths.systemic_challenge_prompt, "utf8");
    expect(prompt).toContain(finding.title);
    await writeBoundReviewFixture(artifactsDir, systemicChallengeLane(issued.systemic_challenge!.rounds), { findings: [] });

    const current = structuredClone(issued);
    if (change === "timestamp") current.design_assessment!.generated_at = "2026-02-01T00:00:00Z";
    else current.design_assessment![change] = [{ ...finding, id: "DESIGN-B", title: "New carried assessment B" }];
    // Premise/round identity and the on-disk evidence stay A. Only the live
    // assessment consumed by the prompt changes; no emitter refresh can save us.
    expect(systemicPremiseToken(current)).toBe(premise);
    expect(current.systemic_challenge).toEqual(issued.systemic_challenge);
    expect(JSON.parse(await readFile(assessmentPath, "utf8"))).toEqual(issued.design_assessment);
    const tx = createFoldTransaction();
    const outcome = await handleSystemicChallengeBranch({ root, sourceRoot: root, artifactsDir }, current, emptyState, tx);
    expect(outcome.action).toBe(change === "timestamp" ? "continue" : "return");
    if (change !== "timestamp") {
      if (outcome.action !== "return") throw new Error("stale prior findings were accepted");
      expect(outcome.result.bundle.systemic_challenge).toEqual(issued.systemic_challenge);
      expect(tx.staged.some(submission => submission.applied)).toBe(false);
    } else {
      if (outcome.action !== "continue") throw new Error("cosmetic timestamp change was refused");
      expect(outcome.bundle.systemic_challenge?.rounds).toHaveLength(2);
    }
  });

  test("the adversary dispatch preserves independence when no independent context is available", async () => {
    const { root, artifactsDir } = await makeRoot();
    const step = await emitSystemicStep(root, artifactsDir, systemicBundle(openRegister()));
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain("independent context");
    expect(prompt).toMatch(/stop and report/i);
    expect(prompt).toContain("Do not write a result or run the continue command");
    expect(prompt).not.toMatch(/follow each file sequentially yourself|When executing a lane yourself/);
  });

  test("the recovery validator recognizes issued systemic lanes and preserves their schema", () => {
    const validate = laneSubmissionValidator(systemicChallengeLane([]), { repoFiles: new Set() });
    expect(validate).not.toBeNull();
    expect(validate!({ findings: [] })).toBeNull();
    expect(validate!({ findings: "not an array" })).not.toBeNull();
    expect(laneSubmissionValidator("systemic_challenge_invalid", { repoFiles: new Set() })).toBeNull();
  });

  test("the plan draw probes the same pending round that the execution draw consumes", async () => {
    const bundle = systemicBundle(openRegister([{ round: 1, new_finding_ids: [], dry: true }]));
    const lane = systemicChallengeLane(bundle.systemic_challenge!.rounds);
    const branch = await classifyObligationBranch("systemic_challenge_current", bundle, {
      submissionProbe: async (candidate) => candidate === lane,
    }, () => true);
    expect(branch).toMatchObject({ branch: "await_submission", lane });
  });

  test("real emission resumes within a round, then changes round identity after progress", async () => {
    const { root, artifactsDir } = await makeRoot();
    const firstBundle = systemicBundle(openRegister());

    const first = await emitSystemicStep(root, artifactsDir, firstBundle);
    const firstPath = resultPath(first);
    const sameRound = await emitSystemicStep(root, artifactsDir, firstBundle);
    expect(resultPath(sameRound), "same pending round must preserve its bound path").toBe(firstPath);

    const progressedBundle = systemicBundle(
      openRegister([{ round: 1, new_finding_ids: ["SYS-1"], dry: false }]),
    );
    const second = await emitSystemicStep(root, artifactsDir, progressedBundle);
    const secondPath = resultPath(second);
    expect(secondPath, "accepted non-empty progress must mint the next round").not.toBe(firstPath);
    expect(second.artifact_paths.systemic_challenge_prompt).toBeDefined();
    expect((await readFile(second.artifact_paths.systemic_challenge_prompt, "utf8")).replaceAll("\\", "/")).toContain(
      secondPath.replaceAll("\\", "/"),
    );

    const firstBound = bindCandidateTerminalStep(first);
    const secondBound = bindCandidateTerminalStep(second);
    expect(firstBound.step_id).not.toBe(secondBound.step_id);

    // The candidate driver's repeat guard remains intact: equal emitted
    // identity is still rejected.
    await expect(
      driveCandidateLoop({
        snapshot_root: root,
        pinned_profile: {},
        maxSteps: 2,
        nextStep: async () => ({ ...firstBound, prompt: await readFile(first.prompt_path, "utf8") }),
        executePrompt: async () => {},
      }),
    ).rejects.toThrow(/non-advanc|repeat/i);
  });

  test("real handler folds two identical empty fresh rounds and ignores a restored old lane", async () => {
    const { root, artifactsDir } = await makeRoot();
    const prior = systemicBundle(
      openRegister([{ round: 1, new_finding_ids: ["SYS-1"], dry: false }]),
    );

    // The first empty payload is emitted for round 2 and consumed by the real
    // handler/executor/transaction path.
    const round2Step = await emitSystemicStep(root, artifactsDir, prior);
    const round2Path = resultPath(round2Step);
    await writeBoundReviewFixture(artifactsDir, systemicChallengeLane(prior.systemic_challenge!.rounds), { findings: [] });
    const round2Bytes = await readFile(round2Path, "utf8");
    const tx2 = createFoldTransaction();
    const round2 = await handleSystemicChallengeBranch(
      { root, sourceRoot: root, artifactsDir },
      prior,
      emptyState,
      tx2,
    );
    expect(round2.action).toBe("continue");
    if (round2.action !== "continue") throw new Error("round 2 was not consumed");
    await commitFold(artifactsDir, round2.bundle, tx2);
    expect(round2.bundle.systemic_challenge?.rounds.map((round) => round.dry)).toEqual([
      false,
      true,
    ]);
    expect(round2.bundle.systemic_challenge?.converged).toBe(false);

    // The next fresh quiet round has identical bytes but a distinct emitted
    // lane. It must be consumed as round 3 and converge after the existing
    // two-consecutive-quiet rule. Before consuming it, restore a copy of the
    // accepted round-2 payload at its old path, as a crash recovery sweep can
    // do. The current round must still be read from its newly emitted path.
    const round3Step = await emitSystemicStep(root, artifactsDir, round2.bundle);
    resultPath(round3Step);
    await writeFile(round2Path, round2Bytes);
    const replayTx = createFoldTransaction();
    const replay = await handleSystemicChallengeBranch(
      { root, sourceRoot: root, artifactsDir }, round2.bundle, emptyState, replayTx,
    );
    expect(replay.action).toBe("return");
    expect(replayTx.staged).toHaveLength(0);
    expect(round2.bundle.systemic_challenge?.rounds).toHaveLength(2);
    await writeBoundReviewFixture(artifactsDir, systemicChallengeLane(round2.bundle.systemic_challenge!.rounds), { findings: [] });
    const tx3 = createFoldTransaction();
    const round3 = await handleSystemicChallengeBranch(
      { root, sourceRoot: root, artifactsDir },
      round2.bundle,
      emptyState,
      tx3,
    );
    expect(round3.action).toBe("continue");
    if (round3.action !== "continue") throw new Error("round 3 was not consumed");
    await commitFold(artifactsDir, round3.bundle, tx3);
    expect(round3.bundle.systemic_challenge?.rounds.map((round) => round.dry)).toEqual([
      false,
      true,
      true,
    ]);
    expect(round3.bundle.systemic_challenge?.converged).toBe(true);
    // The restored accepted payload remains forensic at its old path; it was
    // not consumed as a fourth round and was not deleted by the commit.
    expect(await readFile(round2Path, "utf8")).toBe(round2Bytes);
    expect(round3.bundle.systemic_challenge?.rounds).toHaveLength(3);
  });
});
