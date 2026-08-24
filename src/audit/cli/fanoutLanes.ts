import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { laneAssetsDir } from "audit-tools/shared";

import {
  laneSubmissionPath,
  recordExpectedLanes,
  type LaneSubmissionShortfall,
} from "./laneSubmissions.js";

/**
 * Always-materialized fan-out lanes (design resolution 2, 2026-08-05).
 *
 * A fan-out step never inlines lane work into its step prompt and never
 * branches on host capability: every lane's prompt is a FILE on disk and every
 * lane's submission is a FILE on disk, identical across IDEs/providers, so a run
 * is resumable and parallelizable regardless of who executes the lanes. Lane
 * prompt files are ADVANCE-FREE — the continue-command lives in the step
 * prompt, never inside a lane file, so no lane executor can become a second
 * orchestrator driver (the same property `prepareContractDispatch` pins for
 * design review).
 *
 * This is also the MINTING CHOKEPOINT: a lane declares an id and a prompt, and
 * the tool derives where the answer goes. A lane spec cannot name its own
 * result file, so a host-typed filename is not expressible here or in any
 * caller.
 *
 * K-of-N resume: a lane whose submission already exists at its bound path is
 * complete — its prompt is not rewritten and it is excluded from the pending
 * set, so a re-emitted step instructs only the missing lanes and never
 * regenerates or overwrites completed lane results.
 */
export interface FanoutLaneSpec {
  /**
   * Stable lane id — the `artifact_paths` key prefix AND the identity the
   * lane's submission path is derived from, so it must be unique across the
   * whole audit and stable across re-emissions of the same lane.
   */
  id: string;
  /** Human label rendered into the step's lane list. */
  label: string;
  /** Lane prompt filename under the tool-owned lane-asset dir. */
  promptFilename: string;
  /** Advance-free lane prompt body (no continue-command). */
  promptText: string;
  /**
   * False for a lane whose submission the TOOL never reads — a host-side
   * intermediate another lane consumes (the conceptual perspectives, which
   * only the judge reads). Its bound path is still minted, declared, and
   * rendered so the worker has a tool-named place to write; but nothing is
   * ever owed to the tool, so it is not an expected submission, appears in no
   * expected set, and produces no ledger expectation the run can never
   * satisfy. Defaults to true — a lane owes the tool a submission unless it
   * says otherwise.
   */
  expected?: boolean;
}

export interface MaterializedFanoutLane {
  id: string;
  label: string;
  promptPath: string;
  /** Tool-computed bound path this lane's submission must land at. */
  resultPath: string;
  /** True when the lane's submission already exists (K-of-N resume). */
  resultExists: boolean;
}

export interface MaterializedFanout {
  lanes: MaterializedFanoutLane[];
  /** Lanes still owed a submission — the only lanes the step instructs. */
  pendingLanes: MaterializedFanoutLane[];
  /** `<id>_prompt` / `<id>_results` entries for the step contract. */
  artifactPaths: Record<string, string>;
  /** Pending lanes' prompt paths (step `access.read_paths`). */
  readPaths: string[];
  /** Pending lanes' bound submission paths (step `access.write_paths`). */
  writePaths: string[];
  /**
   * What a PREVIOUS emission of these lanes is still owed — empty on a first
   * emission. Rendered into the re-emitted step prompt and persisted on the
   * step contract so a dropped lane is reported by name instead of showing up
   * as the same step arriving twice.
   */
  shortfall: LaneSubmissionShortfall;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Heading of the one results-path section any lane prompt carries. */
export const LANE_RESULTS_HEADING = "## Results path";

/**
 * The alternative that makes the write imperative SATISFIABLE by any executor.
 *
 * The write instruction itself is not negotiable — the bound path is what the
 * tool's submission reader consumes, so a lane that quietly answers somewhere
 * else has not answered. But a lane may be executed by a worker with no file
 * write at all, and ordering it to write a file it cannot write leaves it no
 * sanctioned way to deliver its answer: it improvises, and the run reports a
 * lane that "submitted nothing". Stating the fallback keeps the bound path the
 * destination while making the delivery reachable from every lane class.
 */
export const LANE_RESULT_FALLBACK_SENTENCE =
  "If this lane cannot write files, return the complete JSON object as your final " +
  "message instead — the dispatching agent must then write it, verbatim, to that exact path.";

/**
 * The results-path section every materialized lane prompt ends with.
 *
 * Minted HERE, at the same chokepoint that derives the bound path, for the same
 * reason the path is: a per-emitter copy is a second place the path, the write
 * instruction, and the fallback can drift apart — and the conceptual lanes had
 * already drifted, telling their worker the path was "provided below" when
 * nothing was appended below at all.
 */
export function renderLaneResultsFooter(resultPath: string): string {
  return [
    LANE_RESULTS_HEADING,
    "",
    "Write your submission (a single JSON object) to:",
    "",
    `  ${resultPath}`,
    "",
    LANE_RESULT_FALLBACK_SENTENCE,
    "",
  ].join("\n");
}

/** A lane's prompt body with its bound results-path section appended. */
function footedPromptText(promptText: string, resultPath: string): string {
  return `${promptText.replace(/\s+$/, "")}\n\n${renderLaneResultsFooter(resultPath)}`;
}

/**
 * Write the pending lanes' prompt files, record what the emission owes, and
 * describe the whole fan-out.
 */
export async function materializeFanoutLanes(params: {
  artifactsDir: string;
  /**
   * The scope the lane submissions belong to. Audit gate emitters pass
   * `AUDIT_GATE_SUBMISSION_SCOPE` — see `laneSubmissions.ts` for why the gates
   * have no run id of their own.
   */
  runId: string;
  lanes: FanoutLaneSpec[];
}): Promise<MaterializedFanout> {
  const promptDir = laneAssetsDir(params.artifactsDir);
  await mkdir(promptDir, { recursive: true });

  const lanes: MaterializedFanoutLane[] = [];
  /** The text actually written per lane — footed, so the record matches the file. */
  const writtenText = new Map<string, string>();
  for (const spec of params.lanes) {
    const promptPath = join(promptDir, spec.promptFilename);
    const resultPath = laneSubmissionPath(
      params.artifactsDir,
      spec.id,
      params.runId,
    );
    const resultExists = await fileExists(resultPath);
    const promptText = footedPromptText(spec.promptText, resultPath);
    writtenText.set(spec.id, promptText);
    // Pending lanes always get a fresh prompt. A COMPLETED lane's prompt is
    // left untouched (its content matches the result that was produced) —
    // unless the file is missing, in which case it is re-materialized so
    // `artifact_paths` never names a path that does not exist on disk.
    if (!resultExists || !(await fileExists(promptPath))) {
      await writeFile(promptPath, promptText, "utf8");
    }
    lanes.push({
      id: spec.id,
      label: spec.label,
      promptPath,
      resultPath,
      resultExists,
    });
  }

  const shortfall = await recordExpectedLanes(
    params.artifactsDir,
    params.runId,
    // Un-expected lanes are filtered HERE, at this draw's one materializing
    // boundary; `buildExpectedSubmissionSet` REFUSES an `expected: false`
    // lane outright, so a future caller that routes one past this filter
    // throws instead of minting an expectation nothing can ever satisfy.
    params.lanes
      .filter((spec) => spec.expected !== false)
      .map((spec) => ({ lane: spec.id, promptText: writtenText.get(spec.id)! })),
  );

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
    shortfall,
  };
}
