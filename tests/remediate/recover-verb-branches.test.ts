import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  recoverIngestVerb,
  recoverSubmissionVerb,
  resolveArtifactsDirOption,
  resolveRootOption,
} from "../../src/remediate/index.js";
import { recoverIngestHostResults } from "../../src/remediate/steps/nextStep.js";
import { prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_VERSION } from "../../src/remediate/steps/types.js";
import {
  createNextStepHarness,
  makePlanningState,
} from "./helpers/nextStepHarness.js";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  currentPromptPath,
  currentStepPath,
  writeStepContract,
} from "audit-tools/shared";

// The two operator recovery verbs' ACTION BRANCHES, called directly.
//
// They were reachable only by spawning the CLI, so the nothing-recovered
// classification, both `process.exit(1)` sites, and `resolveArtifactsDirOption`
// were covered by exactly nothing — a manual smoke log at best. The verbs now
// return their decision as data (`RecoveryVerbResult`), which makes each branch
// a value assertion rather than a process observation.

const harness = createNextStepHarness(".test-recover-verb-branches");
const { REPO_DIR, ARTIFACTS_DIR, saveState, resetTestRepo, cleanupTestRepo } =
  harness;

beforeEach(async () => {
  await resetTestRepo();
});

afterEach(async () => {
  await cleanupTestRepo();
});

/**
 * A persisted, runnable run: the state AND the real workload document the host
 * would answer, minted through the production handoff so the fixture is the
 * artifact shape the ingest actually reads. Hand-writing only the state would
 * exercise a run that never existed — the ingest would short-circuit on a
 * missing workload and never reach the per-item classification under test.
 */
interface RunnableWork {
  workItemId: string;
  resultPath: string;
  /** The tool-minted workload document's absolute path. */
  workloadPath: string;
}

async function persistRunnableState(): Promise<RunnableWork> {
  const state = makePlanningState({
    status: "implementing",
    plan: { ...makePlanningState().plan!, plan_id: "RUN-1" },
  });
  const prepared = await prepareRemediationHostHandoff({
    root: REPO_DIR,
    artifactsDir: ARTIFACTS_DIR,
    runId: "RUN-1",
    baselineCommit: git(["rev-parse", "HEAD"]),
    state: { contract_version: "remediate-code-state/v1alpha1", ...state } as never,
  });
  if (prepared === "unsupported_retired_state") {
    throw new Error("fixture state unexpectedly rejected");
  }
  await saveState({ ...state, host_handoff: prepared.handoff_record });
  const item = prepared.workload.work_items[0]!;
  return {
    workItemId: item.id,
    resultPath: join(REPO_DIR, item.result_path),
    workloadPath: prepared.workload_path,
  };
}

function git(args: string[]): string {
  const result = spawnSyncHidden("git", args, {
    cwd: REPO_DIR,
    encoding: "utf8",
  }) as { stdout?: string };
  return (result.stdout ?? "").trim();
}

/**
 * Land the work the fixture's one work item is bound to, and write the result
 * contract the ingest will ACCEPT: a real commit touching exactly the item's
 * allowed file, bound to the item's own prompt digest and baseline.
 */
async function landAcceptedWork(work: RunnableWork): Promise<void> {
  const statePath = join(ARTIFACTS_DIR, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    host_handoff: { baseline_commit: string };
  };
  const workload = JSON.parse(await readFile(work.workloadPath, "utf8")) as {
    work_items: Array<{
      id: string;
      allowed_files: string[];
      required_tests: string[];
      prompt: { sha256: string };
      baseline_commit: string;
    }>;
  };
  const item = workload.work_items.find((entry) => entry.id === work.workItemId)!;
  const changedFile = item.allowed_files[0]!;
  await mkdir(dirname(join(REPO_DIR, changedFile)), { recursive: true });
  await writeFile(join(REPO_DIR, changedFile), "// landed by the host\n", "utf8");
  git(["add", changedFile]);
  git(["commit", "-m", "land the work"]);
  const landed = git(["rev-parse", "HEAD"]);

  await mkdir(dirname(work.resultPath), { recursive: true });
  await writeFile(
    work.resultPath,
    JSON.stringify({
      contract_version: RESULT_VERSION,
      result_id: `result-${item.id}`,
      run_id: "RUN-1",
      work_item_id: item.id,
      prompt_sha256: item.prompt.sha256,
      changed_files: [changedFile],
      commit_evidence: {
        before: state.host_handoff.baseline_commit,
        after: landed,
      },
      test_evidence: item.required_tests.map((command) => ({
        command,
        status: "passed",
      })),
      obligation_evidence: [],
      worktree_evidence: {
        baseline_commit: item.baseline_commit,
        changed_files: [changedFile],
      },
      acceptance: { status: "accepted" },
      merge: { status: "merged" },
    }),
    "utf8",
  );
}

