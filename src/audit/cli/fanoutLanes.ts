import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Always-materialized fan-out lanes (design resolution 2, 2026-08-05).
 *
 * A fan-out step never inlines lane work into its step prompt and never
 * branches on host capability: every lane's prompt is a FILE on disk and every
 * lane's result is a FILE on disk, identical across IDEs/providers, so a run is
 * resumable and parallelizable regardless of who executes the lanes. Lane
 * prompt files are ADVANCE-FREE — the continue-command lives in the step
 * prompt, never inside a lane file, so no lane executor can become a second
 * orchestrator driver (the same property `prepareContractDispatch` pins for
 * design review).
 *
 * K-of-N resume: a lane whose RESULT file already exists under `incoming/` is
 * complete — its prompt is not rewritten and it is excluded from the pending
 * set, so a re-emitted step instructs only the missing lanes and never
 * regenerates or overwrites completed lane results.
 */
export interface FanoutLaneSpec {
  /** Stable lane id — becomes the `artifact_paths` key prefix. */
  id: string;
  /** Human label rendered into the step's lane list. */
  label: string;
  /** Lane prompt filename under `incoming/`. */
  promptFilename: string;
  /** Lane result filename under `incoming/`. */
  resultFilename: string;
  /** Advance-free lane prompt body (no continue-command). */
  promptText: string;
}

export interface MaterializedFanoutLane {
  id: string;
  label: string;
  promptPath: string;
  resultPath: string;
  /** True when the lane's result file already exists (K-of-N resume). */
  resultExists: boolean;
}

export interface MaterializedFanout {
  lanes: MaterializedFanoutLane[];
  /** Lanes still owed a result — the only lanes the step instructs. */
  pendingLanes: MaterializedFanoutLane[];
  /** `<id>_prompt` / `<id>_results` entries for the step contract. */
  artifactPaths: Record<string, string>;
  /** Pending lanes' prompt paths (step `access.read_paths`). */
  readPaths: string[];
  /** Pending lanes' result paths (step `access.write_paths`). */
  writePaths: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Write the pending lanes' prompt files and describe the whole fan-out. */
export async function materializeFanoutLanes(params: {
  artifactsDir: string;
  lanes: FanoutLaneSpec[];
}): Promise<MaterializedFanout> {
  const incoming = join(params.artifactsDir, "incoming");
  await mkdir(incoming, { recursive: true });

  const lanes: MaterializedFanoutLane[] = [];
  for (const spec of params.lanes) {
    const promptPath = join(incoming, spec.promptFilename);
    const resultPath = join(incoming, spec.resultFilename);
    const resultExists = await fileExists(resultPath);
    // Pending lanes always get a fresh prompt. A COMPLETED lane's prompt is
    // left untouched (its content matches the result that was produced) —
    // unless the file is missing, in which case it is re-materialized so
    // `artifact_paths` never names a path that does not exist on disk.
    if (!resultExists || !(await fileExists(promptPath))) {
      await writeFile(promptPath, spec.promptText, "utf8");
    }
    lanes.push({
      id: spec.id,
      label: spec.label,
      promptPath,
      resultPath,
      resultExists,
    });
  }

  const pendingLanes = lanes.filter((lane) => !lane.resultExists);
  const artifactPaths: Record<string, string> = {};
  for (const lane of lanes) {
    artifactPaths[`${lane.id}_prompt`] = lane.promptPath;
    artifactPaths[`${lane.id}_results`] = lane.resultPath;
  }
  return {
    lanes,
    pendingLanes,
    artifactPaths,
    readPaths: pendingLanes.map((lane) => lane.promptPath),
    writePaths: pendingLanes.map((lane) => lane.resultPath),
  };
}
