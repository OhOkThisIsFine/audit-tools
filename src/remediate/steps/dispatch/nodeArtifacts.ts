/**
 * The ONE owner of every per-node artifact path in a remediation run dir.
 *
 * Before this module the six filenames below were built by interpolating
 * `block_id` into a template in TEN places across five modules, with THREE
 * independent writer/reader rebuild pairs — the dispatcher wrote
 * `<id>.task.json` and the merge's diagnosis independently rebuilt it, the plan
 * builder and triage's guard independently rebuilt `implement-<id>.result.json`,
 * and triage's stale-archival rebuilt it a third time while also re-hardcoding
 * the `runs/<id>/implement` segments. Each pair could drift, and a drift is
 * silent-but-wrong rather than loud: a reader that misses the file reports "the
 * block was NEVER dispatched — a rolling-engine plan/drive inconsistency", which
 * blames the engine for a naming bug, and a stale result that fails to be
 * archived is read as current.
 *
 * `block_id` is `z.string()` with no charset constraint, minted by
 * `toBlockId(ensureNodeId(node.id, i))` over a DAG parsed from an LLM envelope
 * via an unchecked cast — so it is model-authored and NOT filename-safe. Every
 * name here therefore goes through `artifactNameForId` (stem + digest), the same
 * sanitizer the audit-side twin (`rollingAuditDispatch.ts`) already uses.
 *
 * Because writer and reader now derive every name from this module, sanitizing
 * is a single change that cannot desynchronize them.
 */

import { join } from "node:path";
import { artifactNameForId, dispatchSidecarNames } from "audit-tools/shared";
import { runDir } from "./common.js";

/** The phase whose run dir holds every per-node artifact. */
const IMPLEMENT_PHASE = "implement";

/** Absolute path to the run dir that holds a run's per-node artifacts. */
function nodeArtifactsDir(artifactsDir: string, runId: string): string {
  return runDir(artifactsDir, runId, IMPLEMENT_PHASE);
}

/**
 * The task id for a node's implement work. Kept here with the names it feeds so
 * the `implement-` prefix and the filenames derived from it cannot drift apart.
 */
export function implementTaskId(blockId: string): string {
  return `implement-${blockId}`;
}

/**
 * The six per-node artifact names, all derived from one sanitized id.
 *
 * `dir` is the run dir (`nodeArtifactsDir`). Callers that already hold the dir
 * pass it directly; callers that hold `(artifactsDir, runId)` should go through
 * {@link nodeArtifactPathsFor}.
 */
function nodeArtifactNames(blockId: string): {
  result: string;
  prompt: string;
  task: string;
  stdout: string;
  stderr: string;
  acceptOutcome: string;
} {
  const taskId = implementTaskId(blockId);
  // The three launch sidecars are named by the SHARED prep head — audit's draw
  // names its own identically — so remediate carries no second implementation.
  const sidecars = dispatchSidecarNames(blockId);
  return {
    // Result and prompt are keyed on the TASK id, the sidecars on the block id —
    // preserved from the pre-extraction layout so the two families stay visually
    // distinct in a run dir. Both are sanitized, which is the property that matters.
    result: artifactNameForId(taskId, "result.json"),
    prompt: artifactNameForId(taskId, "md"),
    task: sidecars.task,
    stdout: sidecars.stdout,
    stderr: sidecars.stderr,
    acceptOutcome: artifactNameForId(`accept-outcome-${blockId}`, "json"),
  };
}

/** The six per-node artifact paths inside an already-resolved run `dir`. */
export function nodeArtifactPathsIn(
  dir: string,
  blockId: string,
): {
  resultPath: string;
  promptPath: string;
  taskPath: string;
  stdoutPath: string;
  stderrPath: string;
  acceptOutcomePath: string;
} {
  const names = nodeArtifactNames(blockId);
  return {
    resultPath: join(dir, names.result),
    promptPath: join(dir, names.prompt),
    taskPath: join(dir, names.task),
    stdoutPath: join(dir, names.stdout),
    stderrPath: join(dir, names.stderr),
    acceptOutcomePath: join(dir, names.acceptOutcome),
  };
}

/** The six per-node artifact paths for a run, resolving the run dir itself. */
export function nodeArtifactPathsFor(
  artifactsDir: string,
  runId: string,
  blockId: string,
): ReturnType<typeof nodeArtifactPathsIn> {
  return nodeArtifactPathsIn(nodeArtifactsDir(artifactsDir, runId), blockId);
}
