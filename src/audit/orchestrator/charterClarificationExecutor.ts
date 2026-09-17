// sites-pinned: tests/audit/charter-clarification.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterClarificationRegister } from "../types/charterClarification.js";
import {
  assembleClarificationRegister,
  groundDesignFindings,
  type ClarificationAttention,
  type ClarificationDifferenceInput,
  type ClarificationAnswersSubmission,
  type CharterDifferenceAnswer,
  type CharterDifferenceQuestion,
  type CharterLaneGraph,
  type CharterCorrespondence,
  type Ceiling,
  type IntentCheckpoint,
  resolveRunBoundDesignReview,
} from "audit-tools/shared";
import { resolveCharterCeiling, ceilingRequestsCharters } from "./charterExtractionExecutor.js";
import { partitionDifferencesToQuestions } from "../clarification/partition.js";
import { applyRiskGate } from "../clarification/riskGate.js";
import { splitByAttention } from "../clarification/dials.js";

/**
 * Resolve the attention appetite (control-surface dial #3) from the confirmed
 * checkpoint. Defaults to `0` — the autonomous mode (every charter question
 * becomes a written finding, no human loop). RUN-BOUND like every other dial.
 */
export function resolveClarificationAttention(
  checkpoint: IntentCheckpoint | undefined,
): ClarificationAttention {
  const attention = resolveRunBoundDesignReview(checkpoint)?.attention;
  return attention ?? 0;
}

/**
 * Refuse an answers submission that keys an answer on a `request_id` this run
 * never asked.
 *
 * WHY IT REFUSES RATHER THAN IGNORES. `request_id` is a free string at the gate,
 * so an invented, mistyped or placeholder id parses. The answer then lands in a
 * map nothing reads, every question the run DID ask falls to the `leave_open`
 * default below, and the register records a success. The host relayed the
 * questions, the user answered them, and the answers were discarded in silence —
 * the one outcome this step must not have, because attention is the scarcest of
 * the three currencies the control surface spends (owner decision, 2026-09-17:
 * refuse the whole submission).
 *
 * THE WHOLE SUBMISSION, not the offending entry. A partial acceptance still
 * completes the round, so the dropped answers would be gone by the time anyone
 * read the validation issue; a refusal keeps the queue open and the staged
 * payload rescuable through `recover-submission`.
 *
 * THIS BOUNDARY owns the check because it is the first one holding both halves:
 * the asked queue lives in the bundle and the gate never sees it. The prompt
 * states the rule (`charterClarificationPrompt`) and this enforces it, so a host
 * that obeys the prompt exactly is never refused here.
 */
function refuseUnaskedRequestIds(
  answers: ClarificationAnswersSubmission,
  asked: readonly CharterDifferenceQuestion[],
): void {
  const askedIds = new Set(asked.map((q) => q.request_id));
  const unasked = [...new Set(answers.answers.map((a) => a.request_id))]
    .filter((id) => !askedIds.has(id))
    .sort();
  if (unasked.length === 0) return;
  throw new Error(
    `charter clarification answers name ${unasked.length} request_id(s) this run never asked: ` +
      `${unasked.map((id) => JSON.stringify(id)).join(", ")} — ` +
      (askedIds.size === 0
        ? "this round asked no interactive questions at all, so there is nothing to answer."
        : `copy an id exactly as the prompt printed it (asked: ${[...askedIds].sort().join(", ")}). ` +
          "The whole submission is refused: an unmatched id is an answer the tool would drop while " +
          "recording every question you did answer as left open."),
  );
}

/** The union of the corresponding nodes' file scopes — the question's affected files. */
function correspondenceFiles(
  correspondence: CharterCorrespondence | undefined,
  graphs: readonly CharterLaneGraph[],
): string[] {
  const files = new Set<string>();
  for (const member of correspondence?.members ?? []) {
    const graph = graphs.find((g) => g.kind === member.kind);
    for (const id of member.node_ids) {
      for (const f of graph?.nodes.find((n) => n.node_id === id)?.files ?? []) files.add(f);
    }
  }
  return [...files].sort();
}

/**
 * The report's grouping key: the structure-decomposition consensus unit whose
 * members overlap the corresponding scopes most (ties → first by id). The
 * decomposition is the GROUPING key only, never the correspondence key.
 */
