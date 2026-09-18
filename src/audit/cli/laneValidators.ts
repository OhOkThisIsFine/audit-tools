// sites-pinned: tests/audit/next-step-helpers.test.ts, tests/audit/charter-emit-order.test.ts, tests/audit/executor-registry-sync.test.ts, tests/audit/pipeline-integration.test.ts
/**
 * The ONE registry of what a lane's submission must satisfy.
 *
 * Every gate validated its submission inline, which was fine while the only
 * reader was the gate itself. The hand-recovery verb is a SECOND reader of the
 * same contract, and a second reader is exactly where a weaker copy grows: an
 * operator rescue that skipped the schema would be a door into the tool the
 * normal lane does not have. So the rule lives here once, and both the gate and
 * `recover-submission` resolve it from this table.
 *
 * Two shapes of rule, because two shapes of lane exist: those whose contract IS
 * a zod schema, and those whose contract is a tolerated JSON shape (an array of
 * findings, a decisions map). Both are expressed as the same
 * `SubmissionIssue | null` validator so a caller never has to know which.
 */
import type { RefinementCtx, ZodTypeAny } from "zod";

import {
  CharterLaneSubmissionSchema,
  PATH_SHAPED_PROVENANCE_KINDS,
  citationNamesASpan,
  CharterComparisonSubmissionSchema,
  CharterFidelitySubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  CriticalFlowFallbackResultSchema,
  SynthesisNarrativeSchema,
  SystemicChallengeSubmissionSchema,
  isRecord,
  systemicChallengeSchema,
  type CharterProvenance,
  type SubmissionIssue,
} from "audit-tools/shared";
import { IntentEquivalenceVerdictSchema } from "../orchestrator/intentEquivalenceExecutor.js";
import { ConceptualJudgeSubmissionSchema } from "../types/conceptualAdjudication.js";
import {
  CONCEPTUAL_PERSPECTIVE_LANE_PREFIX,
  SYSTEMIC_CHALLENGE_LANE_PREFIX,
  GATE_LANES,
  charterKindForLane,
} from "./laneSubmissions.js";

/** Human-readable description of why a submission is neither an array nor a single-array-wrapped object. */
export function describeSubmissionShapeMismatch(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const t = typeof value;
  if (t !== "object") return `a bare ${t}`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "an empty object";
  const arrayKeys = entries.filter(([, v]) => Array.isArray(v)).map(([k]) => k);
  const allKeys = entries.map(([k]) => k).join(", ");
  if (arrayKeys.length === 0) {
    return `an object with no array-valued properties (keys: ${allKeys})`;
  }
  return (
    `an object with ${arrayKeys.length} array-valued propert${arrayKeys.length === 1 ? "y" : "ies"} ` +
    `out of ${entries.length} total key(s) (${allKeys}) — exactly one top-level array property is ` +
    `required for the tolerant unwrap`
  );
}

/**
 * The single tolerant-unwrap rule: a bare array is accepted as-is; a top-level
 * object wrapping exactly one array-valued property is unambiguous and is
 * accepted as that array. Anything else fails with a shape description.
 * Single-sourced so the design-review gate, the edge-reasoning gate, and the
 * recovery verb cannot drift on what shapes are accepted.
 */
export function unwrapSubmissionArray(
  value: unknown,
): { ok: true; array: unknown[] } | { ok: false; reason: string } {
  if (Array.isArray(value)) return { ok: true, array: value };
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && Array.isArray(entries[0][1])) {
      return { ok: true, array: entries[0][1] };
    }
  }
  return { ok: false, reason: describeSubmissionShapeMismatch(value) };
}

/**
 * The charter lane schema: the submission shape PLUS scope grounding — a goal
 * node citing files the repo does not contain is refused whole, naming them,
 * never silently narrowed.
 *
 * It carried a second refinement until 2026-09-17: kind purity, which checked
 * the lane's self-declared `kind` against the lane it arrived as. The submission
 * no longer states a kind at all — each lane writes its own file at a lane-bound
 * path and the tool stamps the kind at merge — so the field, and the check that
 * only ever compared the lane against itself, are both gone (owner review of
 * prompt 8). `.strict()` still refuses a submission that states one, by name,
 * rather than ignoring it: two answers to "which lane is this" is worse than
 * one refusal, and the tool's answer is the bound path.
 *
 * It took the lane's `kind` as a parameter for that one check, and takes none
 * now: every extraction lane answers to the identical contract, and WHICH lane
 * a submission is, is the bound path it arrived on. The caller still resolves
 * the kind, to decide that this is a charter lane at all.
 *
 * `repoFiles` is the manifest's path set. It is a parameter rather than a
 * capture so the gate and the recovery verb apply the identical refinement
 * against the identical universe.
 */
export function charterLaneSchema(repoFiles: ReadonlySet<string>): ZodTypeAny {
  return CharterLaneSubmissionSchema.superRefine((submission, ctx) => {
    submission.nodes.forEach((node, ni) => {
      const unknownFiles = (node.files ?? []).filter((f) => !repoFiles.has(f));
      if (unknownFiles.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", ni, "files"],
          message:
            `goal node "${node.node_id}" cites file(s) outside the repo: ${unknownFiles.sort().join(", ")} — ` +
            "scopes must be repo-relative paths exactly as the evidence packet names them",
        });
      }
      refineSpanCitationsCarryAQuote(node.provenance, ["nodes", ni], ctx);
    });
    submission.edges.forEach((edge, ei) => {
      refineSpanCitationsCarryAQuote(edge.provenance, ["edges", ei], ctx);
    });
  });
}

