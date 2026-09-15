// sites-pinned: tests/audit/charter-clarification.test.ts
// Phase D — the charter-alignment TRIANGULATION LOOP (shared pure assembly).
//
// Where the charter layer (charterLayer.ts) assembles the verified difference
// records, this module turns the clarification/human-routed, fidelity-SUPPORTED
// differences into decidable, symmetric, n-ary, VOI-ranked, risk-gated questions
// and splits them by the attention appetite: interactive questions to ASK vs
// findings to BANK (design of record spec/conceptual-design-review-design.md
// §"The triangulation loop" + §"Control surface — three currencies, three
// dials"). Zero attention = the autonomous mode (every question banked as a
// finding). It consumes the pure D1/D2 primitives that live audit-side
// (blastRadius/voiQueue/riskGate/dials/partition) via the injected `deps`.
//
// PURE + deterministic + language-neutral: no IO, no LLM.

import { z } from "zod";
import {
  CharterDifferenceAnswerSchema,
  type CharterDifference,
  type CharterCorrespondence,
  type CharterLaneGraph,
  type CharterDifferenceQuestion,
  type CharterDifferenceAnswer,
} from "../types/charter.js";
import type { Finding } from "../types/finding.js";
import { compareCodeUnits } from "../compareCodeUnits.js";

/**
 * The host answers submission (what the host writes to the
 * `charter_clarification` lane): one n-ary answer per interactive question. A
 * question with no answer in the submission defaults to `leave_open` (the
 * interruptible-loop rule), which guarantees the queue drains in one round-trip.
 */
export const ClarificationAnswersSubmissionSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            request_id: z.string(),
            answer: CharterDifferenceAnswerSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ClarificationAnswersSubmission = z.infer<
  typeof ClarificationAnswersSubmissionSchema
>;

/**
 * A verified difference joined to its correspondence, the report's grouping
 * subsystem (when the corresponding scopes overlap a structure unit), and the
 * files the question's Finding cites — the loop input.
 */
export interface ClarificationDifferenceInput {
  difference: CharterDifference;
  correspondence: CharterCorrespondence | undefined;
  subsystem_id?: string;
  members: string[];
}

/** The attention appetite — see the D2 dial. `0` = autonomous (bank everything). */
export type ClarificationAttention = number | "all";

/**
 * The pure D1/D2 primitives injected from the audit side (src/audit/clarification/*)
 * so this shared assembler never imports audit code.
 */
export interface ClarificationLoopDeps {
  partitionDifferencesToQuestions: (
    inputs: readonly ClarificationDifferenceInput[],
    graphs: readonly CharterLaneGraph[],
  ) => CharterDifferenceQuestion[];
  applyRiskGate: (
    requests: CharterDifferenceQuestion[],
  ) => CharterDifferenceQuestion[];
  splitByAttention: (
    requests: CharterDifferenceQuestion[],
    appetite: ClarificationAttention,
  ) => { asked: CharterDifferenceQuestion[]; banked: CharterDifferenceQuestion[] };
}

/** The assembled loop product (the gated + split questions + surfaced leads). */
export interface AssembledClarifications {
  asked: CharterDifferenceQuestion[];
  banked: CharterDifferenceQuestion[];
  findings: Finding[];
  validation_issues: string[];
}

/** A difference sources a question when the tool routed it to a decision and fidelity holds. */
export function sourcesQuestion(difference: CharterDifference): boolean {
  return (
    (difference.routed_to === "clarification" || difference.routed_to === "human") &&
    difference.fidelity?.verdict === "supported"
  );
}

/**
 * Assemble the charter-clarification loop from the verified differences.
 *
 * 1. PARTITION the clarification/human-routed, supported differences into
 *    n-ary questions with their VOI axes — remediator-routed records are fixes,
 *    not questions, and are recorded as a routine note; unsupported records never
 *    become questions.
 * 2. RISK-GATE the questions (high-blast → higher adversarial bar → `finding_only`).
 * 3. SPLIT by the attention appetite into `asked` vs `banked`.
 * 4. SURFACE the banked questions as Finding leads for synthesis.
 *
 * Deterministic: same differences + same graphs + same appetite → same register.
 */
export function assembleClarificationRegister(
  inputs: readonly ClarificationDifferenceInput[],
  graphs: readonly CharterLaneGraph[],
  attention: ClarificationAttention,
  deps: ClarificationLoopDeps,
  priorAnswers: Map<string, CharterDifferenceAnswer> = new Map(),
): AssembledClarifications {
  const validation_issues: string[] = [];
  const membersByRequest = new Map<string, string[]>();

  for (const input of inputs) {
    const d = input.difference;
    if (d.routed_to === "remediator") {
      validation_issues.push(
        `difference "${d.difference_id}" routes to the remediator (doc rot / drift) — not a charter question; handled by the remediator, not the attention loop`,
      );
    }
    if (input.members.length === 0 && sourcesQuestion(d)) {
      validation_issues.push(
        `difference "${d.difference_id}" cites no scoped files — its question is kept, but the Finding it surfaces will cite no affected_files`,
      );
    }
  }

  const questions = deps.partitionDifferencesToQuestions(inputs, graphs);
  for (const q of questions) {
    const input = inputs.find((i) => i.difference.difference_id === q.difference_id);
    membersByRequest.set(q.request_id, input?.members ?? []);
  }
  const gated = deps.applyRiskGate(questions);
  const split = deps.splitByAttention(gated, attention);
  const applyAnswer = (r: CharterDifferenceQuestion): CharterDifferenceQuestion => {
    const answer = priorAnswers.get(r.request_id);
    return answer ? { ...r, answer } : r;
  };
  const asked = split.asked.map(applyAnswer);
  const banked = split.banked.map(applyAnswer);

  const findings = banked
    .map((request) => questionToFinding(request, membersByRequest.get(request.request_id) ?? []))
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  return { asked, banked, findings, validation_issues };
}

/**
 * Surface a BANKED charter question as a Finding LEAD (leads-not-verdicts).
 * `severity` scales with blast radius; `lens` is `architecture`.
 */
function questionToFinding(
  request: CharterDifferenceQuestion,
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
    title: `Unresolved charter question (${request.dimension})${request.subsystem_id ? ` in subsystem ${request.subsystem_id}` : ""}`,
    category: "charter_clarification",
    severity,
    confidence: "medium",
    lens: "architecture",
    summary: request.question,
    affected_files: members.map((path) => ({ path })),
    systemic: true,
  };
}
