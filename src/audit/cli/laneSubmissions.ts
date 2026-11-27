import { parseReviewSubmissionEnvelope, ReviewRequirementSchema } from "../../shared/types/reviewIndependence.js";
// sites-pinned: tests/audit/next-step-helpers.test.ts, tests/audit/charter-emit-order.test.ts, tests/audit/executor-registry-sync.test.ts, tests/audit/pipeline-integration.test.ts
/**
 * The audit draw of the shared submission core: how a GATE lane's bound path is
 * computed, and where the expected-set / ledger for those lanes are persisted.
 *
 * Two facts about the audit gates shape everything here:
 *
 * 1. **They carry no run id.** `NextStepParams` has none, and threading one
 *    into every gate would change ten signatures to carry a value the gates
 *    never use. Their submissions are therefore ARTIFACTS-DIR-scoped: the
 *    constant `AUDIT_GATE_SUBMISSION_SCOPE` stands in for run identity, so the
 *    same gate lane in the same artifacts dir denotes the same submission
 *    across `next-step` calls. That is not a shortcut — it is exactly the
 *    K-of-N resume property, which requires a re-emitted step to re-declare
 *    the identical bound path rather than mint a new one and re-ask for work
 *    the host already delivered.
 *
 * 2. **The lane id is the only join key.** The emitter and the gate reader
 *    never meet; they agree because both derive the id from the lane id
 *    through this module. A lane id is declared once in this module's
 *    `GATE_LANES` table and used verbatim on both sides.
 *
 * The bound path is DERIVED, not looked up. The persisted expected set states
 * what is owed (and feeds the diff and the ledger), but a gate that could only
 * read a submission when a bookkeeping file happened to exist would lose a
 * valid submission the first time that file was absent — so derivation is the
 * mechanism and the record is the record.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { SystemicChallengeRound } from "../types/systemicChallenge.js";

import {
  CharterKindSchema,
  absoluteSubmissionPath,
  buildExpectedSubmissionSet,
  createLockedJsonStore,
  diffExpectedSet,
  discardOnSchemaVersionMismatch,
  expectedSubmissionsPath,
  hashContent,
  isFileMissingError,
  isIngestEvent,
  isRecord,
  mergeExpectedSets,
  mintSubmissionId,
  outputDirFor,
  readSubmissionDocument,
  readSubmissionIngestHistory,
  readSubmissionLedger,
  readTrailingSubmissionRefusals,
  siblingLockPath,
  SKIP_WRITE,
  submissionsDir,
  withoutExpectedSubmissions,
  EXPECTED_SET_CONTRACT_VERSION,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  type CharterKind,
  type ExpectedSubmission,
  type ExpectedSubmissionSet,
  type MeasuredOutcome,
  type SubmissionIngestHistory,
  type SubmissionIssueCode,
  type SubmissionLedgerEvent,
  type SubmissionReadOutcome,
  type SubmissionRoots,
} from "audit-tools/shared";
/**
 * Gate lane ids — the single join key between an emitter and its gate reader.
 *
 * The two never meet: an emitter writes a lane's prompt and declares where the
 * answer goes, and (possibly several `next-step` calls later) the gate reader
 * looks for it. They agree because both derive the bound path from the lane id
 * through this module. Declared once, here, so no site can spell a lane one way
 * on the emit side and another on the read side.
 */
export const GATE_LANES = {
  analyzer_consent: "analyzer_consent",
  analyzer_selection: "analyzer_selection",
  analyzer_calibration: "analyzer_calibration",
  analyzer_decisions: "analyzer_decisions",
  edge_reasoning: "edge_reasoning",
  design_review_contract: "design_review_contract",
  design_review_conceptual: "design_review_conceptual",
  critical_flow_fallback: "critical_flow_fallback",
  intent_equivalence: "intent_equivalence",
  synthesis_narrative: "synthesis_narrative",
  charter_comparison: "charter_comparison",
  charter_fidelity: "charter_fidelity",
  charter_clarification: "charter_clarification",
  systemic_challenge: "systemic_challenge",
} as const;