/**
 * Refuse a path-shaped citation that names a SPAN inside its file — a `#symbol`
 * anchor or a line suffix — and carries no quote.
 *
 * This is the half of the quote requirement the lane gate OWNS, and it owns it
 * because the defect is visible in the submission alone: naming a span without
 * quoting it is unverifiable by construction. Nothing resolves an anchor, so the
 * quote is the only evidence that the named span says what the node claims, and
 * no amount of context could make the citation checkable.
 *
 * It deliberately leaves a quoteless BARE-path citation alone, because that case
 * is not a defect here — a lane whose packet delivered a file as a tree entry with
 * no excerpt has the bare path as its only truthful citation. Whether a file was
 * excerpted is a fact of the evidence packet's manifest, which this gate cannot
 * see: it holds the repository's path set, not the packet. So the packet-aware
 * half lives at the boundary that holds the manifests — `checkLaneCitations` in
 * `charterExtractionExecutor` — and refuses a quoteless citation of a file the
 * packet DID excerpt. Two rules, one property, each at the boundary that owns it
 * (owner decision, 2026-09-17).
 */
function refineSpanCitationsCarryAQuote(
  provenance: readonly CharterProvenance[],
  path: readonly (string | number)[],
  ctx: RefinementCtx,
): void {
  provenance.forEach((p, pi) => {
    if (!PATH_SHAPED_PROVENANCE_KINDS.has(p.kind)) return;
    if (p.quote !== undefined && p.quote.trim().length > 0) return;
    if (!citationNamesASpan(p.ref)) return;
    ctx.addIssue({
      code: "custom",
      path: [...path, "provenance", pi, "quote"],
      message:
        `citation "${p.ref}" names a span inside the file but carries no quote — ` +
        "a span reference is only checkable through the text you copied, so quote it, " +
        "or cite the file alone",
    });
  });
}

/**
 * Lanes whose contract is a zod schema, keyed by lane id. The gate descriptors
 * read this table; so does the recovery verb.
 */
export const LANE_SUBMISSION_SCHEMAS: Readonly<Record<string, ZodTypeAny>> = {
  [GATE_LANES.synthesis_narrative]: SynthesisNarrativeSchema,
  [GATE_LANES.critical_flow_fallback]: CriticalFlowFallbackResultSchema,
  [GATE_LANES.charter_comparison]: CharterComparisonSubmissionSchema,
  [GATE_LANES.charter_fidelity]: CharterFidelitySubmissionSchema,
  [GATE_LANES.charter_clarification]: ClarificationAnswersSubmissionSchema,
  [GATE_LANES.systemic_challenge]: SystemicChallengeSubmissionSchema,
  [GATE_LANES.intent_equivalence]: IntentEquivalenceVerdictSchema,
};

function schemaIssue(schema: ZodTypeAny, value: unknown): SubmissionIssue | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  return {
    code: "submission_contract_invalid",
    message: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
  };
}

function arrayIssue(value: unknown): SubmissionIssue | null {
  const unwrapped = unwrapSubmissionArray(value);
  return unwrapped.ok
    ? null
    : { code: "submission_contract_invalid", message: unwrapped.reason };
}

function conceptualIssue(value: unknown): SubmissionIssue | null {
  if (ConceptualJudgeSubmissionSchema.safeParse(value).success) return null;
  return arrayIssue(value);
}

function objectMapIssue(value: unknown): SubmissionIssue | null {
  return isRecord(value)
    ? null
    : {
        code: "submission_contract_invalid",
        message: `expected a JSON object, got ${describeSubmissionShapeMismatch(value)}`,
      };
}

/** What the recovery verb needs in order to apply the FULL lane contract. */
export interface LaneValidationContext {
  /** The repo manifest's path set — the charter lanes' scope grounding. */
  readonly repoFiles: ReadonlySet<string>;
}

/**
 * The validator the normal lane applies to `lane`, or `null` when the lane id
 * is not one this tool knows. Callers that cannot supply a validator must
 * REFUSE rather than accept — an unknown lane has no contract to check against,
 * and "no contract" must never read as "passes".
 */
export function laneSubmissionValidator(
  lane: string,
  context: LaneValidationContext,
): ((value: unknown) => SubmissionIssue | null) | null {
  const systemicRound = lane.startsWith(SYSTEMIC_CHALLENGE_LANE_PREFIX)
    && /^[0-9a-f]{12}$/.test(lane.slice(SYSTEMIC_CHALLENGE_LANE_PREFIX.length));
  if (systemicRound || lane === GATE_LANES.systemic_challenge) {
    // The systemic lane's contract is bound to THIS run's repository: an
    // improvement naming no real component is refused here, so the adversary
    // reads the reason and resubmits. See `systemicChallengeSchema` — the
    // alternative was a downstream deletion that fabricated a quiet round.
    const bound = systemicChallengeSchema(context.repoFiles);
    return (value) => schemaIssue(bound, value);
  }
  const schema = LANE_SUBMISSION_SCHEMAS[lane];
  if (schema) return (value) => schemaIssue(schema, value);

  // The kind decides only that this IS an extraction lane; every extraction
  // lane answers to the identical contract.
  if (charterKindForLane(lane)) {
    const laneSchema = charterLaneSchema(context.repoFiles);
    return (value) => schemaIssue(laneSchema, value);
  }

  if (lane === GATE_LANES.design_review_conceptual) {
    return conceptualIssue;
  }

  if (
    lane === GATE_LANES.design_review_contract ||
    lane === GATE_LANES.edge_reasoning ||
    lane.startsWith(CONCEPTUAL_PERSPECTIVE_LANE_PREFIX)
  ) {
    return arrayIssue;
  }

  if (
    lane === GATE_LANES.analyzer_consent ||
    lane === GATE_LANES.analyzer_decisions
  ) {
    return objectMapIssue;
  }

  return null;
}
