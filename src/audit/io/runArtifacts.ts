import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hashContent, stableStringify, writeJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import {
  CURRENT_TASK_FILENAME,
  CURRENT_TASKS_FILENAME,
} from "../supervisor/operatorHandoff.js";
import { canonicalizeAuditTasks } from "../../shared/affinityArtifacts.js";
import type { RunPaths } from "./runArtifactTypes.js";

export type { RunPaths } from "./runArtifactTypes.js";

/**
 * The readable half of a derived run id, CAPPED.
 *
 * The shared run-id grammar (`assertSubmissionRunId`) admits at most 128
 * characters, and the slug is the one unbounded part of the derivation — a
 * pathological obligation id would otherwise mint an id the shared boundary
 * refuses, so the tool would publish a run whose own paths throw. The cap is
 * applied BEFORE the trailing-dash trim: truncation can expose a dash the
 * `.replace` above already removed, and an id ending in `-` is a boundary case
 * the grammar tolerates but no reader should have to.
 */
export const RUN_ID_SLUG_MAX_LENGTH = 48;

/**
 * The digest half's character count, EXPORTED because it is half of a contract
 * the shared run-id grammar enforces and the two must not drift: the grammar
 * admits at most 128 characters, and a derived id is `review-` + slug + `-` +
 * this many hex characters. `tests/shared/host-handoff-core.test.ts` derives the
 * worst case from these constants and pushes it through the shared boundary, so
 * raising either one past the cap reds that test rather than minting a run whose
 * own paths throw.
 */
export const RUN_ID_DIGEST_LENGTH = 16;

/** The fixed `review-` prefix of every derived review run id. */
export const RUN_ID_PREFIX = "review-";

function normalizeRunIdSegment(value: string | null): string {
  const normalized = (value ?? "terminal")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, RUN_ID_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : "terminal";
}

/**
 * The review run id, DERIVED from the review obligation and the open WAVE —
 * never from a clock.
 *
 * A run id is the run DIRECTORY, and everything a host binds through hangs off
 * it: the workload, the result map, the task bindings, the accepted pair, and
 * every bound `result_path` (which the prompt embeds, so the prompt digest moves
 * with it). A clock-minted id therefore re-minted the whole published wave on
 * every pause — a partial ingest changed `result_path` and `prompt_sha256` for
 * 494/494 carried-over items (measured 2026-08-21), orphaning every worker still
 * writing against a binding it already held.
 *
 * The derivation is the SHARED identity idiom (`mintSubmissionId`): a readable
 * slug carries no identity — the slug is lossy and capped — so a digest carries
 * it, and `waveGeneration` is what the digest is a function of. The generation
 * is the tool's own durable record of which wave is OPEN (`openReviewWavePath`,
 * written by `src/audit/cli/reviewRun.ts`), so the identity moves exactly ONCE
 * per wave and never while a wave has work outstanding. Two waves of one
 * artifacts dir therefore never share a directory, and neither do two audits of
 * one repo: the second audit opens a generation the first never had (a stale
 * accepted pair at a re-used directory would withhold the new audit's work, and
 * `loadAcceptedResults` refuses a ledger written for another run).
 */
/**
 * FROZEN MIGRATION READER — the retired clock-minted run id.
 *
 * `buildRunId` mints `<UTC timestamp>_<obligation>_<3-digit index>` and is
 * deleted with this change, so this pattern describes an artefact of the past
 * that can no longer change; it has nothing to drift FROM. It exists only so a
 * run an earlier build published can be recognized as one and ADOPTED rather
 * than abandoned mid-wave (see `resolveReviewRun`). Never used to mint.
 */
const LEGACY_CLOCK_RUN_ID = /^\d{8}T\d{9}Z_[A-Za-z0-9_-]+_\d{3,}$/u;

export function isLegacyClockRunId(runId: string): boolean {
  return LEGACY_CLOCK_RUN_ID.test(runId);
}