const CHARTER_EXTRACTION_LANE_PREFIX = "charter_extraction_";

/** The blind per-kind charter lanes (one per estimator channel). */
export function charterExtractionLane(kind: CharterKind): string {
  return `${CHARTER_EXTRACTION_LANE_PREFIX}${kind}`;
}

/** Recover the charter kind a `charter_extraction_*` lane id denotes. */
export function charterKindForLane(lane: string): CharterKind | undefined {
  if (!lane.startsWith(CHARTER_EXTRACTION_LANE_PREFIX)) return undefined;
  const parsed = CharterKindSchema.safeParse(
    lane.slice(CHARTER_EXTRACTION_LANE_PREFIX.length),
  );
  return parsed.success ? parsed.data : undefined;
}

export const CONCEPTUAL_PERSPECTIVE_LANE_PREFIX = "design_review_conceptual_p";

/**
 * The deep conceptual pass's independent perspective lanes. Their COUNT is
 * resolved at emit from confirmed intent, so the ids are generated rather than
 * enumerated.
 *
 * The id carries the ROUND — a digest of the upstream content the round asks
 * about. Like the iterative systemic challenge, a perspective must preserve
 * identity within a round and change it after progress. A perspective is a
 * fresh independent reading of the artifacts as they now stand. Keyed on the
 * index alone, a re-review after staleness would find the PREVIOUS round's
 * submission at the bound path, skip the lane, leave its prompt unrewritten,
 * and hand the judge the old round's findings as if they were this round's.
 * Same round, same digest, same id — so resume WITHIN a round still works.
 */
export function conceptualPerspectiveLane(
  index: number,
  roundToken: string,
): string {
  return `${CONCEPTUAL_PERSPECTIVE_LANE_PREFIX}${index}_${roundToken}`;
}

/**
 * The round token every perspective lane in one deep conceptual emission
 * shares: a digest of exactly what this round asks. Deterministic in its inputs
 * — never a timestamp or a counter, which would mint new ids (and re-ask for
 * already-delivered work) on every re-emission of an unchanged round.
 */
export function conceptualRoundToken(inputs: readonly string[]): string {
  return hashContent(inputs.join("\n"), { length: 12 });
}

export const SYSTEMIC_CHALLENGE_LANE_PREFIX = `${GATE_LANES.systemic_challenge}_`;

/**
 * Completed rounds identify the next systemic challenge. Re-emission, rejection
 * and timestamp changes cannot mint fresh work; only an accepted round can.
 * Both the emitter and staged consumer derive this same lane. A crashed fold's
 * already-applied submission restores to its old lane, never the next round.
 */
export function systemicChallengeLane(rounds: readonly SystemicChallengeRound[]): string {
  const progress = rounds.map(({ round, new_finding_ids, dry }) => [round, new_finding_ids, dry]);
  return `${SYSTEMIC_CHALLENGE_LANE_PREFIX}${hashContent(JSON.stringify(progress), { length: 12 })}`;
}

/**
 * The per-kind evidence packet a charter lane reads. TOOL-written, so it lives
 * under the lane-asset dir with the lane prompts — a host only ever reads it.
 */
export function charterExtractionPacketFilename(kind: CharterKind): string {
  return `charter-extraction-${kind}-packet.md`;
}

/**
 * The packet's manifest, persisted beside it at EMIT so the INGEST pass — a
 * different invocation — can fold per-class coverage into the register and check
 * each citation against the line runs actually delivered. Tool-written, so it is
 * a lane asset and not a submission; consumed and deleted at ingest, by which
 * time its content lives in the register and inside the archived packet.
 */
export function charterExtractionCoverageFilename(kind: CharterKind): string {
  return `charter-extraction-${kind}-coverage.json`;
}

/**
 * The tool-side merge of the per-kind charter lanes, handed to the extraction
 * executor by path and deleted once ingested. Tool-written, so it is a lane
 * asset and not a submission.
 */