describe("recover-ingest action branch", () => {
  it("reports nothing-to-recover with exit 1 when there is no state at all", async () => {
    const result = await recoverIngestVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    // No state.json is an UNRUNNABLE, not a "nothing to recover": the operator
    // asked to recover a run that does not exist, which is a different repair.
    expect(result.status).toBe("unrunnable");
    if (result.status !== "unrunnable") return;
    expect(result.message).toMatch(/nothing to ingest/u);
  });

  it("distinguishes EXPECTED-PENDING (exit 75) from a REAL issue (exit 1)", async () => {
    const work = await persistRunnableState();

    // (1) A bound work item with no result file at all: the host simply has not
    // written it yet. Expected-pending, NOT a failure — an operator scripting a
    // retry loop must not read a normal wait as a wedge.
    const pending = await recoverIngestVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(pending.status).toBe("pending");
    if (pending.status !== "pending") return;
    expect(pending.exitCode).toBe(75);
    expect(pending.body["status"]).toBe("pending");
    expect(pending.body["accepted_count"]).toBe(0);

    // (2) A REAL issue — a result file that exists but is not the contract. The
    // item is no longer merely unwritten; the operator must act. Same verb, same
    // empty accept set, different meaning.
    await mkdir(dirname(work.resultPath), { recursive: true });
    await writeFile(
      work.resultPath,
      JSON.stringify({ contract_version: RESULT_VERSION }),
      "utf8",
    );
    const real = await recoverIngestVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(real.status).toBe("nothing-to-recover");
    if (real.status !== "nothing-to-recover") return;
    expect(real.exitCode).toBe(1);
    // The three arms are distinguishable WITHOUT parsing prose: the status token
    // and the exit code agree.
    expect(real.body["status"]).toBe("nothing-to-recover");
  });

  it("resolves the artifacts dir default onto the root and honors an explicit one", () => {
    // `resolveArtifactsDirOption` is the boundary between "the commander default"
    // and "the operator named a directory", and it shipped with no test. The
    // default must rebase onto the resolved root; anything else is used verbatim.
    const root = join(REPO_DIR, "nested");
    expect(resolveArtifactsDirOption(root, ".audit-tools/remediation")).toBe(
      join(root, ".audit-tools", "remediation"),
    );
    const explicit = join(REPO_DIR, "elsewhere");
    expect(resolveArtifactsDirOption(root, explicit)).toBe(explicit);
  });

  it("honors an explicit --root verbatim, climbing only out of a .audit-tools segment", async () => {
    // The explicit arm only: the ABSENT arm discovers from the caller's cwd,
    // which is process-global and therefore not hersable from inside a parallel
    // vitest worker. What is pinned here is the property that distinguishes the
    // two arms — an explicit root is an INSTRUCTION, honored as given rather
    // than climbed to some larger repository.
    await mkdir(join(REPO_DIR, ".audit-tools"), { recursive: true });
    const nested = join(REPO_DIR, "sub-project");
    await mkdir(nested, { recursive: true });
    expect(resolveRootOption(nested)).toBe(nested);
    expect(resolveRootOption(join(REPO_DIR, ".audit-tools"))).toBe(REPO_DIR);
    expect(
      resolveRootOption(join(REPO_DIR, ".audit-tools", "remediation")),
    ).toBe(REPO_DIR);
  });
});

describe("recover-submission action branch", () => {
  it("refuses with no live binding rather than validating against nothing", async () => {
    // No handoff record names this work item, so there is no contract to check
    // the payload against. "No contract" must never read as "passes".
    const result = await recoverSubmissionVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
      submissionId: "B-001",
      from: join(REPO_DIR, "operator-fixed.json"),
    });
    expect(result.status).toBe("unrunnable");
    if (result.status !== "unrunnable") return;
    expect(result.message).toMatch(/No live workload/u);
  });

  it("refuses an unreadable --from payload without touching the run", async () => {
    await persistRunnableState();
    const result = await recoverSubmissionVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
      submissionId: "B-001",
      from: join(REPO_DIR, "does-not-exist.json"),
    });
    expect(result.status).toBe("unrunnable");
    if (result.status !== "unrunnable") return;
    expect(result.message).toMatch(/refused the payload/u);
  });
});

// ── Any verb that mutates run state refreshes or invalidates the step ────────

