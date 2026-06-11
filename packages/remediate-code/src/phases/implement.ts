import { RemediationState, StateStore } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import {
  VerificationResult,
  RemediationBlock,
  REMEDIATION_STEP,
} from "../state/types.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  readOptionalJsonFile,
  writeJsonFile,
  readJsonFile,
  detectRepoConventions,
  formatRepoConventions,
  type SessionConfig,
} from "@audit-tools/shared";
import { resolveWorkerTaskMaxRetries } from "../types/workerSession.js";
import { runCommand, runShellCommand } from "../utils/commands.js";
import {
  createLaunchInputForTask,
  createRemediationWorkerTask,
} from "./workerTasks.js";
import {
  DEFAULT_REFACTOR_MAX_RETRIES,
  RETRY_TEST_OUTPUT_TAIL_CHARS,
} from "./constants.js";

async function runStepWithProvider(
  provider: any,
  options: OrchestratorOptions,
  planId: string,
  findingId: string,
  stepName: string,
  promptContent: string,
  writeResultInstruction = false,
  taskOptions: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<boolean> {
  const stepId = stepName.toLowerCase().replace(/ /g, "_");
  const taskPath = join(
    options.artifactsDir,
    `task_${findingId}_${stepId}.json`,
  );
  const resultPath = join(
    options.artifactsDir,
    `result_${findingId}_${stepId}.json`,
  );

  let fullPrompt = promptContent;
  fullPrompt +=
    `\n\nRepository root: ${options.root}\n` +
    "Set the shell/tool workdir to the repository root when running commands; do not rely on cwd state from prior shell calls.\n" +
    "Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.\n" +
    "Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.";
  if (writeResultInstruction) {
    fullPrompt += `\n\nYour task JSON is at: ${taskPath}\nWrite your result JSON to exactly this path: ${resultPath}\nUse the Write tool to create or overwrite that file.\nDo not write to any other path.`;
  } else {
    fullPrompt += `\n\nEdit source files directly to implement the required changes. Signal success by completing without errors.`;
  }

  const promptPath = join(
    options.artifactsDir,
    `prompt_${findingId}_${stepId}.md`,
  );
  await writeFile(promptPath, fullPrompt, "utf8");

  const stdoutPath = join(
    options.artifactsDir,
    `stdout_${findingId}_${stepId}.txt`,
  );
  const stderrPath = join(
    options.artifactsDir,
    `stderr_${findingId}_${stepId}.txt`,
  );

  const task = createRemediationWorkerTask({
    runId: planId,
    options,
    obligationId: findingId,
    preferredExecutor: provider.name,
    resultPath,
    timeoutMs: taskOptions.timeoutMs,
    maxRetries: taskOptions.maxRetries,
  });
  await writeJsonFile(taskPath, task);

  try {
    await provider.launch(createLaunchInputForTask(options, task, {
      promptPath,
      taskPath,
      stdoutPath,
      stderrPath,
    }));
    return true;
  } catch (err) {
    const exitCode = (err as any)?.exitCode ?? (err as any)?.code ?? "unknown";
    console.error(
      `[implement] event=step_failed finding_id=${findingId} step=${stepName} stdout=${stdoutPath} stderr=${stderrPath} error=${err}`,
    );
    return false;
  }
}

// Topologically sorts blocks by their dependency edges (DFS post-order).
export function sortBlocksByDependency(
  blocks: RemediationBlock[],
): RemediationBlock[] {
  const sorted: RemediationBlock[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(blockId: string): void {
    if (visited.has(blockId)) return;
    if (visiting.has(blockId))
      throw new Error("Circular dependency detected in blocks");
    visiting.add(blockId);
    const block = blocks.find((b) => b.block_id === blockId);
    if (block) {
      for (const dep of block.dependencies ?? []) {
        visit(dep);
      }
      sorted.push(block);
    }
    visiting.delete(blockId);
    visited.add(blockId);
  }

  for (const block of blocks) {
    visit(block.block_id);
  }
  return sorted;
}

interface ExecuteBlockDeps {
  state: RemediationState;
  options: OrchestratorOptions;
  provider: any;
  store: Pick<StateStore, "saveState">;
}

// Runs all implementation steps (Write Tests → Refactor Code → Verify) for
// every finding in a single block.
export async function executeBlock(
  block: RemediationBlock,
  blockRoot: string,
  { state, options, provider, store }: ExecuteBlockDeps,
): Promise<void> {
  for (const findingId of block.items) {
    const item = state.items![findingId];
    if (
      !item ||
      [
        "blocked",
        "resolved",
        "resolved_no_change",
        "deemed_inappropriate",
        "ignored",
      ].includes(item.status)
    )
      continue;

    const itemSpec = item.item_spec;
    if (!itemSpec) {
      item.status = "blocked";
      item.failure_reason = "Missing item_spec";
      await store.saveState(state);
      continue;
    }

    console.log(`[implement] event=item_start finding_id=${findingId} block_id=${block.block_id}`);

    // --- Write Tests step ---
    const skipTests = itemSpec.not_applicable_steps.find(
      (s) => s.step === REMEDIATION_STEP.WRITE_TESTS,
    );
    if (!skipTests && item.status === "pending") {
      const prompt = `Write tests for the following finding:\nID: ${findingId}\nSpec: ${JSON.stringify(itemSpec, null, 2)}`;
      const stepSuccess = await runStepWithProvider(
        provider,
        { ...options, root: blockRoot },
        state.plan!.plan_id,
        findingId,
        REMEDIATION_STEP.WRITE_TESTS,
        prompt,
      );
      if (stepSuccess) {
        if (state.plan!.test_command) {
          const testResult = runShellCommand(state.plan!.test_command, {
            cwd: blockRoot,
            stdio: "ignore",
          });
          if (testResult.status === 0) {
            item.status = "blocked";
            item.failure_reason =
              "Tests passed before refactoring (tests must fail on current code)";
            await store.saveState(state);
            continue;
          }
        }
        item.status = "tested";
        item.last_successful_step = REMEDIATION_STEP.WRITE_TESTS;
        await store.saveState(state);
      } else {
        item.status = "blocked";
        item.failure_reason = "Write Tests failed";
        await store.saveState(state);
        continue;
      }
    } else if (item.status === "pending") {
      item.status = "tested";
      item.last_successful_step = REMEDIATION_STEP.WRITE_TESTS;
      await store.saveState(state);
    }

    // --- Refactor Code step ---
    const skipRefactor = itemSpec.not_applicable_steps.find(
      (s) => s.step === REMEDIATION_STEP.REFACTOR_CODE,
    );
    if (
      !skipRefactor &&
      (item.status === "tested" || item.status === "tested_successfully")
    ) {
      const refactorSuccess = await runRefactorWithRetry(
        provider,
        { ...options, root: blockRoot },
        state,
        findingId,
        itemSpec,
        blockRoot,
      );
      if (refactorSuccess) {
        item.status = "refactored";
        item.last_successful_step = REMEDIATION_STEP.REFACTOR_CODE;
        await store.saveState(state);
      } else {
        item.status = "blocked";
        item.failure_reason = "Refactor Code failed after max retries";
        await store.saveState(state);
        continue;
      }
    } else if (
      item.status === "tested" ||
      item.status === "tested_successfully"
    ) {
      item.status = "refactored";
      item.last_successful_step = REMEDIATION_STEP.REFACTOR_CODE;
      await store.saveState(state);
    }

    // --- Verify step ---
    const skipVerify = itemSpec.not_applicable_steps.find(
      (s) => s.step === REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION,
    );
    const verifiableStatuses = [
      "tested",
      "tested_successfully",
      "refactored",
    ] as const;
    if (
      !skipVerify &&
      verifiableStatuses.includes(
        item.status as (typeof verifiableStatuses)[number],
      )
    ) {
      const prompt = `Verify the code against the documentation for finding:\nID: ${findingId}\nSpec: ${JSON.stringify(itemSpec, null, 2)}\n\nWrite a VerificationResult JSON with shape: { "finding_id": string, "passed": boolean, "reason": string[] } where reason lists the evidence supporting the verdict.`;
      let verifySuccess = await runStepWithProvider(
        provider,
        { ...options, root: blockRoot },
        state.plan!.plan_id,
        findingId,
        REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION,
        prompt,
        true,
      );
      if (verifySuccess) {
        const resultPath = join(
          options.artifactsDir,
          `result_${findingId}_verify_code_against_documentation.json`,
        );
        try {
          const verRes = await readJsonFile<VerificationResult>(resultPath);
          if (!verRes.passed) verifySuccess = false;
        } catch (e) {
          console.error(
            `[implement] event=verify_result_read_failed finding_id=${findingId} path=${resultPath} error=${e}`,
          );
          verifySuccess = false;
        }
      }

      if (verifySuccess) {
        item.status = "resolved";
        item.last_successful_step = REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION;
        await store.saveState(state);
      } else {
        item.status = "blocked";
        item.failure_reason = "Verification failed";
        await store.saveState(state);
      }
    } else if (
      verifiableStatuses.includes(
        item.status as (typeof verifiableStatuses)[number],
      )
    ) {
      item.status = "resolved";
      item.last_successful_step = REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION;
      await store.saveState(state);
    }
  }
}

async function runRefactorWithRetry(
  provider: any,
  options: OrchestratorOptions,
  state: RemediationState,
  findingId: string,
  itemSpec: any,
  blockRoot: string,
  maxRetries = DEFAULT_REFACTOR_MAX_RETRIES,
): Promise<boolean> {
  const effectiveMaxRetries = resolveWorkerTaskMaxRetries(
    { max_retries: maxRetries },
    DEFAULT_REFACTOR_MAX_RETRIES,
  );
  let lastTestOutput = "";

  // Phase 7A: hand the implementing worker the repo's house style so its edits
  // match the surrounding code (parity with the document phase).
  const conventions = formatRepoConventions(detectRepoConventions(options.root));

  for (let retries = 0; retries < effectiveMaxRetries; retries++) {
    let prompt = `Refactor the code to fix the following finding:\nID: ${findingId}\nSpec: ${JSON.stringify(itemSpec, null, 2)}`;
    if (conventions) {
      prompt += `\n\n${conventions}`;
    }
    if (retries > 0) {
      prompt += `\n\nPREVIOUS ATTEMPT FAILED TESTS:\n${lastTestOutput}\nPlease fix the code so the tests pass.`;
    }
    const stepSuccess = await runStepWithProvider(
      provider,
      options,
      state.plan!.plan_id,
      findingId,
      `Refactor Code Retry ${retries}`,
      prompt,
      false,
      { maxRetries: effectiveMaxRetries },
    );
    if (stepSuccess) {
      if (state.plan!.test_command) {
        const testResult = runShellCommand(state.plan!.test_command, {
          cwd: blockRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (testResult.status === 0) {
          return true;
        }
        const stdout = testResult.stdout ? testResult.stdout.toString() : "";
        const stderr = testResult.stderr ? testResult.stderr.toString() : "";
        lastTestOutput =
          (stdout + "\n" + stderr)
            .trim()
            .slice(-RETRY_TEST_OUTPUT_TAIL_CHARS) || "Tests failed";
      } else {
        return true;
      }
    }
  }
  return false;
}

function cloneStateForBlock(state: RemediationState): RemediationState {
  return JSON.parse(JSON.stringify(state)) as RemediationState;
}

function mergeBlockState(
  target: RemediationState,
  source: RemediationState,
  block: RemediationBlock,
): void {
  if (!target.items || !source.items) return;
  for (const findingId of block.items) {
    if (source.items[findingId]) {
      target.items[findingId] = source.items[findingId];
    }
  }
}

function describeGitFailure(result: ReturnType<typeof runCommand>): string {
  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString().trim();
  return stderr || stdout || `exit code ${result.status ?? "unknown"}`;
}

function canUseGitWorktrees(root: string): boolean {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout) return false;
  return (
    resolve(result.stdout.toString().trim()).toLowerCase() ===
    resolve(root).toLowerCase()
  );
}

interface WorktreeBlockResult {
  ok: boolean;
  state?: RemediationState;
  /** The commit SHA created in the worktree for this block, if any. */
  commitSha?: string;
}

// Runs a block in a git worktree branch. State mutations are kept in a cloned
// state object and merged back only after the worktree branch merges cleanly.
async function runBlockInWorktree(
  block: RemediationBlock,
  options: OrchestratorOptions,
  worktreesDir: string,
  deps: ExecuteBlockDeps,
): Promise<WorktreeBlockResult> {
  const blockBranch = `remediator-block-${block.block_id}`;
  const blockRoot = join(worktreesDir, block.block_id);

  // Best-effort cleanup of any worktree/branch left over by a crashed prior
  // attempt for this block, so a retry isn't permanently blocked by an
  // "already exists" error. Both are harmless no-ops when nothing is left.
  runCommand("git", ["worktree", "remove", blockRoot, "--force"], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runCommand("git", ["branch", "-D", blockBranch], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Create branch + worktree atomically. The previous two-step form (git branch
  // then git worktree add) leaked the branch when the second step failed: the
  // dangling branch then made every later `git branch` fail, permanently
  // forcing sequential mode for this block with no diagnostic (COR-001).
  const worktreeRes = runCommand(
    "git",
    ["worktree", "add", "-b", blockBranch, blockRoot],
    { cwd: options.root, stdio: ["ignore", "pipe", "pipe"] },
  );

  if (worktreeRes.status !== 0) {
    console.warn(
      `[implement] event=worktree_create_failed block_id=${block.block_id} mode=sequential detail=${describeGitFailure(worktreeRes)}`,
    );
    return { ok: false };
  }

  const blockState = cloneStateForBlock(deps.state);
  await executeBlock(block, blockRoot, {
    ...deps,
    state: blockState,
    store: { saveState: async () => undefined },
  });

  // Stage with an explicit pathspec that excludes the remediation artifact dir
  // so any stray artifact files written into the worktree subtree are never
  // committed into the block's commit (defensive: the top-level .gitignore also
  // ignores .remediation-artifacts/, but a worktree-local write would bypass it).
  runCommand(
    "git",
    [
      "add",
      "-A",
      "--",
      ":(exclude).audit-tools/",
      ":(exclude).audit-tools",
    ],
    { cwd: blockRoot },
  );
  // `git diff --cached --quiet` exits 0 when nothing is staged and 1 when there
  // are staged changes. Only commit when there is something to commit; that way
  // a non-zero commit status is a genuine failure (e.g. a commit hook) rather
  // than the benign "nothing to commit" case for a block that made no edits.
  const hasStagedChanges = runCommand("git", ["diff", "--cached", "--quiet"], {
    cwd: blockRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let commitSha: string | undefined;
  if (hasStagedChanges.status !== 0) {
    const commitRes = runCommand(
      "git",
      ["commit", "-m", `Remediation for block ${block.block_id}`],
      {
        cwd: blockRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (commitRes.status !== 0) {
      // A real commit failure would otherwise be swallowed and the block's edits
      // silently lost. Fall back to sequential execution and clean up so the
      // leftover worktree/branch doesn't block a retry.
      console.warn(
        `[implement] event=worktree_commit_failed block_id=${block.block_id} mode=sequential detail=${describeGitFailure(commitRes)}`,
      );
      runCommand("git", ["worktree", "remove", blockRoot, "--force"], {
        cwd: options.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      runCommand("git", ["branch", "-D", blockBranch], {
        cwd: options.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: false };
    }
    // Capture the commit SHA for the post-merge re-verification gate so the
    // merge loop can roll back exactly this block's changes when attribution
    // identifies it as part of a guilty set (N-R18).
    const shaRes = runCommand("git", ["rev-parse", "HEAD"], {
      cwd: blockRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (shaRes.status === 0 && shaRes.stdout) {
      commitSha = shaRes.stdout.toString().trim();
    }
  }
  return { ok: true, state: blockState, commitSha };
}

function mergeWorktreeBlock(
  block: RemediationBlock,
  options: OrchestratorOptions,
  worktreesDir: string,
  testCommand: string | undefined,
): boolean {
  const blockBranch = `remediator-block-${block.block_id}`;
  const blockRoot = join(worktreesDir, block.block_id);

  if (!existsSync(blockRoot)) return false;

  const baseRefRes = runCommand("git", ["rev-parse", "HEAD"], {
    cwd: options.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseRef =
    baseRefRes.status === 0 ? baseRefRes.stdout?.toString().trim() : "HEAD";

  const rebaseRes = runCommand("git", ["rebase", baseRef || "HEAD"], {
    cwd: blockRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let rebaseAndTestSuccess = false;
  if (rebaseRes.status === 0) {
    let testsPassed = true;
    if (testCommand) {
      const testResult = runShellCommand(testCommand, {
        cwd: blockRoot,
      });
      if (testResult.status !== 0) testsPassed = false;
    }
    if (testsPassed) rebaseAndTestSuccess = true;
  } else {
    console.warn(
      `[implement] event=worktree_rebase_failed block_id=${block.block_id} detail=${describeGitFailure(rebaseRes)}`,
    );
  }

  if (!rebaseAndTestSuccess && rebaseRes.status !== 0) {
    runCommand("git", ["rebase", "--abort"], { cwd: blockRoot });
  }

  if (rebaseAndTestSuccess) {
    runCommand("git", ["merge", blockBranch], { cwd: options.root });
  } else {
    console.log(
      `[implement] event=worktree_merge_skipped block_id=${block.block_id} reason=rebase_or_test_failed mode=sequential`,
    );
  }

  runCommand("git", ["worktree", "remove", blockRoot, "--force"], {
    cwd: options.root,
  });
  runCommand("git", ["branch", "-D", blockBranch], { cwd: options.root });

  return rebaseAndTestSuccess;
}

/**
 * Runs the post-merge re-verification gate for `failedBlock` after it was
 * merged into the main tree.  On failure, bisects (in reverse-merge order) to
 * find the smallest guilty subset of already-merged blocks whose `touched_files`
 * overlap the implicated surface, reverts only those commits, and re-enters
 * their items into triage (status `'blocked'` + `failure_reason` attribution).
 * Non-guilty merged blocks are left intact.
 *
 * @param options       Orchestrator options (root / artifactsDir).
 * @param state         Mutable remediation state (items mutated in place).
 * @param store         State store used to persist mutations.
 * @param mergedBlocks  All blocks merged so far, in merge order (oldest first).
 * @param mergedCommits Map<block_id → commitSha> accumulated during the merge loop.
 * @param failedBlock   The block whose post-merge gate just failed.
 * @param testOutput    Tail of test stdout+stderr from the failed gate run.
 */
export async function attributePostMergeFailure(
  options: OrchestratorOptions,
  state: RemediationState,
  store: Pick<StateStore, "saveState">,
  mergedBlocks: RemediationBlock[],
  mergedCommits: Map<string, string>,
  failedBlock: RemediationBlock,
  testOutput: string,
): Promise<void> {
  // Gather candidates: all merged blocks (including the just-merged one) whose
  // touched_files overlap failedBlock's touched_files, or whose items touch the
  // same files as failedBlock.
  const failedFiles = new Set<string>([
    ...(failedBlock.touched_files ?? []),
    ...failedBlock.items.flatMap(
      (id) => state.items?.[id]?.item_spec?.touched_files ?? [],
    ),
  ]);

  const candidates = mergedBlocks.filter((b) => {
    const bFiles = new Set<string>([
      ...(b.touched_files ?? []),
      ...b.items.flatMap(
        (id) => state.items?.[id]?.item_spec?.touched_files ?? [],
      ),
    ]);
    for (const f of bFiles) {
      if (failedFiles.has(f)) return true;
    }
    // Also include the failed block itself (its commit is always a candidate).
    return b.block_id === failedBlock.block_id;
  });

  if (candidates.length === 0) {
    // No overlap info — treat the failed block as the sole guilty party.
    candidates.push(failedBlock);
  }

  // Bisect: iterate candidates in reverse-merge order (most-recently merged
  // first). For each candidate, revert its commit and re-run the gate; the
  // first candidate whose revert makes the gate pass is the guilty block.
  // If no single revert isolates the failure, mark all candidates guilty.
  const gateCommand = (
    (failedBlock.targeted_commands?.length ? failedBlock.targeted_commands : null) ??
    (state.plan!.test_command ? [state.plan!.test_command] : null)
  );

  const reverseMergeOrder = [...candidates].reverse();
  let guiltySet: RemediationBlock[] = candidates; // default: all guilty

  if (gateCommand && candidates.length > 1) {
    // Try reverting each candidate in isolation to find the guilty one.
    for (const candidate of reverseMergeOrder) {
      const sha = mergedCommits.get(candidate.block_id);
      if (!sha) continue;
      // Revert candidate's commit (no-commit so we can test then reset).
      const revertRes = runCommand(
        "git",
        ["revert", "--no-commit", sha],
        { cwd: options.root, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (revertRes.status !== 0) {
        // Can't isolate — revert with abort and fall through to all-guilty.
        runCommand("git", ["revert", "--abort"], {
          cwd: options.root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        continue;
      }
      // Run gate command after reverting.
      let allPass = true;
      for (const cmd of gateCommand) {
        const testResult = runShellCommand(cmd, {
          cwd: options.root,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (testResult.status !== 0) { allPass = false; break; }
      }
      // Reset the tentative revert regardless of outcome.
      runCommand("git", ["reset", "--hard", "HEAD"], {
        cwd: options.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (allPass) {
        // Reverting this candidate restored green: it's the guilty one.
        guiltySet = [candidate];
        break;
      }
    }
  }

  // Roll back guilty blocks: git revert --no-commit each guilty commit, then
  // commit the combined revert so the main tree stays clean.
  const guiltyIds = guiltySet.map((b) => b.block_id).join(", ");
  const guiltyFiles = Array.from(failedFiles).join(", ") || "(unknown)";
  const attributionMsg =
    `Post-merge gate failed. Guilty blocks: [${guiltyIds}]. ` +
    `Implicated surface: ${guiltyFiles}. ` +
    `Test tail: ${testOutput.slice(-500)}`;

  const commitShasToRevert = guiltySet
    .map((b) => mergedCommits.get(b.block_id))
    .filter((sha): sha is string => !!sha);

  if (commitShasToRevert.length > 0) {
    // Revert commits in reverse-merge order (newest first) to minimize conflicts.
    for (const sha of [...commitShasToRevert].reverse()) {
      runCommand("git", ["revert", "--no-commit", sha], {
        cwd: options.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    const combinedMsg = `Revert guilty blocks [${guiltyIds}] — post-merge gate failure`;
    runCommand("git", ["commit", "-m", combinedMsg], {
      cwd: options.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // Re-enter every rolled-back block's items into triage.
  for (const guiltyBlock of guiltySet) {
    for (const findingId of guiltyBlock.items) {
      const item = state.items?.[findingId];
      if (!item) continue;
      item.status = "blocked";
      item.failure_reason = attributionMsg;
      item.rework_count = (item.rework_count ?? 0) + 1;
    }
  }
  await store.saveState(state);
}

/**
 * Runs the post-merge re-verification gate for a just-merged block.
 * Returns `{ passed: boolean; testOutput: string }`.
 * When neither `targeted_commands` nor `test_command` is available the gate
 * is a no-op and always returns `{ passed: true, testOutput: "" }`.
 */
function runPostMergeGate(
  block: RemediationBlock,
  options: OrchestratorOptions,
  testCommand: string | undefined,
): { passed: boolean; testOutput: string } {
  const commands: string[] = block.targeted_commands?.length
    ? block.targeted_commands
    : testCommand
      ? [testCommand]
      : [];

  if (commands.length === 0) {
    return { passed: true, testOutput: "" };
  }

  let combinedOutput = "";
  for (const cmd of commands) {
    const result = runShellCommand(cmd, {
      cwd: options.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = result.stdout ? result.stdout.toString() : "";
    const stderr = result.stderr ? result.stderr.toString() : "";
    combinedOutput += (stdout + "\n" + stderr).trim() + "\n";
    if (result.status !== 0) {
      return {
        passed: false,
        testOutput: combinedOutput.trim().slice(-RETRY_TEST_OUTPUT_TAIL_CHARS),
      };
    }
  }
  return { passed: true, testOutput: combinedOutput.trim() };
}

export async function runImplementPhase(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<RemediationState> {
  console.log(`[implement] event=phase_start root=${options.root}`);

  if (!state.plan || !state.items) {
    throw new Error(
      "Cannot run implement phase: plan or items missing from state.",
    );
  }

  const sessionConfig =
    (await readOptionalJsonFile<SessionConfig>(
      join(options.root, "session-config.json"),
    )) || {};
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const store = new StateStore(options.artifactsDir);
  const blockDeps: ExecuteBlockDeps = { state, options, provider, store };

  const sortedBlocks = sortBlocksByDependency(state.plan.blocks);
  const parallelBlocks = sortedBlocks.filter((b) => b.parallel_safe);
  const sequentialBlocks = sortedBlocks.filter((b) => !b.parallel_safe);

  const worktreesDir = join(options.artifactsDir, "worktrees");
  const useWorktrees =
    parallelBlocks.length > 0 && canUseGitWorktrees(options.root);
  if (useWorktrees && !existsSync(worktreesDir)) {
    await mkdir(worktreesDir, { recursive: true });
  }

  const worktreeFailedBlocks: RemediationBlock[] = [];
  const worktreeResults = new Map<string, WorktreeBlockResult>();
  const sequentialFallbackQueue: RemediationBlock[] = [];
  // Accumulated during the merge loop: block_id → commit SHA in main tree
  // after the merge. Used by attributePostMergeFailure to roll back guilty
  // blocks when the post-merge gate fails (N-R18).
  const mergedCommits = new Map<string, string>();
  // Blocks whose worktree branch was successfully merged, in merge order.
  const successfullyMergedBlocks: RemediationBlock[] = [];

  if (useWorktrees) {
    const parallelPromises = parallelBlocks.map(async (block) => {
      const result = await runBlockInWorktree(
        block,
        options,
        worktreesDir,
        blockDeps,
      );
      worktreeResults.set(block.block_id, result);
      if (!result.ok) worktreeFailedBlocks.push(block);
    });
    await Promise.all(parallelPromises);

    for (const block of parallelBlocks) {
      const merged = mergeWorktreeBlock(
        block,
        options,
        worktreesDir,
        state.plan.test_command,
      );
      const result = worktreeResults.get(block.block_id);
      if (!result?.ok) continue;
      if (merged && result?.state) {
        mergeBlockState(state, result.state, block);
        await store.saveState(state);

        // Record the commitSha returned from the worktree so the post-merge
        // gate can attribute and roll back exactly this block if needed.
        if (result.commitSha) {
          mergedCommits.set(block.block_id, result.commitSha);
        }
        successfullyMergedBlocks.push(block);

        // Post-merge re-verification gate (N-R18): run targeted_commands (or
        // fall back to test_command) against the NOW-MERGED main tree. On
        // failure, attribute to the guilty subset of merged blocks and re-enter
        // their items into triage.
        const gate = runPostMergeGate(block, options, state.plan!.test_command);
        if (!gate.passed) {
          console.warn(
            `[implement] event=post_merge_gate_failed block_id=${block.block_id} surface_files=${(block.touched_files ?? []).join(",")} test_output_tail=${gate.testOutput.slice(-200)}`,
          );
          await attributePostMergeFailure(
            options,
            state,
            store,
            successfullyMergedBlocks,
            mergedCommits,
            block,
            gate.testOutput,
          );
        }
      } else if (!merged) {
        sequentialFallbackQueue.push(block);
      }
    }
  } else {
    sequentialFallbackQueue.push(...parallelBlocks);
  }

  // Sort fallback queue: blocks that lost parallel_safe (due to public_contract
  // inference) run first so their sequential execution resolves implicit dependencies
  // before lower-risk blocks.
  sequentialFallbackQueue.sort((a, b) => {
    const aHighRisk = !a.parallel_safe ? 0 : 1;
    const bHighRisk = !b.parallel_safe ? 0 : 1;
    return aHighRisk - bHighRisk;
  });

  for (const block of worktreeFailedBlocks) {
    await executeBlock(block, options.root, blockDeps);
  }
  for (const block of sequentialBlocks) {
    await executeBlock(block, options.root, blockDeps);
  }
  for (const block of sequentialFallbackQueue) {
    await executeBlock(block, options.root, blockDeps);
  }

  return { ...state, status: "implementing" };
}
