// Phase D — the charter-alignment TRIANGULATION LOOP (shared pure assembly).
//
// Where Phase C (charterExtraction.ts) assembles the routed charter deltas, this
// module turns the clarification/human-routed deltas into decidable, symmetric,
// VOI-ranked, risk-gated questions and splits them by the attention appetite:
// interactive questions to ASK vs findings to BANK (design of record
// spec/conceptual-design-review-design.md §"The triangulation loop" + §"Control
// surface — three currencies, three dials"). Zero attention = the autonomous mode
// (every question banked as a finding). It consumes the pure D1/D2 primitives that
// live audit-side (blastRadius/voiQueue/riskGate/dials/partition) via the injected
// `deps` below, so this shared module stays free of an audit → shared import and
// phase-e can drive the same loop with the same primitives.
//
// PURE + deterministic + language-neutral: no IO, no LLM. The host LLM's only role
// upstream was JUDGMENT (the charters/deltas in Phase C); the loop itself is
// deterministic enforcement — partition, rank, gate, split.

import { z } from "zod";
import {
  CharterClarificationAnswerSchema,
  type CharterDelta,
  type CharterClarificationRequest,
  type GoalGraph,
} from "../types/charter.js";
import type { Finding } from "../types/finding.js";

/**
 * The host answers submission (what the host writes to
 * `incoming/charter-clarification.json`): one symmetric answer per interactive
 * question. A question with no answer in the submission defaults to `leave_open`
 * (the interruptible-loop rule — a user who taps out leaves the rest open), which
 * guarantees the queue drains and the loop terminates in one round-trip.
 */
export const ClarificationAnswersSubmissionSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            request_id: z.string(),
            answer: CharterClarificationAnswerSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ClarificationAnswersSubmission = z.infer<
  typeof ClarificationAnswersSubmissionSchema
>;

/** A routed delta joined to its subsystem + (optional) goal node — the loop input. */
export interface ClarificationDeltaInput {
  delta: CharterDelta;
  node_id: string;
  members: string[];
  goal_node_id?: string;
}

/** The attention appetite — see the D2 dial. `0` = autonomous (bank everything). */
export type ClarificationAttention = number | "all";

/**
 * The pure D1/D2 primitives injected from the audit side (src/audit/clarification/*)
 * so this shared assembler never imports audit code. phase-e injects the same set.
 */
export interface ClarificationLoopDeps {
  partitionDeltasToQuestions: (
    deltas: Array<{ delta: CharterDelta; node_id: string; goal_node_id?: string }>,
    goalGraph: GoalGraph,
  ) => CharterClarificationRequest[];
  applyRiskGate: (
    requests: CharterClarificationRequest[],
  ) => CharterClarificationRequest[];
  splitByAttention: (
    requests: CharterClarificationRequest[],
    appetite: ClarificationAttention,
  ) => { asked: CharterClarificationRequest[]; banked: CharterClarificationRequest[] };
}

/** The assembled loop product (the gated + split questions + surfaced leads). */
export interface AssembledClarifications {
  asked: CharterClarificationRequest[];
  banked: CharterClarificationRequest[];
  findings: Finding[];
  validation_issues: string[];
}

/**
 * Assemble the charter-clarification loop from the Phase-C routed deltas.
 *
 * 1. PARTITION the clarification/human-routed deltas into symmetric questions with
 *    their VOI axes (blast radius + cascade count) — remediator-routed spec-drift
 *    deltas are NOT questions and are recorded as a validation note.
 * 2. RISK-GATE the questions (high-blast → higher adversarial bar → `finding_only`).
 * 3. SPLIT by the attention appetite into `asked` (the VOI-ranked interactive
 *    queue) vs `banked` (written as findings; everything under appetite 0).
 * 4. SURFACE the banked questions as Finding leads for synthesis.
 *
 * Deterministic: same deltas + same graph + same appetite → same register.
 */
export function assembleClarificationRegister(
  deltas: ClarificationDeltaInput[],
  goalGraph: GoalGraph,
  attention: ClarificationAttention,
  deps: ClarificationLoopDeps,
  priorAnswers: Map<string, CharterClarificationRequest["answer"]> = new Map(),
): AssembledClarifications {
  const validation_issues: string[] = [];
  const membersByNode = new Map<string, string[]>();
  for (const d of deltas) membersByNode.set(d.node_id, d.members);

  const remediatorRouted = deltas.filter(
    (d) => d.delta.routed_to === "remediator",
  );
  for (const d of remediatorRouted) {
    validation_issues.push(
      `delta "${d.delta.delta_id}" routes to the remediator (spec drift) — not a charter question; handled by the remediator, not the attention loop`,
    );
  }

  const questions = deps.partitionDeltasToQuestions(
    deltas.map((d) => ({
      delta: d.delta,
      node_id: d.node_id,
      goal_node_id: d.goal_node_id,
    })),
    goalGraph,
  );
  const gated = deps.applyRiskGate(questions);
  const split = deps.splitByAttention(gated, attention);
  // Carry any prior answers onto the re-derived questions — an answered question
  // stays in `asked` with its `answer` set (so the loop obligation is satisfied and
  // the queue drains). A user who tapped out mid-loop leaves the rest unanswered;
  // the next assemble with the interruptible flag would leave-open them.
  const applyAnswer = (
    r: CharterClarificationRequest,
  ): CharterClarificationRequest => {
    const answer = priorAnswers.get(r.request_id);
    return answer ? { ...r, answer } : r;
  };
  const asked = split.asked.map(applyAnswer);
  const banked = split.banked.map(applyAnswer);

  const findings = banked.map((request) =>
    questionToFinding(request, membersByNode.get(request.node_id) ?? []),
  );
  findings.sort((a, b) => a.id.localeCompare(b.id));

  return { asked, banked, findings, validation_issues };
}

/**
 * Surface a BANKED charter-clarification question as a Finding LEAD (leads-not-
 * verdicts — the owner judges it). `severity` scales with blast radius (a wrong-goal
 * provocation ripples furthest); `lens` is `architecture` (a charter-alignment gap
 * is a design defect). Members of the subsystem are the affected files.
 */
function questionToFinding(
  request: CharterClarificationRequest,
  members: string[],
): Finding {
  const severity: Finding["severity"] =
    request.value.blast_radius >= 3
      ? "high"
      : request.value.blast_radius >= 2
        ? "medium"
        : "low";
  return {
    id: request.request_id,
    title: `Unresolved charter question in subsystem ${request.node_id}`,
    category: "charter_clarification",
    severity,
    confidence: "medium",
    lens: "architecture",
    summary: request.question,
    affected_files: members.map((path) => ({ path })),
    systemic: true,
  };
}