export const CHARTER_EXTRACTION_MERGED_FILENAME = "charter-extraction-merged.json";

/**
 * The submission FAMILY every audit gate lane belongs to. Distinguishes these
 * from the host-handoff work-item submissions, which mint through the same rule
 * under their own run id.
 */
export const AUDIT_LANE_SUBMISSION_KIND = "audit_host_lane";

/** See the module comment: the audit gates' stand-in for run identity. */
export const AUDIT_GATE_SUBMISSION_SCOPE = "audit-host-gates";

/**
 * Bound paths for gate lanes are expressed relative to the artifact tree root
 * (`.audit-tools/`), not the repository root: the gates are handed an artifacts
 * dir and nothing else, and a recorded path must be derivable from exactly what
 * the reader has.
 */
export function laneSubmissionRoots(artifactsDir: string): SubmissionRoots {
  return {
    root: outputDirFor(artifactsDir),
    submissionDir: submissionsDir(artifactsDir),
  };
}

/** The tool-minted id for one lane. Deterministic in the lane id alone. */
export function laneSubmissionId(
  lane: string,
  runId: string = AUDIT_GATE_SUBMISSION_SCOPE,
): string {
  return mintSubmissionId({ kind: AUDIT_LANE_SUBMISSION_KIND, lane, runId });
}

/**
 * Absolute on-disk path a lane's submission must land at.
 *
 * `runId` is threaded rather than defaulted-and-forgotten: the bound path and
 * the recorded expectation must come from ONE derivation. They were two — the
 * path taking the module constant while the record took the caller's scope —
 * which coincided only because every caller happened to pass the constant, i.e.
 * the invariant held by the caller remembering.
 */
export function laneSubmissionPath(
  artifactsDir: string,
  lane: string,
  runId: string = AUDIT_GATE_SUBMISSION_SCOPE,
): string {
  return absoluteSubmissionPath(
    laneSubmissionRoots(artifactsDir),
    laneSubmissionId(lane, runId),
  );
}

/**
 * The locked store over the expected-submission set (CP-NODE-6).
 *
 * The read side keeps CP-NODE-5's recorded DEGRADE-NOT-THROW design — a corrupt
 * set degrades to "nothing owed", never failing the emission it records — while
 * the WRITE side now runs through `createLockedJsonStore`, so two concurrent
 * emissions' read-merge-write cycles can no longer interleave their merges and
 * silently drop a lane declaration.
 */
const expectedSetStore = (artifactsDir: string) => {
  const path = expectedSubmissionsPath(artifactsDir);
  return createLockedJsonStore<ExpectedSubmissionSet | undefined>({
    path,
    lockPath: siblingLockPath(path),
    // CP-NODE-5's recorded degrade-not-throw design, now MECHANICAL in the
    // store rather than a try/catch this module had to remember: a corrupt set
    // degrades to absent, so `parse` sees `undefined` and the emission's
    // merge-from-nothing path is exactly its absent-file behavior.
    tolerateCorruptRead: true,
    parse: (raw) => {
      if (raw === undefined) return undefined;
      // A set left by another release is DISCARDED, not reinterpreted under
      // this release's field semantics (the regenerate-on-emit design). The
      // emission after an upgrade is then first-emission-silent: nothing was
      // carried that this release asked for, so no lane reads as dropped.
      return discardOnSchemaVersionMismatch(
        raw as ExpectedSubmissionSet,
        EXPECTED_SET_CONTRACT_VERSION,
      );
    },
  });
};

/** One lane an emission owes, as the emitter knows it. */
export interface DeclaredLane {
  readonly lane: string;
  readonly promptText: string;
}

/**
 * What a re-emission is still owed, stated by name.
 *
 * Persisted on the step contract and rendered into the step prompt, so "the
 * host dropped a lane" is a fact the run REPORTS rather than one an operator
 * has to infer from an identical step arriving twice.
 */
