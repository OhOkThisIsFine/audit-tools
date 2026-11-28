// sites-pinned: tests/audit/analyzer-selection.test.ts
import { z } from "zod";
import { EXTERNAL_ANALYZER_CANDIDATES, hashContent, stableStringify } from "audit-tools/shared";
import type { AnalyzerSetting } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { analyzerSelectionContext } from "./acquisitionExecutor.js";

const rationale = z.string().trim().min(1).max(2000);
const localPath = z.string().min(1).max(4096);
export const runtimeOverrideFields = {
  existing_executable: localPath.optional(),
  local_rules: localPath.optional(),
};
export function validRuntimeOverride(row: { tool: string; existing_executable?: string; local_rules?: string }, runnable: boolean) {
  if (row.existing_executable === undefined) return row.local_rules === undefined;
  return runnable && (row.local_rules === undefined || row.tool === "semgrep");
}
export function analyzerRuntimeOverrides(rows: readonly {
  tool: string; existing_executable?: string; local_rules?: string;
}[]) {
  return Object.fromEntries(rows.flatMap(({ tool, existing_executable, local_rules }) =>
    existing_executable ? [[tool, { executable: existing_executable, localRules: local_rules }] as const] : []));
}
export const AnalyzerSelectionSchema = z.strictObject({
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  decisions: z.array(z.strictObject({
    tool: z.string().min(1), action: z.enum(["run", "omit"]), reason: rationale, ...runtimeOverrideFields,
  })).max(100),
  additional_checks: z.array(z.strictObject({ tool: rationale, scope: rationale, reason: rationale })).max(30),
  gaps: z.array(rationale).max(50),
});

export function analyzerSelectionRequest(bundle: ArtifactBundle, sourceRoot: string, policy: Record<string, AnalyzerSetting> = {}) {
  const inventory = analyzerSelectionContext(bundle);
  const candidates = EXTERNAL_ANALYZER_CANDIDATES.filter(candidate => {
    if (policy[candidate.id] === "skip") return false;
    try { return candidate.detect(sourceRoot); } catch { return false; }
  }).map(({ id, purpose, defaultRun }) => ({ id, purpose, consent_required: !defaultRun }));
  const input_sha256 = hashContent(stableStringify({
    files: bundle.repo_manifest?.files, disposition: bundle.file_disposition?.files, candidates, policy,
  }));
  return { input_sha256, inventory, candidates };
}

export type AnalyzerSelectionRequest = ReturnType<typeof analyzerSelectionRequest>;

export function currentAnalyzerSelection(value: unknown, request: AnalyzerSelectionRequest) {
  const answer = AnalyzerSelectionSchema.safeParse(value);
  if (!answer.success || answer.data.input_sha256 !== request.input_sha256) return;
  const actual = new Set(answer.data.decisions.map(row => row.tool));
  if (answer.data.decisions.some(row => !validRuntimeOverride(row, row.action === "run")) ||
      actual.size !== answer.data.decisions.length || actual.size !== request.candidates.length ||
      request.candidates.some(candidate => !actual.has(candidate.id))) return;
  return answer.data;
}
