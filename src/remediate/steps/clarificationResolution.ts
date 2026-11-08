// sites-pinned: tests/remediate/clarification-round-contract.test.ts, tests/remediate/clarification-submit.test.ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { compareCodeUnits } from "audit-tools/shared";
import type { RemediationState } from "../state/store.js";
import type { ClarificationRequest } from "../state/types.js";

// Action tokens are deliberately unambiguous so a host CANNOT lose an
// approved finding by a natural word choice at the ambiguity gate: "this
// candidate ambiguity isn't genuine" reads as a comment on the AMBIGUITY, so it
// must map to `clarified` (proceed with the finding), never to a drop. The
// finding-dropping token is named `reject_finding` — it speaks about the
// FINDING, not the ambiguity, and so can't be confused with "no ambiguity here."
const PLAN_CLARIFICATION_ACTIONS = ["clarified", "reject_finding", "defer"] as const;

/**
 * One entry of a clarification resolution file. Strict: an unknown field is
 * refused, not ignored.
 *
 * - `rationale` is REQUIRED and non-empty on `clarified`: it becomes the item's
 *   `clarification_context`, the answer the next worker reads. A `clarified`
 *   entry without it re-opened the item with no answer attached.
 * - There is no write-scope field: new write scope needs a revised, freshly
 *   reviewed plan, so an answer cannot widen a unit (owner decision 2026-10-01;
 *   the ignored `scope_additions` field was removed in two releases, and is now
 *   refused as an unknown field).
 */
const PlanClarificationResolutionSchema = z
  .object({
    unit_id: z.string().min(1, "must be a non-empty finding id"),
    action: z.enum(PLAN_CLARIFICATION_ACTIONS),
    rationale: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.action === "clarified" && (entry.rationale ?? "").trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale"],
        message:
          'is required and must be non-empty when action is "clarified" — it carries the answer to the next worker',
      });
    }
  });

export type PlanClarificationResolution = z.infer<typeof PlanClarificationResolutionSchema>;

type ParsedPlanClarifications =
  | { ok: true; resolutions: PlanClarificationResolution[] }
  | { ok: false; reason: string };

/**
 * Read and validate the mid-run `clarification_resolution.json` file.
 *
 * ONE shape is accepted: a bare JSON array of entries. Every entry is checked
 * against {@link PlanClarificationResolutionSchema}, and a second entry for the
 * same finding is refused. Any bad entry refuses the WHOLE file, and the reason
 * names the entry's index and field. The parser this replaced accepted four
 * shapes and dropped a bad entry in silence: an `"action": "approve"` lost the
 * user's answer, and the item then waited forever for a question the round no
 * longer showed.
 */
export async function readPlanClarificationResolutions(
  path: string,
  snapshotBytes?: string,
): Promise<ParsedPlanClarifications> {
  let value: unknown;
  try {
    value = JSON.parse(snapshotBytes ?? await readFile(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return parsePlanClarificationResolutions(value);
}

/** Shared structural parser for file and structured submissions. */
export function parsePlanClarificationResolutions(value: unknown): ParsedPlanClarifications {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason:
        "the file must be a JSON array of entries — an object wrapper such as " +
        '`{"resolutions": [...]}` is not accepted',
    };
  }
  const problems: string[] = [];
  const firstEntryFor = new Map<string, number>();
  const resolutions: PlanClarificationResolution[] = [];
  value.forEach((entry, index) => {
    const parsed = PlanClarificationResolutionSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.length > 0 ? ` \`${issue.path.join(".")}\`` : "";
        problems.push(`entry [${index}]${field}: ${issue.message}`);
      }
      return;
    }
    const prior = firstEntryFor.get(parsed.data.unit_id);
    if (prior !== undefined) {
      problems.push(
        `entry [${index}] \`unit_id\`: \`${parsed.data.unit_id}\` is already answered by entry [${prior}]`,
      );
      return;
    }
    firstEntryFor.set(parsed.data.unit_id, index);
    resolutions.push(parsed.data);
  });
  return problems.length > 0
    ? { ok: false, reason: problems.join("; ") }
    : { ok: true, resolutions };
}

/**
 * Every whole-file refusal of a parsed resolution, in check order: the parse,
 * then the closed id set. Null means the file may be applied.
 */
export function planClarificationRefusal(
  parsed: ParsedPlanClarifications,
  validIds: ReadonlySet<string>,
  outsideSetLabel: string,
): string | null {
  if (!parsed.ok) return parsed.reason;
  const unknownIds = parsed.resolutions
    .map((r) => r.unit_id)
    .filter((id) => !validIds.has(id));
  if (unknownIds.length > 0) {
    return `finding id(s) ${outsideSetLabel}: ${unknownIds.map((i) => `\`${i}\``).join(", ")}`;
  }
  return null;
}

/**
 * The open worker questions: one per item paused as `needs_clarification`,
 * read from the item itself (its `clarification_question`), in content-stable
 * finding-id order. The item is the question's one home, so this list cannot
 * disagree with the item statuses the round waits on.
 */
export function pausedClarifications(state: RemediationState): ClarificationRequest[] {
  return Object.values(state.items ?? {})
    .filter((item) => item.status === "needs_clarification")
    .sort((left, right) => compareCodeUnits(left.unit_id, right.unit_id))
    .map((item) => ({
      unit_id: item.unit_id,
      // The state store refuses a paused item without a question, so the
      // fallback is unreachable from a stored state; it keeps the render total.
      ...(item.clarification_question ?? {
        category: "scope_of_fix" as const,
        description: item.failure_reason ?? "(no question recorded)",
      }),
    }));
}