const OutstandingLaneSubmissionSchema = z
  .object({
    lane: z.string(),
    submission_id: z.string(),
    /**
     * The tool-computed bound path, ABSOLUTE — the same form (and the same
     * file) as the step's `access.write_paths` entry for this lane, so the two
     * compare directly. Deliberately NOT the expected set's recorded form:
     * that one is relative to the artifact tree root, a base the step contract
     * declares nowhere, so a consumer joining it against `repo_root` or
     * `artifacts_dir` would build a path that never existed. `extraFields` ride
     * through `writeStepContract` un-normalized (only prompt_path / repo_root /
     * artifacts_dir / artifact_paths are), exactly as `access` does.
     */
    submission_path: z.string(),
    issue_code: z.string(),
    message: z.string(),
  })
  .strict();

export const LaneSubmissionShortfallSchema = z
  .object({
    /** Lanes CARRIED into this emission (a prior emission already asked). */
    expected: z.number().int(),
    /** How many of those have a readable submission at their bound path. */
    accepted: z.number().int(),
    outstanding: z.array(OutstandingLaneSubmissionSchema),
  })
  .strict();

export type LaneSubmissionShortfall = z.infer<typeof LaneSubmissionShortfallSchema>;

const NO_SHORTFALL: LaneSubmissionShortfall = {
  expected: 0,
  accepted: 0,
  outstanding: [],
};

/** Read every carried member's bound path once, for the diff below. */
async function observeLanes(
  artifactsDir: string,
  entries: readonly ExpectedSubmission[],
): Promise<ReadonlyMap<string, SubmissionReadOutcome>> {
  const roots = laneSubmissionRoots(artifactsDir);
  return new Map(
    await Promise.all(
      entries.map(
        async (entry) =>
          [
            entry.submission_id,
            await readSubmissionDocument(
              absoluteSubmissionPath(roots, entry.submission_id),
            ),
          ] as const,
      ),
    ),
  );
}

/**
 * Record what this emission owes, and report what a PREVIOUS one is still owed.
 *
 * Merges into the current statement (a step that materializes several lane
 * groups accumulates them) and appends one `expected` event per NEWLY declared
 * lane, so a re-emission does not spam the arrival record.
 *
 * The returned shortfall diffs only the lanes CARRIED into this emission — the
 * ones an earlier emission already asked for and that are still not on disk.
 * Restricting it to carried lanes is what makes the report meaningful: on a
 * first emission every lane is legitimately absent (it is being asked for right
 * now), so counting those would make every fan-out look like a failure.
 */
