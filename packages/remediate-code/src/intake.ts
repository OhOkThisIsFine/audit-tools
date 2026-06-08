import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readOptionalJsonFile,
  readOptionalTextFile,
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
  return (summary?.open_questions ?? []).filter(
    (question) => question.blocking !== false,
  );
}

export function isIntakeReady(summary: IntakeSummary | undefined): boolean {
  return Boolean(summary?.ready) && blockingIntakeQuestions(summary).length === 0;
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
    clarificationResolution: await readOptionalJsonFile<unknown>(
      paths.clarificationResolution,
    ),
    brief: await readOptionalTextFile(paths.brief),
  };
}
