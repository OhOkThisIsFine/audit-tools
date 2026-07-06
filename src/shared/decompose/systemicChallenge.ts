// Phase E — the systemic improvement-seeking challenge submission (shared schema).
//
// The second-order adversary runs as a SEPARATE agent (host_delegation); each
// loop-until-dry round it writes the improvements it surfaced to
// `incoming/systemic-challenge.json`. This is the schema the audit-side executor
// validates that submission against (mirrors the Phase-D
// `ClarificationAnswersSubmission`). The findings carry their TRUE lens — the
// adversary tags a test-parallelization finding `tests`/`performance`, an ops finding
// `operability` — NEVER a hardcoded `architecture` label. The loop enforcement
// (grounding, dedupe against prior rounds, convergence) is deterministic and lives
// audit-side (src/audit/systemic/systemicChallengeLoop.ts).
//
// PURE schema module: no IO, no LLM. Kept in shared so both orchestrators (and the
// audit executor + its tests) validate against one source and cannot drift.

import { z } from "zod";
import { FindingSchema } from "../types/finding.js";

/**
 * One challenge round's submission from the second-order adversary agent: the
 * improvement findings it surfaced this round. An EMPTY `findings` array is the
 * loop-until-dry terminator — a round that surfaces nothing new converges the loop
 * (the review is done only when a round yields nothing, not when it first has an
 * answer). Findings carry their true lens; the deterministic loop grounds them,
 * dedupes them against prior rounds, and sets `systemic:true`.
 */
export const SystemicChallengeSubmissionSchema = z
  .object({
    findings: z.array(FindingSchema).default([]),
  })
  .strict();
export type SystemicChallengeSubmission = z.infer<
  typeof SystemicChallengeSubmissionSchema
>;