function placeInSubsystem(files: readonly string[], bundle: ArtifactBundle): string | undefined {
  let best: { id: string; overlap: number } | undefined;
  const scope = new Set(files);
  for (const unit of bundle.structure_decomposition?.consensus ?? []) {
    const overlap = unit.members.filter((m) => scope.has(m)).length;
    if (overlap > 0 && (!best || overlap > best.overlap || (overlap === best.overlap && unit.node_id < best.id))) {
      best = { id: unit.node_id, overlap };
    }
  }
  return best?.id;
}

/** Join the register's verified differences to their correspondence, files and subsystem. */
function clarificationInputs(bundle: ArtifactBundle): ClarificationDifferenceInput[] {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") return [];
  const corrById = new Map(register.correspondences.map((c) => [c.correspondence_id, c]));
  return register.differences.map((difference) => {
    const correspondence = corrById.get(difference.correspondence_id);
    const members = correspondenceFiles(correspondence, register.lanes);
    const subsystem_id = placeInSubsystem(members, bundle);
    return { difference, correspondence, members, ...(subsystem_id ? { subsystem_id } : {}) };
  });
}

function omittedRegister(
  ceiling: Ceiling,
  attention: ClarificationAttention,
  generated_at: string,
): CharterClarificationRegister {
  return {
    generated_at,
    target: "charter_clarification",
    ceiling,
    attention,
    status: "omitted",
    asked: [],
    banked: [],
    findings: [],
    validation_issues: [],
  };
}

/**
 * Charter-clarification executor (Phase D). Deterministic: it consumes the
 * register's verified differences and runs the triangulation loop — partition →
 * risk-gate → split-by-attention → surface findings. Two modes:
 *
 * - **omit** (`shallow` ceiling, or no non-omitted register, or a register still
 *   owed a comparison or fidelity turn): write an empty `status:omitted` register.
 * - **run**: assemble the VOI-ranked interactive queue (`asked`) + the banked
 *   findings, grounding every surfaced Finding's evidence against disk. Under
 *   attention `0` every question banks (the autonomous mode).
 */
export function runCharterClarificationExecutor(
  bundle: ArtifactBundle,
  answers?: ClarificationAnswersSubmission,
): ExecutorRunResult {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const attention = resolveClarificationAttention(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  const register = bundle.charter_register;
  if (!ceilingRequestsCharters(ceiling) || !register || register.status === "omitted") {
    const omitted = omittedRegister(ceiling, attention, generated_at);
    return {
      updated: { ...bundle, charter_clarification: omitted },
      artifacts_written: ["charter_clarification.json"],
      progress_summary: ceilingRequestsCharters(ceiling)
        ? "Charter clarification: no charter register with differences; recorded an empty register."
        : `Charter clarification omitted (ceiling '${ceiling.rung}' does not request the charter layer).`,
    };
  }

  // When an answers submission is present the interruptible-loop rule applies:
  // every interactive question the host DIDN'T answer defaults to `leave_open`.
  const priorAnswers = new Map<string, CharterDifferenceAnswer>();
  if (answers) {
    refuseUnaskedRequestIds(answers, bundle.charter_clarification?.asked ?? []);
    for (const a of answers.answers) priorAnswers.set(a.request_id, a.answer);
    for (const q of bundle.charter_clarification?.asked ?? []) {
      if (!priorAnswers.has(q.request_id)) priorAnswers.set(q.request_id, "leave_open");
    }
  }

  const inputs = clarificationInputs(bundle);
  const assembled = assembleClarificationRegister(
    inputs,
    register.lanes,
    attention,
    { partitionDifferencesToQuestions, applyRiskGate, splitByAttention },
    priorAnswers,
  );
  const findings = groundDesignFindings(assembled.findings, bundle.repo_manifest);

  const clarification: CharterClarificationRegister = {
    generated_at,
    target: "charter_clarification",
    ceiling,
    attention,
    asked: assembled.asked,
    banked: assembled.banked,
    findings,
    validation_issues: assembled.validation_issues,
  };
  const noteSummary =
    clarification.validation_issues.length === 0
      ? "."
      : `, ${clarification.validation_issues.length} note(s):\n` +
        clarification.validation_issues.map((m) => `  - ${m}`).join("\n");
  return {
    updated: { ...bundle, charter_clarification: clarification },
    artifacts_written: ["charter_clarification.json"],
    progress_summary:
      `Charter clarification complete: ${clarification.asked.length} interactive question(s) ` +
      `(attention ${String(attention)}), ${clarification.banked.length} banked → ` +
      `${clarification.findings.length} finding(s)` +
      noteSummary,
  };
}