export async function recordExpectedLanes(
  artifactsDir: string,
  runId: string,
  lanes: readonly DeclaredLane[],
): Promise<LaneSubmissionShortfall> {
  if (lanes.length === 0) return NO_SHORTFALL;
  const declared = buildExpectedSubmissionSet({
    runId,
    paths: laneSubmissionRoots(artifactsDir),
    lanes: lanes.map((lane) => ({
      lane: lane.lane,
      submissionId: laneSubmissionId(lane.lane, runId),
      promptSha256: hashContent(lane.promptText),
    })),
  });
  // Read-merge-write under ONE lock acquisition: two concurrent emissions
  // could previously interleave their merges, the later writer's snapshot
  // predating the earlier one's additions, and a lane declaration was silently
  // lost — exactly the bookkeeping the expected set exists to preserve.
  let addedIds: readonly string[] = [];
  const set = (await expectedSetStore(artifactsDir).mutate((current) => {
    const merged = mergeExpectedSets(current, declared);
    addedIds = merged.addedIds;
    return merged.set;
  }))!;
  const added = new Set(addedIds);
  for (const entry of set.entries) {
    if (!added.has(entry.submission_id)) continue;
    await appendSubmissionEvent(artifactsDir, {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: runId,
      submission_id: entry.submission_id,
      lane: entry.lane,
      kind: "expected",
      recorded_at: new Date().toISOString(),
    });
  }

  const carried: ExpectedSubmissionSet = {
    ...declared,
    entries: declared.entries.filter((entry) => !added.has(entry.submission_id)),
  };
  if (carried.entries.length === 0) return NO_SHORTFALL;
  const byId = new Map(carried.entries.map((entry) => [entry.submission_id, entry]));
  const diff = diffExpectedSet(
    carried,
    await observeLanes(artifactsDir, carried.entries),
  );
  const outstanding = diff.members.flatMap((member) =>
    member.status === "issue" ? [member] : [],
  );
  // A REFUSED lane also reads as ENOENT, because quarantining moves the file
  // off the bound path and only an ACCEPTED lane is dropped from the set. The
  // disk cannot tell the two apart, so the record does: without this, a host
  // whose submission was received and rejected is told it "submitted nothing",
  // which is false and points it at the wrong repair.
  const refusals =
    outstanding.length > 0
      ? await readTrailingSubmissionRefusals(
          artifactsDir,
          outstanding.map((member) => member.submission_id),
        )
      : new Map<string, SubmissionLedgerEvent>();
  const roots = laneSubmissionRoots(artifactsDir);
  return {
    expected: diff.expected,
    accepted: diff.accepted,
    outstanding: outstanding.map((member) => {
      const entry = byId.get(member.submission_id);
      const lane = entry?.lane ?? member.submission_id;
      const refusal = refusals.get(member.submission_id);
      return {
        lane,
        submission_id: member.submission_id,
        // Absolute, matching this step's `access.write_paths` entry — see the
        // schema note; the expected set's own record stays artifact-relative.
        submission_path: absoluteSubmissionPath(roots, member.submission_id),
        issue_code: refusal ? "submission_rejected" : member.issue.code,
        message: refusal
          ? `lane '${lane}' submitted, and the submission was refused` +
            `${refusal.message ? `: ${refusal.message}` : ""}` +
            " — fix it and resubmit at the bound path"
          : member.issue.message,
      };
    }),
  };
}

/**
 * Append one `dispatched` row per lane that has none yet.
 *
 * Called from the ONE materializing boundary, from the caller's whole lane list
 * — on the other side of the `expected !== false` filter, which is untouched.
 * Deduped per submission id so a re-emitted round (the K-of-N resume path
 * rewrites a still-pending lane's prompt on every call) records the dispatch
 * once rather than once per poll.
 */
export async function recordDispatchedLanes(
  artifactsDir: string,
  runId: string,
  lanes: readonly string[],
  roundId?: string,
  bindings?: ReadonlyMap<string, { promptSha256: string; reviewRequirement: string; promptPath: string }>,
): Promise<void> {
  if (lanes.length === 0) return;
  const events = await readSubmissionLedger(artifactsDir);
  const alreadyDispatched = new Set(events.filter(event => event.kind === "dispatched").map(event => event.submission_id));
  const currentBindings = new Map(events.filter(event => event.kind === "prompt_bound").map(event => [event.submission_id, `${event.prompt_sha256}:${event.review_requirement}`]));
  for (const lane of lanes) {
    const submissionId = laneSubmissionId(lane, runId);
    const common = { contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION, run_id: runId, submission_id: submissionId, lane, ...(roundId === undefined ? {} : { round_id: roundId }), recorded_at: new Date().toISOString() };
    if (!alreadyDispatched.has(submissionId)) {
      alreadyDispatched.add(submissionId);
      await appendSubmissionEvent(artifactsDir, { ...common, kind: "dispatched" });
    }
    const binding = bindings?.get(lane);
    const key = `${binding?.promptSha256}:${binding?.reviewRequirement}`;
    if (binding && currentBindings.get(submissionId) !== key) {
      currentBindings.set(submissionId, key);
      await appendSubmissionEvent(artifactsDir, { ...common, kind: "prompt_bound", prompt_sha256: binding.promptSha256, prompt_path: binding.promptPath, review_requirement: binding.reviewRequirement });
    }
  }
}

