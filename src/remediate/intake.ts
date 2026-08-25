import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  readOptionalJsonFile,
  readOptionalTextFile,
  isRecord,
} from "audit-tools/shared";

export const INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION =
  "remediate-code-intake-source-manifest/v1alpha1" as const;

export const INTAKE_SUMMARY_SCHEMA_VERSION =
  "remediate-code-intake-summary/v1alpha1" as const;

export const INTAKE_CLARIFICATION_SCHEMA_VERSION =
  "remediate-code-intake-clarifications/v1alpha1" as const;

export type IntakeSourceType = "document" | "conversation" | "structured_audit";

export interface IntakeSource {
  type: IntakeSourceType;
  path: string;
  label?: string;
}

export interface IntakeSourceManifest {
  schema_version: typeof INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION;
  created_from: "input" | "default_candidates" | "conversation" | "mixed";
  sources: IntakeSource[];
}

// Zod is the single source for shape + type here (matching the repo-wide
// zod-single-source convention, e.g. RemediationBlockSchema in
// src/remediate/state/types.ts) rather than a hand-written interface kept in
// lockstep with a second, independent runtime check. Deliberately NOT
// `.strict()`: intake-summary.json is HOST-AUTHORED (the LLM-produced artifact
// synthesizeIntakePrompt's template asks for), the same trust tier as the
// auditor's `Finding` contract (FindingSchema, also non-strict) — an unknown
// extra field is not the defect class this validates; a wrong-shaped KNOWN
// field is (CP-NODE-2 invariants[11]).
export const IntakeOpenQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  category: z.string().optional(),
  blocking: z.boolean().optional(),
});
export type IntakeOpenQuestion = z.infer<typeof IntakeOpenQuestionSchema>;

export const IntakeSummarySchema = z.object({
  schema_version: z.literal(INTAKE_SUMMARY_SCHEMA_VERSION),
  ready: z.boolean(),
  source_type: z.enum(["structured_audit", "documents", "conversation", "mixed"]),
  goals: z.array(z.string()),
  non_goals: z.array(z.string()),
  constraints: z.array(z.string()),
  affected_files: z.array(
    z.object({ path: z.string(), reason: z.string().optional() }),
  ),
  open_questions: z.array(IntakeOpenQuestionSchema),
});
export type IntakeSummary = z.infer<typeof IntakeSummarySchema>;

/**
 * Validate a raw parsed `intake-summary.json` payload against
 * {@link IntakeSummarySchema}, throwing a legible Error when the shape does
 * not conform — the read-time refusal for CP-NODE-2 invariants[11]'s
 * 'unvalidated intake artifacts' defect class. Before this, `readIntakeArtifacts`
 * read the file through `readOptionalJsonFile<T>`, a bare `JSON.parse(content)
 * as T` assertion with zero runtime shape checking (src/shared/io/json.ts), so
 * a structurally malformed summary — e.g. `ready: "yes"` (a truthy STRING, not
 * a boolean, so `Boolean(summary.ready)` in `isIntakeReady` silently accepted
 * it) or a non-array `goals` — was trusted verbatim. The thrown Error's
 * message becomes the caller's refusal reason: `readIntakeArtifacts` and its
 * callers run inside `runWithBlockedStepBackstop` (src/shared/io/stepContractWriter.ts),
 * which turns any throw into a `blocked` step contract naming the cause
 * verbatim — the mechanism this validation deliberately relies on instead of
 * degrading silently to `undefined` (contrast the sibling clarification-file
 * JSON-parse-failure branch a few lines below, which intentionally DOES
 * degrade to absent because `resolveIntakeStep` re-prompts for it downstream;
 * `intake-summary.json` has no such re-synthesis path, so silence there would
 * strand the run on unvalidated data instead).
 */
