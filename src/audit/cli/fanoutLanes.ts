import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { auditLaneReviewRequirement } from "./reviewSubmission.js";
import { bindWorkerPrompt } from "../../shared/submission/workerPromptBinding.js";
import { hashContent } from "../../shared/hash.js";
// sites-pinned: tests/shared/prompt-capability.test.ts, tests/audit/synthesis-narrative-prompt.test.ts
//
// This module is the SECOND prompt-writing boundary in the tool (writeStepContract
// is the first): every lane prompt file on disk is written here, so the path form
// a lane reader sees is decided here.

import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeTextFile } from "../../shared/io/json.js";
import { publishAuditReviewBindings, type AuditReviewBinding } from "./auditReviewBindings.js";

import {
  deriveLaneDemand,
  estimateTokensFromBytes,
  laneAssetsDir,
  toPromptPathToken,
  type LaneDemand,
} from "audit-tools/shared";
import { normalizePromptBodyPaths } from "../../shared/tooling/exec.js";

import {
  laneSubmissionPath,
  laneSubmissionId,
  recordDispatchedLanes,
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
  /** Explicit scope and risk inputs; callers cannot silently default unknown work to small/low. */
  fileCount: number;
  riskScore: number;
  /** Complete artifact/packet files read in addition to the prompt. */
  contextPaths?: readonly string[];
  semanticComplexity?: LaneDemand["complexity"];
  /** Complete current input identity, independently checked against the carried bundle at acceptance. */
  semanticInputRevision?: string;
}

export interface MaterializedFanoutLane {
  id: string;
  label: string;
  promptPath: string;
  /** Tool-computed bound path this lane's submission must land at. */
  resultPath: string;
  /** True when the lane's submission already exists (K-of-N resume). */
  resultExists: boolean;
  /**
   * The lane's demand ranking (size / complexity / risk), DERIVED here rather
   * than declared by the caller — every fan-out lane in the package is
   * materialized through this one function, so a lane without a demand is not
   * expressible. Same vocabulary and same shape as the work items both
   * orchestrators publish, so a host matching a model to work reads one
   * ranking whether the work arrives as a review task or a fan-out lane.
   */
  demand: LaneDemand;
  reviewRequirement: ReturnType<typeof auditLaneReviewRequirement>;
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
    `  ${toPromptPathToken(resultPath)}`,
    "",
    LANE_RESULT_FALLBACK_SENTENCE,
    "",
  ].join("\n");
}

/**
 * A lane's prompt body with its bound results-path section appended, with every
 * absolute path in the result forward-slashed.
 *
 * A lane prompt is a SECOND prompt-writing boundary beside `writeStepContract`,
 * which normalizes the same way (owner review 2026-09-17, prompt 13: "fix the
 * class now"). Without this, one run hands its reader `C:\...\workload.json` in
 * the lane file and `C:/.../workload.json` in the step contract's path field for
 * the same file. `normalizePromptBodyPaths` is anchored on a drive letter or a
 * UNC root, so a regex or an escape sequence inside a prompt body is untouched.
 */
