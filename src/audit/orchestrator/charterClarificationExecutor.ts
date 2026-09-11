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
  resolveRunBoundDesignReview,
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
 *
 * RUN-BOUND, like every other dial in that block. `attention` is a per-run
 * choice (owner, 2026-08-21), so a block a PRIOR confirmation supplied must not
 * govern this run — reading it unbound would take a run that never opted into a
 * human loop and pop interactive questions at it, the same defect
 * `resolveRunBoundDesignReview` exists to prevent for depth and ceiling.
 */
export function resolveClarificationAttention(
  checkpoint: IntentCheckpoint | undefined,
): ClarificationAttention {
  const attention = resolveRunBoundDesignReview(checkpoint)?.attention;
  return attention ?? 0;
}

/**
 * Join the Phase-C charter register's routed deltas to their subsystem members +
 * (optional) goal node, producing the loop input.
 *
 * Both joins take the PRODUCER's own decision off the wire: `node_id` and
 * `goal_node_id` are explicit fields the assembler stamps, so `delta_id` is opaque
 * here and is never split to recover a node (INV-CCI-NO-DELTA-ID-PARSING). The
 * assembler mints it with a content-derived discriminator when a subsystem carries
 * two deltas on one channel pair, so its segment structure holds no recoverable
 * node id — parsing it would silently join the delta to the wrong subsystem's
 * members, which ride onto the emitted Finding's affected_files.
 *
 * `deltas` is typed `StampedCharterDelta[]`, so an unstamped delta can only arrive
 * from an artifact no schema validated (`charter_register.json` is read as plain
 * JSON). That delta is REFUSED with a validation issue rather than guessed at: a
 * question joined to the wrong subsystem is worse than a question not asked.
 */
function clarificationInputs(bundle: ArtifactBundle): {
  inputs: ClarificationDeltaInput[];
  validation_issues: string[];
} {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") {
    return { inputs: [], validation_issues: [] };
  }
  const membersByNode = new Map<string, string[]>();
  for (const sub of register.subsystems) {
    membersByNode.set(sub.node_id, sub.members);
  }
  const inputs: ClarificationDeltaInput[] = [];
  const validation_issues: string[] = [];
  for (const delta of register.deltas) {
    // typeof, not `=== undefined`: the field is required by the type, and this
    // guard exists precisely for data that never passed through it.
    if (typeof delta.node_id !== "string" || delta.node_id.length === 0) {
      validation_issues.push(
        `delta "${delta.delta_id}" carries no node_id — skipped; its subsystem cannot be ` +
          `recovered from the delta id, which is opaque (regenerate charter_register.json)`,
      );
      continue;
    }
    // A well-formed node_id that matches no subsystem is the same failure wearing
    // the right shape: the question still gets asked, but with an empty
    // affected_files, so it reads as a finding about nothing. Say so — the delta is
    // kept (the question may still be worth asking), and groundDesignFindings marks
    // the resulting Finding ungrounded as the second net.
    const members = membersByNode.get(delta.node_id);
    if (members === undefined) {
      validation_issues.push(
        `delta "${delta.delta_id}" names subsystem "${delta.node_id}", which the register ` +
          `carries no members for — its question is kept but cites no files`,
      );
    }
    inputs.push({
      delta,
      node_id: delta.node_id,
      members: members ?? [],
      goal_node_id: delta.goal_node_id,
    });
  }
  return { inputs, validation_issues };
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
    refused_issues: [],
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

  const { inputs, validation_issues: inputIssues } = clarificationInputs(bundle);
  const assembled = assembleClarificationRegister(
    inputs,
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
    // Refusals from the join come first: a delta that never became a question is
    // context for the queue that follows, not a footnote to it. `inputIssues` is
    // exactly the refusal class — every one of them is a delta the join could not
    // place, so its question is never asked — while the assembler reports its own
    // refusals separately from its routine notes.
    validation_issues: [...inputIssues, ...assembled.validation_issues],
    refused_issues: [...inputIssues, ...assembled.refused_issues],
  };
  // Surface each note's MESSAGE, not just a count — mirrors the charter-extraction
  // pass's gate-drop summary. The messages are bounded one-liners, so listing them
  // is cheap.
  //
  // The two classes print DIFFERENTLY, and that is the point of the split. A
  // REFUSAL (a delta the join could not place — no node_id, or a node the register
  // carries no members for) is a question that will NEVER BE ASKED; a routine
  // remediator-routed SKIP is the design working as intended. Under one
  // undifferentiated "N note(s)" list the operator cannot tell a silent data
  // defect from ordinary routing, so the one signal that matters is buried in the
  // list that never matters. Refusals are hoisted and counted; skips stay listed.
  const refusals = clarification.refused_issues;
  const refused = new Set(refusals);
  const routineNotes = clarification.validation_issues.filter(
    (issue) => !refused.has(issue),
  );
  const noteSummary =
    clarification.validation_issues.length === 0
      ? "."
      : (refusals.length > 0
          ? `, ${refusals.length} REFUSED delta(s) — a question that will never be asked:\n` +
            refusals.map((m) => `  - ${m}`).join("\n")
          : "") +
        (routineNotes.length > 0
          ? `, ${routineNotes.length} note(s):\n` +
            routineNotes.map((m) => `  - ${m}`).join("\n")
          : "");
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