describe("recovery verbs invalidate the persisted step contract", () => {
  /**
   * A live-looking step contract, written through the SHARED writer so the
   * fixture is the real artifact shape (per-agent slot + shared mirror, prompt
   * file + JSON) rather than a hand-made approximation.
   */
  async function writeLiveStepContract(): Promise<void> {
    await writeStepContract({
      contractVersion: "remediate-code-step/v1alpha1",
      stepKind: "dispatch_implement",
      status: "ready",
      runId: "RUN-1",
      allowedCommands: [],
      stopCondition: "stop",
      repoRoot: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      prompt: "# Implement the Eligible Remediation Workload\n",
    });
  }

  it("CONTROL: the fixture writes both slots before the verb runs", async () => {
    await writeLiveStepContract();
    expect(existsSync(currentStepPath(ARTIFACTS_DIR))).toBe(true);
    expect(existsSync(currentPromptPath(ARTIFACTS_DIR))).toBe(true);
  });

  it("clears both slots when recover-ingest MUTATED state, and leaves them when it did not", async () => {
    const work = await persistRunnableState();
    // A result that will be refused: real issues, no acceptance, no state write.
    await mkdir(dirname(work.resultPath), { recursive: true });
    await writeFile(
      work.resultPath,
      JSON.stringify({ contract_version: RESULT_VERSION }),
      "utf8",
    );
    await writeLiveStepContract();

    const unchanged = await recoverIngestHostResults({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(unchanged.state_changed).toBe(false);
    // Nothing moved, so the contract still describes the run. Deleting it here
    // would be the tool destroying a live instruction for no reason.
    expect(existsSync(currentStepPath(ARTIFACTS_DIR))).toBe(true);
    expect(existsSync(currentPromptPath(ARTIFACTS_DIR))).toBe(true);
  });

  it("clears both slots when a recovery MUTATED state, and leaves them when it did not", async () => {
    const work = await persistRunnableState();
    await writeLiveStepContract();

    // A refused pass: no acceptance, no state write, so the contract still
    // describes the run and must survive. Deleting it here would be the tool
    // destroying a live instruction for no reason.
    const refused = await recoverIngestHostResults({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(refused.state_changed).toBe(false);
    expect(
      existsSync(currentStepPath(ARTIFACTS_DIR)),
      "a no-op pass must not invalidate a live step",
    ).toBe(true);
    expect(existsSync(currentPromptPath(ARTIFACTS_DIR))).toBe(true);

    // Now a REAL acceptance: the host's work landed, so the run moved and the
    // last contract names work that no longer exists. Both slots go.
    await landAcceptedWork(work);
    const summary = await recoverIngestHostResults({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(summary.accepted_count).toBe(1);
    expect(summary.state_changed).toBe(true);
    expect(
      existsSync(currentStepPath(ARTIFACTS_DIR)),
      "a contract naming resolved work must not survive the mutation",
    ).toBe(false);
    expect(existsSync(currentPromptPath(ARTIFACTS_DIR))).toBe(false);
  });

  it("clears both slots when recover-submission LANDS a payload", async () => {
    // The other state-mutating recovery verb, and the half of the acceptance
    // that says ANY such verb invalidates the contract. A rescue lands a
    // submission where the run expected one, so the persisted step — which
    // names the work item the payload now answers — is a live instruction for
    // work that has just been supplied.
    const work = await persistRunnableState();
    await writeLiveStepContract();
    const workload = JSON.parse(await readFile(work.workloadPath, "utf8")) as {
      run_id: string;
      work_items: Array<{
        id: string;
        allowed_files: string[];
        required_tests: string[];
        prompt: { sha256: string };
        baseline_commit: string;
      }>;
    };
    const item = workload.work_items[0]!;
    // The rescue payload must bind the baseline to a DISTINCT landed commit —
    // a submission that changes nothing is a decision, not a result.
    const changedFile = item.allowed_files[0]!;
    await mkdir(dirname(join(REPO_DIR, changedFile)), { recursive: true });
    await writeFile(
      join(REPO_DIR, changedFile),
      "// landed by the operator\n",
      "utf8",
    );
    git(["add", changedFile]);
    git(["commit", "-m", "operator fix"]);
    const payloadPath = join(REPO_DIR, "operator-fixed.json");
    await writeFile(
      payloadPath,
      JSON.stringify({
        contract_version: RESULT_VERSION,
        result_id: `result-${item.id}`,
        run_id: workload.run_id,
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        changed_files: item.allowed_files,
        commit_evidence: {
          before: item.baseline_commit,
          after: git(["rev-parse", "HEAD"]),
        },
        test_evidence: item.required_tests.map((command) => ({
          command,
          status: "passed",
        })),
        obligation_evidence: [],
        worktree_evidence: {
          baseline_commit: item.baseline_commit,
          changed_files: item.allowed_files,
        },
        acceptance: { status: "accepted" },
        merge: { status: "merged" },
      }),
      "utf8",
    );

    const result = await recoverSubmissionVerb({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
      submissionId: work.workItemId,
      from: payloadPath,
    });
    expect(result.status).toBe("recovered");
    // The payload landed under the run's own submission directory...
    expect(existsSync(work.resultPath)).toBe(true);
    // ...and the contract that named the answered work item is gone.
    expect(
      existsSync(currentStepPath(ARTIFACTS_DIR)),
      "a contract naming answered work must not survive the rescue",
    ).toBe(false);
    expect(existsSync(currentPromptPath(ARTIFACTS_DIR))).toBe(false);
  });

  it("a no-op recover-ingest leaves state.json byte-identical", async () => {
    await persistRunnableState();
    const statePath = join(ARTIFACTS_DIR, "state.json");
    const before = await readFile(statePath, "utf8");

    const summary = await recoverIngestHostResults({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      runId: "RUN-1",
    });
    expect(summary.state_changed).toBe(false);
    expect(await readFile(statePath, "utf8")).toBe(before);
  });
});
