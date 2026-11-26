import { z } from "zod";
import { hashContent, stableStringify } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { incompleteAnalyzerStatuses } from "./acquisitionExecutor.js";

const explanation = z.string().trim().min(1).max(2000);
export const AnalyzerCalibrationSchema = z.strictObject({
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  decisions: z.array(z.strictObject({
    tool: z.string().min(1),
    action: z.enum(["accept", "retry", "limited"]),
    reason: explanation,
    coverage: explanation,
  })).max(100),
  unresolved: z.array(explanation).max(100),
});

export function analyzerCalibrationRequest(bundle: ArtifactBundle, selection: unknown) {
  const incomplete = new Set(incompleteAnalyzerStatuses(bundle).map(row => row.tool));
  const statuses = bundle.external_analyzer_acquisition?.tool_statuses.filter(row => row.status !== "skipped") ?? [];
  const admitted = new Set(bundle.file_disposition?.files.filter(file => file.status === "included").map(file => file.path));
  const tools = statuses.map(row => {
    const admittedSkipped = row.reported_coverage?.skipped.filter(path => admitted.has(path)) ?? [];
    return { ...row, admittedSkipped, incomplete: incomplete.has(row.tool) || admittedSkipped.length > 0,
      findings: bundle.external_analyzer_results?.find(entry => entry.tool === row.tool)?.results.length ?? 0 };
  });
  const input_sha256 = hashContent(stableStringify({
    manifest: bundle.repo_manifest?.files, disposition: bundle.file_disposition?.files,
    acquisition: bundle.external_analyzer_acquisition, results: bundle.external_analyzer_results, selection,
  }));
  return { input_sha256, tools };
}

export type AnalyzerCalibrationRequest = ReturnType<typeof analyzerCalibrationRequest>;

export function currentAnalyzerCalibration(value: unknown, request: AnalyzerCalibrationRequest) {
  const answer = AnalyzerCalibrationSchema.safeParse(value);
  if (!answer.success || answer.data.input_sha256 !== request.input_sha256) return;
  const byId = new Map(answer.data.decisions.map(row => [row.tool, row]));
  if (byId.size !== answer.data.decisions.length || byId.size !== request.tools.length) return;
  if (!request.tools.every(tool => byId.has(tool.tool) &&
      (!tool.incomplete || byId.get(tool.tool)?.action !== "accept"))) return;
  return answer.data;
}
