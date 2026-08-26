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
import type { ZodTypeAny } from "zod";

import {
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  CriticalFlowFallbackResultSchema,
  SynthesisNarrativeSchema,
  SystemicChallengeSubmissionSchema,
  isRecord,
  type CharterKind,
  type SubmissionIssue,
} from "audit-tools/shared";
import { IntentEquivalenceVerdictSchema } from "../orchestrator/intentEquivalenceExecutor.js";
import {
  CONCEPTUAL_PERSPECTIVE_LANE_PREFIX,
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
 * The charter lane schema: the submission shape PLUS the two refinements that
 * make a blind lane trustworthy — kind purity (a lane may only carry its own
 * kind; anything else is a mis-routed submission) and scope grounding (a
 * teleology node citing files the repo does not contain is refused whole,
 * naming them, never silently narrowed).
 *
 * `repoFiles` is the manifest's path set. It is a parameter rather than a
 * capture so the gate and the recovery verb apply the identical refinement
 * against the identical universe.
 */
export function charterLaneSchema(
  kind: CharterKind,
  repoFiles: ReadonlySet<string>,
): ZodTypeAny {
  return CharterSubmissionSchema.superRefine((submission, ctx) => {
    submission.nodes.forEach((node, ni) => {
      if (node.kind !== kind) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", ni, "kind"],
          message: `lane '${kind}' may only carry kind '${kind}', got '${node.kind}'`,
        });
      }
      const unknownFiles = node.files.filter((f) => !repoFiles.has(f));
      if (unknownFiles.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", ni, "files"],
          message:
            `teleology node cites file(s) outside the repo: ${unknownFiles.sort().join(", ")} — ` +
            "scopes must be repo-relative paths exactly as the evidence packet names them",
        });
      }
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
  [GATE_LANES.charter_delta]: CharterDeltaSubmissionSchema,
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
  const schema = LANE_SUBMISSION_SCHEMAS[lane];
  if (schema) return (value) => schemaIssue(schema, value);

  const charterKind = charterKindForLane(lane);
  if (charterKind) {
    const laneSchema = charterLaneSchema(charterKind, context.repoFiles);
    return (value) => schemaIssue(laneSchema, value);
  }

  if (
    lane === GATE_LANES.design_review_legacy ||
    lane === GATE_LANES.design_review_contract ||
    lane === GATE_LANES.design_review_conceptual ||
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