/** What the bytes at a lane's bound path say it delivered. */
async function observeLaneDelivery(path: string, binding?: SubmissionLedgerEvent): Promise<{ outcome: MeasuredOutcome; message?: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) return { outcome: "not_run" };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    const diagnostic = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : "";
    return { outcome: "degraded", message: `Could not read lane result${diagnostic}.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Present and unusable — the lane that returned the single word "Let".
    return { outcome: "degraded" };
  }
  const requirement = ReviewRequirementSchema.safeParse(binding?.review_requirement ?? "ordinary");
  if (!requirement.success) return { outcome: "degraded" };
  const reviewed = parseReviewSubmissionEnvelope(value, { requirement: requirement.data, promptSha256: binding?.prompt_sha256 });
  if (!reviewed.ok) return { outcome: "degraded" };
  value = reviewed.result;
  const items = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value).find((entry) => Array.isArray(entry))
      : undefined;
  if (items === undefined) {
    // A JSON value that is not a submission shape at all.
    return { outcome: isRecord(value) && Object.keys(value).length === 0 ? "clean" : "degraded" };
  }
  return { outcome: items.length > 0 ? "findings" : "clean" };
}

/**
 * Observe, ONCE, what each still-open dispatched lane delivered.
 *
 * WHY IT IS NOT AT THE EMISSION. `materializeFanoutLanes` can never see the
 * LAST delivery: once the round's terminal submission lands and is ingested,
 * the lanes are never re-materialized, so an emission-time observer would report
 * a fully delivered pass as 0 of N. This runs at the fold that ingests the
 * round's terminal submission, and again when a round is superseded.
 *
 * A lane the TOOL ingests needs nothing here — its `accepted`/`rejected` row is
 * already its terminal record. So "still open" is: a `dispatched` row with no
 * `lane_outcome` and no ingest event after it. Idempotent by that definition,
 * so calling it twice appends nothing the second time: an outcome is observed
 * once, and this never mints a terminal row nobody observed.
 */
export async function closeDispatchedLaneOutcomes(
  artifactsDir: string,
  params: {
    readonly lanes: readonly string[];
    readonly runId?: string;
    readonly roundId?: string;
  },
): Promise<void> {
  if (params.lanes.length === 0) return;
  const runId = params.runId ?? AUDIT_GATE_SUBMISSION_SCOPE;
  const events = await readSubmissionLedger(artifactsDir);
  const dispatched = new Set<string>();
  const terminated = new Set<string>();
  // A later event overwrites an earlier one: the map holds the LAST binding.
  const lastPromptBound = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.kind === "prompt_bound") lastPromptBound.set(event.submission_id, event);
    if (event.kind === "dispatched") dispatched.add(event.submission_id);
    else if (event.kind === "lane_outcome" || isIngestEvent(event.kind)) {
      terminated.add(event.submission_id);
    }
  }
  for (const lane of params.lanes) {
    const submissionId = laneSubmissionId(lane, runId);
    if (!dispatched.has(submissionId) || terminated.has(submissionId)) continue;
    terminated.add(submissionId);
    await appendSubmissionEvent(artifactsDir, {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: runId,
      submission_id: submissionId,
      lane,
      kind: "lane_outcome",
      ...(await observeLaneDelivery(
        laneSubmissionPath(artifactsDir, lane, runId),
        lastPromptBound.get(submissionId),
      )),
      ...(params.roundId === undefined ? {} : { round_id: params.roundId }),
      recorded_at: new Date().toISOString(),
    });
  }
}

/** Merge the shortfalls of a step that materializes several lane groups. */
export function mergeLaneShortfalls(
  shortfalls: readonly LaneSubmissionShortfall[],
): LaneSubmissionShortfall {
  return {
    expected: shortfalls.reduce((total, one) => total + one.expected, 0),
    accepted: shortfalls.reduce((total, one) => total + one.accepted, 0),
    outstanding: shortfalls.flatMap((one) => one.outstanding),
  };
}

/**
 * The host-facing statement of an unmet expectation, by lane and issue code.
 * Empty when nothing was carried or everything carried has arrived — a clean
 * emission says nothing, so the notice's presence is itself the signal.
 */
export function renderLaneShortfallLines(
  shortfall: LaneSubmissionShortfall,
): string[] {
  if (shortfall.outstanding.length === 0) return [];
  return [
    "## Submissions still outstanding",
    "",
    `A previous emission asked for ${shortfall.expected} lane submission(s); ${shortfall.accepted} arrived. ` +
      "These are still unsatisfied at the bound paths the tool declared — nothing was lost, and the paths are unchanged:",
    "",
    ...shortfall.outstanding.map(
      (entry) => `- lane \`${entry.lane}\` (${entry.issue_code}): ${entry.message}`,
    ),
    "",
  ];
}

