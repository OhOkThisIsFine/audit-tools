// sites-pinned: tests/audit/systemic-challenge.test.ts, tests/shared/prompt-renders-its-contract.test.ts
// Phase E — the systemic improvement-seeking challenge submission (shared schema).
//
// The second-order adversary runs as a SEPARATE agent (host_delegation); each
// loop-until-dry round it writes the improvements it surfaced to
// the `systemic_challenge` lane. This is the schema the audit-side executor
// validates that submission against (mirrors the Phase-D
// `ClarificationAnswersSubmission`). The findings carry their TRUE lens — the
// adversary tags a test-parallelization finding `tests`/`performance`, an ops finding
// `operability` — NEVER a hardcoded `architecture` label. The loop enforcement
// (grounding, dedupe against prior rounds, convergence) is deterministic and lives
// audit-side (src/audit/systemic/systemicChallengeLoop.ts).
//
// PURE schema module: no IO, no LLM. Kept in shared so both orchestrators (and the
// audit executor + its tests) validate against one source and cannot drift.

import { z, type ZodTypeAny } from "zod";
import { FindingSchema } from "../types/finding.js";
import { groundDesignFinding } from "../validation/designFindingGrounding.js";
import { normalizeRepoPath } from "../validation/findingGrounding.js";

// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
/**
 * One challenge round's submission from the second-order adversary agent: the
 * improvement findings it surfaced this round. An EMPTY `findings` array is the
 * loop-until-dry terminator — a round that surfaces nothing new converges the loop
 * (the review is done only when a round yields nothing, not when it first has an
 * answer). Findings carry their true lens; the deterministic loop grounds them,
 * dedupes them against prior rounds, and sets `systemic:true`.
 */
/**
 * A systemic finding must carry evidence, and the refusal is the point.
 *
 * `FindingSchema` makes `evidence` optional, but that optionality is not a
 * freedom this producer gets to use: `schemas/audit_result.schema.json` already
 * declares `minItems: 1` on evidence for every finding a host submits, so every
 * OTHER producer in the pipeline meets this rule. This lane was the one escape,
 * and the remediate intake's first filter pass (`runFindingFilterPass`) drops a
 * finding with no evidence — recording only its id, never surfacing it. So an
 * unevidenced systemic finding was unremediatable BY CONSTRUCTION, and nothing
 * on any surface said so. The whole lane could converge, bank improvements, and
 * have every one of them silently discarded downstream.
 *
 * Refusing here is strictly better than that: a refusal is reported back through
 * the lane validator and the adversary can resubmit, whereas a silent downstream
 * drop loses the round's work with no signal. The prompt asks for the field
 * (`buildSecondOrderAdversaryPrompt`), and this schema is what makes the ask
 * binding rather than advisory — the auditor-agnostic rule: never rely on the
 * host having read carefully when the property can be enforced.
 *
 * ⚠ This is a REFINEMENT, not an `.extend()`, and the difference is load-bearing.
 * `.extend({ evidence: ... })` mints a fresh anonymous object type, which gives
 * every consumer a SECOND `Finding` identity — the typechecker then reports
 * "Two different types with this name exist, but they are unrelated" at call
 * sites that were correct before. A refinement adds the runtime rule and leaves
 * the inferred type exactly `Finding`, so there is one identity as there was.
 */
const SystemicFindingSchema = FindingSchema.refine(
  (finding) => Array.isArray(finding.evidence) && finding.evidence.length > 0,
  {
    path: ["evidence"],
    message:
      "a systemic finding must carry at least one evidence entry; without one the remediation intake discards it silently",
  },
);

/**
 * A host-forced stop of the adversary loop.
 *
 * The loop's only honest exit is a round that surfaces nothing new, and a fresh
 * round with no memory of what earlier rounds covered structurally CANNOT judge
 * "nothing new" — so a host that has exhausted its budget, or that can see the
 * loop is no longer yielding, has no sanctioned way to end it and reports a dry
 * round it did not have (the fabricated-dry signal the ceiling entry names).
 * This is that way: the host says so, and the register RECORDS the stop as
 * `stop_reason: "host_forced"` rather than as convergence.
 *
 * `reason` is required. A forced stop is a decision the report must be able to
 * explain, and an unexplained one is indistinguishable from a lost loop.
 */
const SystemicStopSchema = z
  .object({
    forced: z.literal(true),
    reason: z.string().min(1),
  })
  .strict();

export const SystemicChallengeSubmissionSchema = z
  .object({
    findings: z.array(SystemicFindingSchema).default([]),
    /**
     * Optional host-forced stop. Findings submitted WITH the stop are banked
     * normally — a stop never discards delivered work — but the round they arrived
     * in is not counted as a quiet one, so the register can never claim a dry
     * round that did not happen.
     */
    stop: SystemicStopSchema.optional(),
  })
  .strict();
/**
 * Exported for the audit-side executor, which reads back the stop it recorded
 * (`effectiveStop`) to state the reason in its progress summary.
 */
export type SystemicChallengeStop = z.infer<typeof SystemicStopSchema>;
export type SystemicChallengeSubmission = z.infer<
  typeof SystemicChallengeSubmissionSchema
>;

/**
 * The submission contract WITH the grounding rule bound to this run's repository
 * — the same argument `055d0804` settled for `evidence`, applied to the second
 * field the lane could get wrong.
 *
 * `evidence` and `affected_files` were on OPPOSITE mechanisms. A finding with no
 * evidence was REFUSED here, so the adversary read the reason and resubmitted. A
 * finding whose `affected_files` named no real component was accepted here and
 * DELETED downstream by `foldChallengeRound`, which recorded a line in the
 * register's validation issues and nothing else. That deletion is worse than a
 * lost finding: dryness counts new findings, so a round the grounding pass
 * emptied became a QUIET round, and two quiet rounds converge the register with
 * `stop_reason: "converged"`. The adversary prompt spends two paragraphs
 * forbidding the reader to report a dry round they did not have; the tool
 * manufactured one on their behalf (owner decision, 2026-09-17: a finding may be
 * dropped only explicitly, and a reader whose finding lacks grounding must be
 * TOLD to add it — the schema must not pass).
 *
 * It reuses {@link groundDesignFinding} rather than restating the membership
 * test, so the gate and the fold can never disagree about what grounds. It also
 * NORMALIZES the incoming set: `groundDesignFindings` builds its own set through
 * `normalizeRepoPath` (which lowercases and forward-slashes), while the recovery
 * verb's `repoFileUniverse` hands over the manifest paths verbatim — two sets
 * that would differ on win32 and on any capitalized path.
 *
 * An EMPTY set skips the rule and returns the bare schema, mirroring
 * `groundDesignFindings`: with no manifest nothing can be grounded, and refusing
 * every finding on a missing input is a false red, not a guarantee.
 */
export function systemicChallengeSchema(
  repoFiles: ReadonlySet<string>,
): ZodTypeAny {
  if (repoFiles.size === 0) return SystemicChallengeSubmissionSchema;
  const known = new Set([...repoFiles].map(normalizeRepoPath));
  return SystemicChallengeSubmissionSchema.superRefine((submission, ctx) => {
    submission.findings.forEach((finding, index) => {
      const grounding = groundDesignFinding(finding, known);
      if (grounding.status !== "ungrounded") return;
      ctx.addIssue({
        code: "custom",
        path: ["findings", index, "affected_files"],
        message:
          `improvement "${finding.title}" ${grounding.reason} — every improvement must name at ` +
          "least one file this run's repository manifest holds, written as a repo-relative path " +
          "exactly as the manifest spells it; add the grounding and resubmit",
      });
    });
  });
}
