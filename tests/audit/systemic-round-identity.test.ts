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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { bindCandidateTerminalStep, driveCandidateLoop } from "../../benchmarks/p0/runner.mjs";
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

async function makeRoot(): Promise<{ root: string; artifactsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "systemic-round-identity-"));
  cleanupRoots.push(root);
  return { root, artifactsDir: join(root, ".audit-tools", "audit") };
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

async function submit(path: string, findings: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ findings }), "utf8");
}

const emptyState: AuditState = { status: "active", obligations: [] };

describe("systemic challenge round identity", () => {
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

  test("real emission resumes within a round, then changes benchmark identity after progress", async () => {
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

    // The benchmark's existing repeat guard remains intact: equal emitted
    // identity is still rejected by the candidate driver.
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
    await submit(round2Path, []);
    const tx2 = createFoldTransaction();
    const round2 = await handleSystemicChallengeBranch(
      { root, artifactsDir },
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
    const round3Path = resultPath(round3Step);
    await submit(round2Path, []);
    const replayTx = createFoldTransaction();
    const replay = await handleSystemicChallengeBranch(
      { root, artifactsDir }, round2.bundle, emptyState, replayTx,
    );
    expect(replay.action).toBe("return");
    expect(replayTx.staged).toHaveLength(0);
    expect(round2.bundle.systemic_challenge?.rounds).toHaveLength(2);
    await submit(round3Path, []);
    const tx3 = createFoldTransaction();
    const round3 = await handleSystemicChallengeBranch(
      { root, artifactsDir },
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
    expect(await readFile(round2Path, "utf8")).toBe(JSON.stringify({ findings: [] }));
    expect(round3.bundle.systemic_challenge?.rounds).toHaveLength(3);
  });
});