export function validateIntakeSummary(raw: unknown, path: string): IntakeSummary {
  const parsed = IntakeSummarySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Malformed intake summary at ${path}: ${issues}. Fix the file to match the ` +
        "IntakeSummary contract (schema_version, ready:boolean, source_type, " +
        "goals/non_goals/constraints:string[], affected_files:{path,reason?}[], " +
        "open_questions:{id,question,category?,blocking?}[]) and rerun next-step.",
    );
  }
  return parsed.data;
}

export function intakePaths(artifactsDir: string): {
  dir: string;
  sourceManifest: string;
  conversationStart: string;
  summary: string;
  clarificationResolution: string;
  brief: string;
  extractedPlan: string;
  intentCheckpoint: string;
  findingsDigest: string;
  findingEnumeration: string;
  riskSignal: string;
} {
  const dir = join(artifactsDir, "intake");
  return {
    dir,
    sourceManifest: join(dir, "source-manifest.json"),
    conversationStart: join(dir, "conversation-start.md"),
    summary: join(dir, "intake-summary.json"),
    clarificationResolution: join(dir, "intake-clarifications.json"),
    brief: join(dir, "remediation-brief.md"),
    extractedPlan: join(artifactsDir, "extracted-plan.json"),
    intentCheckpoint: join(artifactsDir, "intent_checkpoint.json"),
    findingsDigest: join(dir, "findings-digest.json"),
    findingEnumeration: join(dir, "finding-enumeration.json"),
    riskSignal: join(dir, "risk-signal.json"),
  };
}

/**
 * Build a document source manifest from an ordered list of input paths.
 *
 * The paths are the first-wins-deduped UNION of every supplied `--input` (the
 * CLI accumulates repeats into a string[]): duplicates that resolve to the same
 * absolute path collapse to their first occurrence, preserving input order, and
 * the surviving sources get order-stable `input-NN` labels (01, 02, …). Dedup is
 * keyed on the resolved absolute path so `./a.md` and `a.md` (same file) are one
 * source, while distinct files stay distinct.
 */
export function buildDocumentSourceManifest(
  paths: string[],
  createdFrom: IntakeSourceManifest["created_from"],
): IntakeSourceManifest {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths) {
    const key = resolve(path);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: createdFrom,
    sources: deduped.map((path, index) => ({
      type: "document",
      path,
      label: `input-${String(index + 1).padStart(2, "0")}`,
    })),
  };
}

export function buildStructuredAuditSourceManifest(
  path: string,
  createdFrom: IntakeSourceManifest["created_from"],
): IntakeSourceManifest {
  return {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: createdFrom,
    sources: [
      {
        type: "structured_audit",
        path,
        label: "audit-findings",
      },
    ],
  };
}

export function buildConversationSourceManifest(
  conversationPath: string,
): IntakeSourceManifest {
  return {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: "conversation",
    sources: [
      {
        type: "conversation",
        path: conversationPath,
        label: "conversation-start",
      },
    ],
  };
}

/**
 * Build the manifest for a run supplied with BOTH `--input` and `--guidance-file`:
 * the input manifest's sources plus the conversation-start guidance doc. Precedence
 * may order sources, never evict one — the guidance file must be listed or the
 * synthesize_intake worker ("read only the listed source files") never sees it.
 */
export function buildMixedSourceManifest(
  inputSourceManifest: IntakeSourceManifest,
  conversationPath: string,
): IntakeSourceManifest {
  return {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: "mixed",
    sources: [
      ...inputSourceManifest.sources,
      {
        type: "conversation",
        path: conversationPath,
        label: "conversation-start",
      },
    ],
  };
}

/**
 * True when a manifest's source set was fixed by an explicit `--input` — alone
 * (`"input"`) or alongside a guidance file (`"mixed"`). Input-bound manifests are
 * user-chosen: a bare next-step must never re-derive them from default candidates,
 * and re-passing the same `--input` must resume rather than conflict.
 */
export function manifestIsInputBound(manifest: IntakeSourceManifest): boolean {
  return manifest.created_from === "input" || manifest.created_from === "mixed";
}

export function sourceManifestsEquivalent(
  a: IntakeSourceManifest | undefined,
  b: IntakeSourceManifest | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.sources.length !== b.sources.length) return false;
  return a.sources.every((source, index) => {
    const other = b.sources[index];
    return source.type === other.type && source.path === other.path;
  });
}

export function resolveManifestSources(
  root: string,
  manifest: IntakeSourceManifest,
): {
  resolved: IntakeSource[];
  missing: IntakeSource[];
} {
  const resolved: IntakeSource[] = [];
  const missing: IntakeSource[] = [];

  for (const source of manifest.sources) {
    const absolutePath = resolve(root, source.path);
    const normalized = { ...source, path: absolutePath };
    if (existsSync(absolutePath)) {
      resolved.push(normalized);
    } else {
      missing.push(normalized);
    }
  }

  return { resolved, missing };
}

export function blockingIntakeQuestions(
  summary: IntakeSummary | undefined,
): IntakeOpenQuestion[] {
  // INV-remediate-state-06: a question is blocking only when blocking===true.
  // The old `!== false` treated undefined as blocking; this pins the intended
  // semantics so a question with no explicit blocking field is NON-blocking.
  return (summary?.open_questions ?? []).filter(
    (question) => question.blocking === true,
  );
}

export function intakeSummaryContentErrors(summary: IntakeSummary): string[] {
  if (!summary.ready) return [];
  const errors: string[] = [];
  if (summary.goals.length === 0) errors.push("goals must be non-empty");
  // structured_audit sources carry affected_files per finding, so an empty top-level
  // affected_files list is valid for that source type. Only require it for document-based intake.
  if (summary.source_type !== "structured_audit" && summary.affected_files.length === 0) {
    errors.push("affected_files must be non-empty");
  }
  return errors;
}

export function isIntakeReady(summary: IntakeSummary | undefined): boolean {
  return (
    Boolean(summary?.ready) &&
    blockingIntakeQuestions(summary).length === 0 &&
    (summary ? intakeSummaryContentErrors(summary).length === 0 : true)
  );
}

export interface ClarificationValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate the `intake-clarifications.json` file against the IntakeClarifications
 * schema. Returns valid=true when the file is well-formed and addresses at least
 * one blocking question (if blocking questions exist). Returns valid=false with
 * error details when the resolution is malformed or fails to address blocking
 * questions.
 */
export function validateClarificationResolution(
  resolution: unknown,
  blockingQuestions: IntakeOpenQuestion[],
  allQuestions?: IntakeOpenQuestion[],
): ClarificationValidationResult {
  const errors: string[] = [];

  if (!isRecord(resolution)) {
    errors.push("clarification resolution must be a JSON object");
    return { valid: false, errors };
  }

  if (!Array.isArray(resolution.answers)) {
    errors.push("clarification resolution must have an 'answers' array");
    return { valid: false, errors };
  }

  const answers = resolution.answers as unknown[];
  for (let i = 0; i < answers.length; i++) {
    const answer = answers[i];
    if (!isRecord(answer)) {
      errors.push(`answers[${i}] must be an object`);
      continue;
    }
    if (typeof answer.question_id !== "string" || !answer.question_id) {
      errors.push(`answers[${i}] is missing required field 'question_id'`);
    } else if (allQuestions) {
      // Uniform id-join contract: an answer naming an unknown question_id is an
      // ERROR, never silently ignored — a typo'd id would otherwise drop the
      // user's answer while the blocking question it meant stays unanswered.
      const knownIds = new Set(allQuestions.map((q) => q.id));
      if (!knownIds.has(answer.question_id)) {
        errors.push(
          `answers[${i}].question_id "${answer.question_id}" matches no open question. ` +
            `Valid ids: ${[...knownIds].join(", ")}.`,
        );
      }
    }
    if (typeof answer.answer !== "string") {
      errors.push(`answers[${i}] is missing required field 'answer'`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check that at least one blocking question is addressed
  if (blockingQuestions.length > 0) {
    const answeredIds = new Set(
      answers
        .filter(isRecord)
        .map((a) => a.question_id)
        .filter((id): id is string => typeof id === "string"),
    );
    const blockingIds = blockingQuestions.map((q) => q.id);
    const addressedBlocking = blockingIds.filter((id) => answeredIds.has(id));
    if (addressedBlocking.length === 0) {
      errors.push(
        `answers address none of the blocking question ids: ${blockingIds.join(", ")}`,
      );
      return { valid: false, errors };
    }
  }

  return { valid: true, errors: [] };
}

export async function readIntakeArtifacts(
  artifactsDir: string,
): Promise<{
  manifest?: IntakeSourceManifest;
  conversationStart?: string;
  summary?: IntakeSummary;
  clarificationResolution?: unknown;
  brief?: string;
}> {
  const paths = intakePaths(artifactsDir);
  const rawSummary = await readOptionalJsonFile<unknown>(paths.summary);
  return {
    manifest: await readOptionalJsonFile<IntakeSourceManifest>(
      paths.sourceManifest,
    ),
    conversationStart: await readOptionalTextFile(paths.conversationStart),
    // File absent → undefined (no summary yet, not a defect). File present →
    // validated at read time (see validateIntakeSummary); malformed content
    // throws rather than being trusted as a well-formed IntakeSummary.
    summary:
      rawSummary === undefined
        ? undefined
        : validateIntakeSummary(rawSummary, paths.summary),
    clarificationResolution: await (async () => {
      try {
        return await readOptionalJsonFile<unknown>(paths.clarificationResolution);
      } catch {
        // Malformed JSON in the clarification file is treated as absent;
        // validation in resolveIntakeStep will re-emit collect_intake_clarifications.
        return undefined;
      }
    })(),
    brief: await readOptionalTextFile(paths.brief),
  };
}
