import { RemediationState, StateStore } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { VerificationResult, RemediationBlock } from "../state/types.js";
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
    console.error(
      `Step ${stepName} failed for ${findingId}: ${err}\n  stdout: ${stdoutPath}\n  stderr: ${stderrPath}`,
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
        "pending",
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

    console.log(`Implementing item ${findingId}...`);

    // --- Write Tests step ---
    const skipTests = itemSpec.not_applicable_steps.find(
      (s) => s.step === "Write Tests",
    );
    if (!skipTests && item.status === "documented") {
      const prompt = `Write tests for the following finding:\nID: ${findingId}\nSpec: ${JSON.stringify(itemSpec, null, 2)}`;
      const stepSuccess = await runStepWithProvider(
        provider,
        { ...options, root: blockRoot },
        state.plan!.plan_id,
        findingId,
        "Write Tests",
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
        item.last_successful_step = "Write Tests";
        await store.saveState(state);
      } else {
        item.status = "blocked";
        item.failure_reason = "Write Tests failed";
        await store.saveState(state);
        continue;
      }
    } else if (item.status === "documented") {
      item.status = "tested";
      item.last_successful_step = "Write Tests";
      await store.saveState(state);
    }

    // --- Refactor Code step ---
    const skipRefactor = itemSpec.not_applicable_steps.find(
      (s) => s.step === "Refactor Code",
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
        item.last_successful_step = "Refactor Code";
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
      item.last_successful_step = "Refactor Code";
      await store.saveState(state);
    }

    // --- Verify step ---
    const skipVerify = itemSpec.not_applicable_steps.find(
      (s) => s.step === "Verify Code Against Documentation",
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
      const prompt = `Verify the code against the documentation for finding:\nID: ${findingId}\nSpec: ${JSON.stringify(itemSpec, null, 2)}\n\nWrite a VerificationResult JSON with shape: { "passed": boolean, "notes": string }`;
      let verifySuccess = await runStepWithProvider(
        provider,
        { ...options, root: blockRoot },
        state.plan!.plan_id,
        findingId,
        "Verify Code Against Documentation",
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
            `Failed to read verification result for ${findingId}:`,
            e,
          );
          verifySuccess = false;
        }
      }

      if (verifySuccess) {
        item.status = "resolved";
        item.last_successful_step = "Verify Code Against Documentation";
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
      item.last_successful_step = "Verify Code Against Documentation";
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
      `Failed to create worktree for block ${block.block_id} — will run sequentially. ` +
        `${describeGitFailure(worktreeRes)}`,
    );
    return { ok: false };
  }

  const blockState = cloneStateForBlock(deps.state);
  await executeBlock(block, blockRoot, {
    ...deps,
    state: blockState,
    store: { saveState: async () => undefined },
  });

  runCommand("git", ["add", "."], { cwd: blockRoot });
  // `git diff --cached --quiet` exits 0 when nothing is staged and 1 when there
  // are staged changes. Only commit when there is something to commit; that way
  // a non-zero commit status is a genuine failure (e.g. a commit hook) rather
  // than the benign "nothing to commit" case for a block that made no edits.
  const hasStagedChanges = runCommand("git", ["diff", "--cached", "--quiet"], {
    cwd: blockRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
        `Failed to commit block ${block.block_id} in worktree — will run sequentially. ` +
          `${describeGitFailure(commitRes)}`,
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
  }
  return { ok: true, state: blockState };
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
      `Failed to rebase worktree block ${block.block_id}: ${describeGitFailure(rebaseRes)}`,
    );
  }

  if (!rebaseAndTestSuccess && rebaseRes.status !== 0) {
    runCommand("git", ["rebase", "--abort"], { cwd: blockRoot });
  }

  if (rebaseAndTestSuccess) {
    runCommand("git", ["merge", blockBranch], { cwd: options.root });
  } else {
    console.log(
      `Block ${block.block_id} failed rebase or test, falling back to sequential execution.`,
    );
  }

  runCommand("git", ["worktree", "remove", blockRoot, "--force"], {
    cwd: options.root,
  });
  runCommand("git", ["branch", "-D", blockBranch], { cwd: options.root });

  return rebaseAndTestSuccess;
}

export async function runImplementPhase(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<RemediationState> {
  console.log("Running Implement Phase...");

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
