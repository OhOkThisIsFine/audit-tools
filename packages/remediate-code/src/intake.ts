import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readOptionalJsonFile,
  readOptionalTextFile,
  isRecord,
} from "@audit-tools/shared";

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

export interface IntakeOpenQuestion {
  id: string;
  question: string;
  category?: string;
  blocking?: boolean;
}

export interface IntakeSummary {
  schema_version: typeof INTAKE_SUMMARY_SCHEMA_VERSION;
  ready: boolean;
  source_type: "structured_audit" | "documents" | "conversation" | "mixed";
  goals: string[];
  non_goals: string[];
  constraints: string[];
  affected_files: { path: string; reason?: string }[];
  open_questions: IntakeOpenQuestion[];
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
  };
}

export function buildDocumentSourceManifest(
  paths: string[],
  createdFrom: IntakeSourceManifest["created_from"],
): IntakeSourceManifest {
  return {
    schema_version: INTAKE_SOURCE_MANIFEST_SCHEMA_VERSION,
    created_from: createdFrom,
    sources: paths.map((path, index) => ({
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
  return {
    manifest: await readOptionalJsonFile<IntakeSourceManifest>(
      paths.sourceManifest,
    ),
    conversationStart: await readOptionalTextFile(paths.conversationStart),
    summary: await readOptionalJsonFile<IntakeSummary>(paths.summary),
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
