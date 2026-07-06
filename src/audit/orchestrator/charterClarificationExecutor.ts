import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterClarificationRegister } from "../types/charterClarification.js";
import {
  assembleClarificationRegister,
  groundDesignFindings,
  type ClarificationAttention,
  type ClarificationDeltaInput,
  type ClarificationAnswersSubmission,
  type CharterClarificationAnswer,
  type Ceiling,
  type IntentCheckpoint,
} from "audit-tools/shared";
import { resolveCharterCeiling, ceilingRequestsCharters } from "./charterExtractionExecutor.js";
import { partitionDeltasToQuestions } from "../clarification/partition.js";
import { applyRiskGate } from "../clarification/riskGate.js";
import { splitByAttention } from "../clarification/dials.js";

/**
 * Resolve the attention appetite (Phase D control-surface dial #3) from the
 * confirmed checkpoint. Defaults to `0` — the autonomous mode (every charter
 * question becomes a written finding, no human loop), which is the
 * conversation-first default until the user opts into attention. Exported so the
 * obligation gate + the prompt renderer resolve appetite identically (one source).
 */
export function resolveClarificationAttention(
  checkpoint: IntentCheckpoint | undefined,
): ClarificationAttention {
  const attention = checkpoint?.design_review?.attention;
  return attention ?? 0;
}

/**
 * Join the Phase-C charter register's routed deltas to their subsystem members +
 * (optional) goal node, producing the loop input. A delta's goal node is its
 * `node_id` when that id appears in the goal graph — the subsystem is linked to a
 * goal — otherwise absent (the blast-radius primitive falls back to the delta
 * kind's intrinsic tier).
 */
function clarificationInputs(bundle: ArtifactBundle): ClarificationDeltaInput[] {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") return [];
  const membersByNode = new Map<string, string[]>();
  for (const sub of register.subsystems) {
    membersByNode.set(sub.node_id, sub.members);
  }
  const goalNodeIds = new Set(register.goal_graph.nodes.map((n) => n.node_id));
  const inputs: ClarificationDeltaInput[] = [];
  for (const delta of register.deltas) {
    // A delta_id is `${node_id}:${ka}-${kb}` (Phase C assembly); the node id is the
    // segment before the last `:`. Fall back to the whole id if unsplittable.
    const node_id = delta.delta_id.includes(":")
      ? delta.delta_id.slice(0, delta.delta_id.lastIndexOf(":"))
      : delta.delta_id;
    inputs.push({
      delta,
      node_id,
      members: membersByNode.get(node_id) ?? [],
      goal_node_id: goalNodeIds.has(node_id) ? node_id : undefined,
    });
  }
  return inputs;
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
 * Charter-clarification executor (Phase D). Deterministic: it consumes the Phase-C
 * `charter_register` deltas and runs the triangulation loop — partition → risk-gate
 * → split-by-attention → surface findings (design of record
 * spec/conceptual-design-review-design.md §"The triangulation loop"). Two modes,
 * gated by the ceiling:
 *
 * - **omit** (`shallow` ceiling, or no non-omitted charter register): write an
 *   empty `status:omitted` register so the obligation is satisfied with no host
 *   turn (the conversation-first default; mirrors the charter-extraction omit).
 * - **run** (`deep`/`deepest` ceiling + a Phase-C register with deltas): assemble
 *   the VOI-ranked interactive queue (`asked`) + the banked findings, grounding
 *   every surfaced Finding's evidence against disk. Under attention `0` every
 *   question banks (the autonomous mode) — a valid, complete run with no human loop.
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
        ? "Charter clarification: no charter register with deltas; recorded an empty register."
        : `Charter clarification omitted (ceiling '${ceiling.rung}' does not request the charter layer).`,
    };
  }

  // Resolve the prior answers into a request_id → answer map. When an answers
  // submission is present at all, the interruptible-loop rule applies: every
  // interactive question the host DIDN'T answer defaults to `leave_open` (a
  // first-class decision) so the queue drains and the loop terminates. Absent a
  // submission, no answers are applied (the first assemble that computes the queue).
  const priorAnswers = new Map<string, CharterClarificationAnswer>();
  if (answers) {
    for (const a of answers.answers) priorAnswers.set(a.request_id, a.answer);
    for (const q of bundle.charter_clarification?.asked ?? []) {
      if (!priorAnswers.has(q.request_id)) {
        priorAnswers.set(q.request_id, "leave_open");
      }
    }
  }

  const assembled = assembleClarificationRegister(
    clarificationInputs(bundle),
    register.goal_graph,
    attention,
    { partitionDeltasToQuestions, applyRiskGate, splitByAttention },
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
  return {
    updated: { ...bundle, charter_clarification: clarification },
    artifacts_written: ["charter_clarification.json"],
    progress_summary:
      `Charter clarification complete: ${clarification.asked.length} interactive question(s) ` +
      `(attention ${String(attention)}), ${clarification.banked.length} banked → ` +
      `${clarification.findings.length} finding(s)` +
      (clarification.validation_issues.length > 0
        ? `, ${clarification.validation_issues.length} note(s).`
        : "."),
  };
}