/**
 * Record the outcome of one lane. An accepted lane stops being owed; a rejected
 * one stays owed (the host is asked again) but the refusal is on the record
 * with its reason, which is what makes a repaired run distinguishable from a
 * clean one.
 *
 * @param history A ledger read the CALLER already paid for, shared across a
 *   batch of lane recordings. Omitted (a one-off caller, an operator verb) it
 *   reads the ledger itself. ONE read per batch, never one per lane: a fold
 *   commit records its whole staged register in a loop, and re-reading the
 *   ledger per iteration was O(events) scans of the same growing file.
 */
export async function recordLaneOutcome(
  artifactsDir: string,
  lane: string,
  outcome:
    | { readonly kind: "accepted"; readonly message?: string; readonly acceptanceId?: string }
    | {
        readonly kind: "rejected";
        readonly issueCode: SubmissionIssueCode;
        readonly message: string;
      },
  history?: SubmissionIngestHistory,
): Promise<void> {
  // ONE derivation of the scope: the id and the event's run field are the same
  // value by construction, not two sites spelling the same constant.
  const runId = AUDIT_GATE_SUBMISSION_SCOPE;
  const submissionId = laneSubmissionId(lane, runId);
  // A crash can replay the same staged acceptance, even after a later refusal.
  // A new result staged at the same lane is a different occurrence, even when its
  // bytes match. Older receipts and unstaged writers keep lane-level deduplication.
  let alreadyAccepted = false;
  if (outcome.kind === "accepted") {
    const ledger =
      history ??
      (await readSubmissionIngestHistory(artifactsDir, { runId }));
    alreadyAccepted = outcome.acceptanceId === undefined
      ? ledger.accepted.has(submissionId)
      : ledger.stagedAcceptances.get(submissionId)?.has(outcome.acceptanceId) === true;
  }
  if (!alreadyAccepted) {
    await appendSubmissionEvent(artifactsDir, {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: runId,
      submission_id: submissionId,
      lane,
      kind: outcome.kind,
      ...(outcome.kind === "rejected"
        ? { issue_code: outcome.issueCode, message: outcome.message }
        : {}),
      ...(outcome.kind === "accepted" && outcome.message
        ? { message: outcome.message }
        : {}),
      ...(outcome.kind === "accepted" && outcome.acceptanceId !== undefined ? { acceptance_id: outcome.acceptanceId } : {}),
      recorded_at: new Date().toISOString(),
    });
  }
  if (outcome.kind !== "accepted") return;
  // Keep the caller's shared view consistent with what just landed, so the
  // next lane in the same batch (and a re-entry that re-walks the register)
  // asks against a ledger that includes this row.
  history?.accepted.add(submissionId);
  if (history && outcome.acceptanceId !== undefined) {
    let ids = history.stagedAcceptances.get(submissionId);
    if (!ids) history.stagedAcceptances.set(submissionId, ids = new Set());
    ids.add(outcome.acceptanceId);
  }
  // Always reconcile the expected set, including a retry after an accepted
  // append landed but this removal failed. Only the append is deduplicated.
  // The drop runs under the store's lock, so it cannot race a concurrent
  // emission's merge (which would otherwise re-add the lane being closed out).
  await expectedSetStore(artifactsDir).mutate((current) =>
    current === undefined
      ? SKIP_WRITE
      : withoutExpectedSubmissions(current, [submissionId]),
  );
}