function footedPromptText(promptText: string, resultPath: string): string {
  return normalizePromptBodyPaths(
    `${promptText.replace(/\s+$/, "")}\n\n${renderLaneResultsFooter(resultPath)}`,
  );
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
  /**
   * The ROUND these lanes belong to, when the caller has one (the deep
   * conceptual pass's content-derived round token). Recorded on each dispatch
   * row so a delivery rate is reported per round and a superseded round's lanes
   * never drag the current round's rate down.
   */
  roundId?: string;
  lanes: FanoutLaneSpec[];
}): Promise<MaterializedFanout> {
  const promptDir = laneAssetsDir(params.artifactsDir);
  await mkdir(promptDir, { recursive: true });

  const lanes: MaterializedFanoutLane[] = [];
  /** The text actually written per lane — footed, so the record matches the file. */
  const writtenText = new Map<string, string>();
  const reviewBindings = new Map<string, { promptSha256: string; reviewRequirement: string; promptPath: string }>();
  const activeBindings = new Map<string, AuditReviewBinding>();
  for (const spec of params.lanes) {
    const resultPath = laneSubmissionPath(
      params.artifactsDir,
      spec.id,
      params.runId,
    );
    const resultExists = await fileExists(resultPath);
    const requirement = auditLaneReviewRequirement(spec.id);
    const contextInputs = await Promise.all([...new Set(spec.contextPaths ?? [])].sort().map(async path => {
      const bytes = await readFile(path);
      return { path, sha256: hashContent(bytes), bytes: bytes.length };
    }));
    const inputBindingText = requirement === "ordinary" || contextInputs.length === 0 ? "" : `\n\n## Bound input fingerprints\n${contextInputs.map(input => `${input.path}: ${input.sha256}`).join("\n")}`;
    const revisionText = spec.semanticInputRevision === undefined ? "" : `\n\nReview input revision: ${spec.semanticInputRevision}`;
    const body = footedPromptText(spec.promptText + revisionText + inputBindingText, resultPath) + (requirement === "ordinary" ? "" : "\nRequired independent review: use a context that did not author the work. If unavailable, return an unavailable declaration; never substitute self-review.");
    const bound = requirement === "ordinary" ? { text: body, sha256: hashContent(body) } : bindWorkerPrompt(body, digest => [
      "## Bound review submission",
      "Place the domain result described above inside `result` in this envelope. Copy the prompt binding exactly. The review declaration reports the host's execution context; it is not proof of identity.",
      "```json",
      JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: digest, review: { mode: "independent", reason: "Explain how this context was independent of the author." }, result: {} }, null, 2),
      "```",
      "Review modes are independent, degraded, unavailable. This lane requires independent; degraded or unavailable cannot satisfy it.",
    ].join("\n"));
    const promptText = bound.text;
    const promptPath = requirement === "ordinary" ? join(promptDir, spec.promptFilename) : join(promptDir, "prompts", bound.sha256, spec.promptFilename);
    if (requirement !== "ordinary") activeBindings.set(spec.id, { requirement, ...(spec.semanticInputRevision === undefined ? {} : { semanticInputRevision: spec.semanticInputRevision }), promptSha256: bound.sha256, promptContentSha256: hashContent(promptText), promptPath, runId: params.runId, submissionId: laneSubmissionId(spec.id, params.runId), inputs: contextInputs.map(({ path, sha256 }) => ({ path, sha256 })) });
    writtenText.set(spec.id, body);
    reviewBindings.set(spec.id, { promptSha256: bound.sha256, reviewRequirement: requirement, promptPath });
    // Required review assets are content-addressed and repaired to their exact
    // canonical bytes before publication, even when a response already exists.
    // Ordinary completed lanes retain the legacy K-of-N prompt reuse rule.
    if (requirement !== "ordinary" || !resultExists || !(await fileExists(promptPath))) {
      await writeTextFile(promptPath, promptText);
    }
    const contextBytes = contextInputs.reduce((sum, input) => sum + input.bytes, 0);
    lanes.push({
      id: spec.id,
      label: spec.label,
      promptPath,
      resultPath,
      resultExists,
      reviewRequirement: requirement,
      // Derived from the prompt text the tool just wrote — the lane's own
      // bytes, not the caller's claim about them — plus whatever per-mode
      // signal the caller had. See {@link FanoutLaneSpec}.
      demand: deriveLaneDemand({
        tokenEstimate: estimateTokensFromBytes(Buffer.byteLength(promptText, "utf8") + contextBytes),
        fileCount: spec.fileCount,
        riskScore: spec.riskScore,
        minimumComplexity: spec.semanticComplexity,
      }),
    });
  }

  // Every lane the caller declared, EXPECTED OR NOT, leaves a dispatch row —
  // written from `params.lanes` directly, on the other side of the
  // `expected !== false` filter below, which is untouched. The two records are
  // structurally disjoint: a dispatch row can never reach
  // `expected-submissions.json`, and shortfall is a diff over the expected SET
  // that never reads ledger events, so this cannot recreate the permanent false
  // shortfall P25 removed.
  // Bindings linearize under the same hold as production review acceptance and
  // fold commit. Immutable prompts are already complete; external input writes
  // are not serialized here and are checked by their content hashes at decode.
  if (activeBindings.size > 0) await withArtifactTreeHold(params.artifactsDir, undefined, () => publishAuditReviewBindings(params.artifactsDir, activeBindings));
  await recordDispatchedLanes(
    params.artifactsDir,
    params.runId,
    params.lanes.map((spec) => spec.id),
    params.roundId,
    reviewBindings,
  );

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
    readPaths: [...new Set([...pendingLanes.map((lane) => lane.promptPath), ...params.lanes.flatMap(spec => spec.contextPaths ?? [])])],
    writePaths: pendingLanes.map((lane) => lane.resultPath),
    shortfall,
  };
}
