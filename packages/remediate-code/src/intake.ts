import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuditFindingsReport, Finding, WorkBlock, FindingSeverity } from "@audit-tools/shared";
import {
  readOptionalJsonFile,
  readOptionalTextFile,
  writeJsonFile,
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
  findingsDigest: string;
  findingEnumeration: string;
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

// ── Content hashing ───────────────────────────────────────────────────────────

/**
 * Compute a short SHA-256 hex digest for the given content string.
 * Used as the content-hash key for idempotent source registration (INV-ID-04).
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

// ── Conversation source auto-registration ─────────────────────────────────────

/**
 * Registration record written into the source manifest for an auto-discovered
 * intake/*.md conversation file (INV-ID-07, INV-ID-04).
 */
export interface ConversationSourceRecord {
  path: string;
  content_hash: string;
}

/**
 * Scan `<intakeDir>` for `conversation-start.md` and any other `*.md` files,
 * then return IntakeSource entries for any that are not already registered
 * (keyed by path + content-hash, INV-ID-04).
 *
 * REGISTRATION-ONLY: this function reads file contents only to compute hashes;
 * it never writes or creates the .md files (INV-ID-07).
 *
 * Returns the new sources to add. Callers must merge them into the manifest and
 * persist; this function does not mutate any persisted state.
 */
export async function scanConversationSources(
  intakeDir: string,
  existingRecords: ConversationSourceRecord[],
): Promise<{ sources: IntakeSource[]; records: ConversationSourceRecord[] }> {
  const { readFile } = await import("node:fs/promises");
  const candidates: string[] = [];

  // Always check conversation-start.md first.
  const conversationStart = join(intakeDir, "conversation-start.md");
  if (existsSync(conversationStart)) {
    candidates.push(conversationStart);
  }

  // Scan for other *.md files in the intake dir.
  if (existsSync(intakeDir)) {
    try {
      const entries = await readdir(intakeDir);
      for (const entry of entries) {
        if (
          entry.endsWith(".md") &&
          entry !== "conversation-start.md" &&
          entry !== "remediation-brief.md"
        ) {
          candidates.push(join(intakeDir, entry));
        }
      }
    } catch {
      // directory unreadable — skip
    }
  }

  const existingByPath = new Map(existingRecords.map((r) => [r.path, r.content_hash]));
  const newSources: IntakeSource[] = [];
  const newRecords: ConversationSourceRecord[] = [];

  for (const candidatePath of candidates) {
    let content: string;
    try {
      content = await readFile(candidatePath, "utf8");
    } catch {
      continue;
    }
    const hash = computeContentHash(content);
    const existing = existingByPath.get(candidatePath);
    if (existing === hash) {
      // Already registered with same content — skip (INV-ID-04 idempotency).
      continue;
    }
    // New or content-changed: register (replace keyed on path).
    const isConvStart = candidatePath.endsWith("conversation-start.md");
    newSources.push({
      type: "conversation",
      path: candidatePath,
      label: isConvStart ? "conversation-start" : `intake-${candidatePath.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "doc"}`,
    });
    newRecords.push({ path: candidatePath, content_hash: hash });
  }

  return { sources: newSources, records: newRecords };
}

// ── Findings digest + enumeration ─────────────────────────────────────────────

export const FINDINGS_DIGEST_SCHEMA_VERSION =
  "remediate-code-intake-findings-digest/v1alpha1" as const;

export const FINDING_ENUMERATION_SCHEMA_VERSION =
  "remediate-code-intake-finding-enumeration/v1alpha1" as const;

/** Maximum number of findings surfaced verbatim in the bounded digest. */
const DIGEST_TOP_N = 20;

export interface FindingDigestEntry {
  id: string;
  title: string;
  severity: FindingSeverity;
  lens: string;
  /** First affected file path (representative). */
  file?: string;
}

export interface FindingsDigest {
  schema_version: typeof FINDINGS_DIGEST_SCHEMA_VERSION;
  total_count: number;
  severity_counts: Record<string, number>;
  lens_counts: Record<string, number>;
  /** Counts by first-listed package/directory (top-level path segment). */
  package_counts: Record<string, number>;
  /** Work-block map: block id → finding ids. */
  work_block_map: Record<string, string[]>;
  top_findings: FindingDigestEntry[];
  omitted_count: number;
}

export interface FindingEnumerationEntry {
  id: string;
  title: string;
  severity: FindingSeverity;
  lens: string;
  /** First affected file path. */
  file?: string;
  summary: string;
}

/** Complete enumeration of all findings for enumerable sources. */
export interface FindingEnumeration {
  schema_version: typeof FINDING_ENUMERATION_SCHEMA_VERSION;
  total_count: number;
  findings: FindingEnumerationEntry[];
}

/** Marker emitted for document/non-enumerable sources. */
export interface NonEnumerableMarker {
  is_enumerable: false;
  reason: string;
}

/**
 * Build the bounded `FindingsDigest` from an AuditFindingsReport.
 *
 * The digest is bounded (top-N + omitted_count) so it fits cleanly in prompt
 * context; the complete enumeration is in `finding-enumeration.json`.
 */
export function buildFindingsDigest(report: AuditFindingsReport): FindingsDigest {
  const findings: Finding[] = report.findings ?? [];
  const workBlocks: WorkBlock[] = report.work_blocks ?? [];

  const severity_counts: Record<string, number> = {};
  const lens_counts: Record<string, number> = {};
  const package_counts: Record<string, number> = {};

  for (const f of findings) {
    severity_counts[f.severity] = (severity_counts[f.severity] ?? 0) + 1;
    lens_counts[f.lens] = (lens_counts[f.lens] ?? 0) + 1;
    const firstFile = f.affected_files?.[0]?.path ?? "";
    const pkg = firstFile.split(/[\\/]/)[0] ?? "(root)";
    package_counts[pkg] = (package_counts[pkg] ?? 0) + 1;
  }

  // Sort by severity priority for top-N selection.
  const severityOrder: Record<string, number> = {
    critical: 0, high: 1, medium: 2, low: 3, info: 4,
  };
  const sorted = [...findings].sort(
    (a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5),
  );

  const top_findings: FindingDigestEntry[] = sorted.slice(0, DIGEST_TOP_N).map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    lens: f.lens,
    file: f.affected_files?.[0]?.path,
  }));

  const work_block_map: Record<string, string[]> = {};
  for (const wb of workBlocks) {
    work_block_map[wb.id] = wb.finding_ids ?? [];
  }

  return {
    schema_version: FINDINGS_DIGEST_SCHEMA_VERSION,
    total_count: findings.length,
    severity_counts,
    lens_counts,
    package_counts,
    work_block_map,
    top_findings,
    omitted_count: Math.max(0, findings.length - DIGEST_TOP_N),
  };
}