/**
 * The DURABLE wave counter — the persisted generation, and the one identity
 * input the TOOL writes in production.
 *
 * It lives under `runs/` — the directory whose entries it counts — so the two
 * are removed together, and an absent file means no wave has been opened yet:
 * the generation then comes from the directory state alone
 * (`resolveWaveGeneration`, `src/audit/cli/reviewRun.ts`). It names a GENERATION,
 * not a count of runs, so a wave that is still owed work keeps its generation
 * however many times it republishes, and the next wave — opened once the
 * previous one's pending set is fully accepted — takes the next one.
 */
export const OPEN_REVIEW_WAVE_FILENAME = "open-review-wave.json";

export function openReviewWavePath(artifactsDir: string): string {
  return join(artifactsDir, "runs", OPEN_REVIEW_WAVE_FILENAME);
}

/**
 * The run's own statement that its wave has drained.
 *
 * A wave is CLOSED when every work item it published has been accepted, and the
 * only party that can say so is the run: `resolveReviewRun` sees the pending set
 * shrink, but a shrinking pending set is also what a partial ingest looks like,
 * so it cannot tell "one lane returned" from "the wave is done". The marker is
 * written at the boundary that CAN tell — the handoff publish, which holds the
 * run's own still-owed partition in its hand — and carries the run's identity,
 * because a run directory is a statement about one run and nothing else.
 *
 * It lives INSIDE the run directory, so it is removed exactly when the run it
 * describes is, and it can never be read as a statement about a different run.
 */
export const REVIEW_WAVE_CLOSED_FILENAME = "wave-closed.json";

export function reviewWaveClosedPath(artifactsDir: string, runId: string): string {
  return join(getRunPaths(artifactsDir, runId).runDir, REVIEW_WAVE_CLOSED_FILENAME);
}

/**
 * The WAVE's own identity — the digest half of every review run id, and the
 * generation's whole fingerprint. It is deliberately a function of the
 * generation ALONE, not of the obligation: two obligations paused in one wave
 * derive two run ids that share this digest, which is what lets the wave's run
 * directory be found from the counter without knowing which obligation opened
 * it (`openedRunIdForGeneration`, `src/audit/cli/reviewRun.ts`). Salting the
 * obligation into the digest as well would make the wave question unanswerable
 * from the counter — the same fact, stated twice and separately unrecoverable.
 */
export function reviewWaveDigest(waveGeneration: number | null): string {
  return hashContent(
    stableStringify({ wave_generation: waveGeneration }),
    { length: RUN_ID_DIGEST_LENGTH },
  );
}

export function deriveReviewRunId(params: {
  readonly obligationId: string | null;
  /**
   * How many review runs this artifacts dir has ALREADY OPENED — the persisted
   * wave generation, or `null` before the first one. Read from a file the TOOL
   * writes (`openReviewWavePath`), never from the run ledger and never from
   * anything a host supplies.
   */
  readonly waveGeneration: number | null;
}): string {
  return `${RUN_ID_PREFIX}${normalizeRunIdSegment(params.obligationId)}-${reviewWaveDigest(
    params.waveGeneration,
  )}`;
}

export function getRunPaths(artifactsDir: string, runId: string): RunPaths {
  const runDir = join(artifactsDir, "runs", runId);
  return {
    runDir,
    reviewRunPath: join(runDir, "review-run.json"),
    pendingTasksPath: join(runDir, "pending-audit-tasks.json"),
    hostWorkloadPath: join(runDir, "host-workload.json"),
    hostResultMapPath: join(runDir, "host-result-map.json"),
  };
}

export async function ensureSupervisorDirs(artifactsDir: string): Promise<void> {
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await mkdir(join(artifactsDir, "runs"), { recursive: true });
}

/** Persist only review identity + pending work; the host owns all execution. */
export async function writeReviewRunFiles(
  artifactsDir: string,
  run: ActiveReviewRun,
  pendingTasks: readonly AuditTask[],
): Promise<void> {
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await mkdir(join(artifactsDir, "runs", run.run_id), { recursive: true });
  const canonicalTasks = canonicalizeAuditTasks([...pendingTasks]);
  await writeJsonFile(run.review_run_path, run);
  await writeJsonFile(run.pending_audit_tasks_path, canonicalTasks);
  await writeJsonFile(
    join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME),
    run,
  );
  await writeJsonFile(
    join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME),
    canonicalTasks,
  );
}