/**
 * Build the complete `FindingEnumeration` from an AuditFindingsReport.
 * Every finding id and compact descriptor is included — no omission.
 */
export function buildFindingEnumeration(report: AuditFindingsReport): FindingEnumeration {
  const findings: Finding[] = report.findings ?? [];
  return {
    schema_version: FINDING_ENUMERATION_SCHEMA_VERSION,
    total_count: findings.length,
    findings: findings.map((f) => ({
      id: f.id,
      title: f.title,
      severity: f.severity,
      lens: f.lens,
      file: f.affected_files?.[0]?.path,
      summary: f.summary,
    })),
  };
}

/**
 * Persist `findings-digest.json` + `finding-enumeration.json` for an
 * enumerable (structured_audit) source, or `{ is_enumerable: false }` for a
 * document source (INV-ID-08).
 *
 * Content-hash keyed idempotency: if the digest already exists with the same
 * total_count and the same content_hash of the source report, skips the write.
 */
export async function writeIntakeDigestArtifacts(
  paths: ReturnType<typeof intakePaths>,
  report: AuditFindingsReport | null,
): Promise<void> {
  if (report === null) {
    // Document / non-enumerable source.
    const marker: NonEnumerableMarker = {
      is_enumerable: false,
      reason: "source is a document or conversation, not a structured audit report",
    };
    await writeJsonFile(paths.findingsDigest, marker);
    await writeJsonFile(paths.findingEnumeration, marker);
    return;
  }

  const digest = buildFindingsDigest(report);
  const enumeration = buildFindingEnumeration(report);
  await writeJsonFile(paths.findingsDigest, digest);
  await writeJsonFile(paths.findingEnumeration, enumeration);
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
