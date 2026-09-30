// sites-pinned: tests/audit/audit-frontier.test.ts
import { hashContent, stableStringify, findingReEmissionKey } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditTask, Finding } from "../types.js";
import { DEEPENING_TAG, taskIdFor, sanitizeSegment } from "./selectiveDeepening/shared.js";
import { computeStaleResultTaskIds } from "./resultBaseline.js";
import { selectCurrentResults } from "./ledger.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { resolveIntentLensSelection } from "./lensSelection.js";
import { lineCountForPath } from "./lineCounts.js";

const ARCHITECTURE_DISCOVERY_TAG = "architecture_discovery";
const QUESTION_DEPENDENCY_TAG = "requires_question:";

/** Evidence-gathering is independent of unresolved interpretation questions. */
export function inspectionTaskHeld(task: AuditTask, bundle: ArtifactBundle): boolean {
  const unanswered = new Set((bundle.charter_clarification?.asked ?? [])
    .filter((question) => question.answer === undefined).map((question) => question.request_id));
  return (task.tags ?? []).some((tag) => tag.startsWith(QUESTION_DEPENDENCY_TAG) &&
    unanswered.has(tag.slice(QUESTION_DEPENDENCY_TAG.length)));
}

/** Current accepted discoveries may originate in any work family. Semantic identity prevents echoes. */
function inspectionDiscoveries(bundle: Pick<ArtifactBundle, "audit_tasks" | "audit_results" | "artifact_metadata">): Finding[] {
  const results = selectCurrentResults(bundle.audit_results ?? []);
  const stale = computeStaleResultTaskIds(results, bundle.audit_tasks ?? [], bundle.artifact_metadata?.result_baselines);
  return results.filter((result) => !stale.has(result.task_id))
    .flatMap((result) => result.findings)
    .filter((finding) => finding.verification_status !== "refuted_at_head")
    .sort((a, b) => compareCodeUnits(a.id, b.id));
}

function architectureDiscoveryKey(finding: Finding): string {
  return hashContent(stableStringify({ identity: findingReEmissionKey(finding),
    paths: [...new Set(finding.affected_files.map((file) => file.path))].sort() }), { length: 16 });
}

/** Reuse the same already-bound verification question; never rewrite an issued task. */
function existingFindingFollowups(bundle: ArtifactBundle): Map<string, AuditTask> {
  const candidates = new Map<string, AuditTask>();
  const coordinate = (source: string, finding: string, lens: string, paths: readonly string[]) =>
    stableStringify([source, finding, lens, [...paths].sort()]);
  const hashes = new Map((bundle.repo_manifest?.files ?? []).map((file) => [file.path, file.hash ?? "unversioned"]));
  for (const task of bundle.audit_tasks ?? []) {
    const source = task.tags?.find((tag) => tag.startsWith("source_task:"));
    const finding = task.tags?.find((tag) => tag.startsWith("finding:"));
    if (source && finding && task.tags?.includes(DEEPENING_TAG) &&
        task.file_paths.every((path) => task.inputs?.[`source:${path}`] === hashes.get(path))) {
      candidates.set(coordinate(source, finding, task.lens, task.file_paths), task);
    }
  }
  const byDiscovery = new Map<string, AuditTask>();
  for (const result of selectCurrentResults(bundle.audit_results ?? [])) {
    for (const finding of result.findings) {
      const task = candidates.get(coordinate(`source_task:${sanitizeSegment(result.task_id)}`,
        `finding:${sanitizeSegment(finding.id)}`, finding.lens,
        [...new Set(finding.affected_files.map((file) => file.path))]));
      if (task) byDiscovery.set(architectureDiscoveryKey(finding), task);
    }
  }
  return byDiscovery;
}

/** Concrete unverified discoveries earn bounded follow-up, never another full audit. */
export function architectureDiscoveryTasks(bundle: ArtifactBundle, lineIndex: Record<string, number> = {}): AuditTask[] {
  const selected = resolveIntentLensSelection(bundle.intent_checkpoint?.lens_selection);
  const allowsLens = (lens: string) => selected === undefined || selected.includes(lens);
  const sourceHashes = new Map((bundle.repo_manifest?.files ?? []).map((file) => [file.path, file.hash ?? "unversioned"]));
  const admitted = new Set(sourceHashes.keys());
  const coverage = new Map((bundle.coverage_matrix?.files ?? []).map((file) => [file.path, file]));
  const inScope = (path: string): boolean => admitted.has(path) && coverage.get(path)?.audit_status !== "excluded" &&
    !(bundle.intent_checkpoint?.excluded_scope ?? []).some((entry) => path === entry.path || path.startsWith(`${entry.path.replace(/\/$/, "")}/`));
  const findings = [
    ...(bundle.design_assessment?.contract_findings ?? []),
    ...(bundle.design_assessment?.conceptual_findings ?? []),
    ...(bundle.charter_register?.findings ?? []),
    ...(bundle.systemic_challenge?.findings ?? []),
    ...inspectionDiscoveries(bundle).filter((finding) => finding.systemic === true ||
      new Set(finding.affected_files.map((file) => file.path)).size > 1),
  ];
  const tasks = new Map<string, AuditTask>();
  const existingFollowups = existingFindingFollowups(bundle);
  const existingDiscoveryIds = new Set((bundle.audit_tasks ?? []).filter(isArchitectureDiscoveryTask).map((task) => task.task_id));
  const make = (id: string, paths: string[], lens: string, rationale: string, tags: string[]): AuditTask => ({
    task_id: id, unit_id: `discovery:${id}`, pass_id: "deepening:architecture", lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(paths.map((path) => [path, lineCountForPath(path, { lineIndex })])),
    inputs: Object.fromEntries(paths.map((path) => [`source:${path}`, sourceHashes.get(path) ?? "unversioned"])),
    rationale, priority: "high", status: "pending", tags: [DEEPENING_TAG, ARCHITECTURE_DISCOVERY_TAG, ...tags],
  });
  for (const finding of findings) {
    if (!allowsLens(finding.lens)) continue;
    if (finding.verification_status === "judge_confirmed" || finding.verification_status === "refuted_at_head") continue;
    if (finding.severity !== "critical" && finding.severity !== "high" && finding.confidence !== "low") continue;
    const paths = [...new Set(finding.affected_files.map((location) => location.path).filter(inScope))].sort();
    if (paths.length === 0) continue;
    const signature = architectureDiscoveryKey(finding);
    const id = taskIdFor("architecture", [signature]);
    if (tasks.has(id)) continue;
    if (!existingDiscoveryIds.has(id) && existingFollowups.has(signature)) continue;
    tasks.set(id, make(id, paths, finding.lens,
      `Independently investigate architectural discovery ${finding.id}: ${finding.title}. ${finding.summary}\n` +
      "You must be independent of the source finding author. Verify the claim against these sources and counterexamples, examine the implicated cross-system assumptions and boundaries, and report whether it stands, narrows, or is refuted. Cite the source finding in related_findings. Do not assume the discovery is correct.",
      [`discovery:${signature}`]));
  }
  for (const question of bundle.charter_clarification?.asked ?? []) {
    if (!allowsLens("architecture")) continue;
    if (question.answer === "leave_open") continue;
    const difference = bundle.charter_register?.differences.find((item) => item.difference_id === question.difference_id);
    const correspondence = bundle.charter_register?.correspondences.find((item) => item.correspondence_id === difference?.correspondence_id);
    const paths = [...new Set((correspondence?.members ?? []).flatMap((member) =>
      bundle.charter_register?.lanes.find((lane) => lane.kind === member.kind)?.nodes
        .filter((node) => member.node_ids.includes(node.node_id)).flatMap((node) => node.files ?? []) ?? []).filter(inScope))].sort();
    if (paths.length === 0) continue;
    const id = taskIdFor("charter-question", [question.request_id, ...paths]);
    const resolution = question.answer === undefined
      ? "Awaiting the operator; this interpretation-dependent task is held."
      : question.answer === "rewrite_all"
        ? "The operator rejected all offered accounts. Re-examine the sources and report remaining uncertainty; do not invent a governing intent."
        : `The operator selected ${stableStringify(question.answer)}.`;
    tasks.set(id, make(id, paths, "architecture",
      `Investigate this intent question against the implementation: ${question.question}\nAccounts: ${stableStringify(question.accounts)}\n${resolution}`,
      [`${QUESTION_DEPENDENCY_TAG}${question.request_id}`]));
  }
  return [...tasks.values()].sort((a, b) => compareCodeUnits(a.task_id, b.task_id));
}

export function isArchitectureDiscoveryTask(task: AuditTask): boolean {
  return task.tags?.includes(ARCHITECTURE_DISCOVERY_TAG) ?? false;
}

export function architectureDiscoveryWorkChanged(bundle: ArtifactBundle): boolean {
  if (!bundle.audit_tasks) return false;
  const current = bundle.audit_tasks.filter(isArchitectureDiscoveryTask);
  const desired = architectureDiscoveryTasks(bundle);
  const project = (tasks: AuditTask[]) => tasks.map((task) => ({ id: task.task_id, paths: task.file_paths, inputs: task.inputs, rationale: task.rationale })).sort((a, b) => compareCodeUnits(a.id, b.id));
  return stableStringify(project(current)) !== stableStringify(project(desired));
}

/** Join current independent evidence without pretending an empty result refutes a claim. */
export function withArchitectureFollowupEvidence(bundle: ArtifactBundle): ArtifactBundle {
  const tasks = new Map((bundle.audit_tasks ?? []).map((task) => [task.task_id, task]));
  const results = selectCurrentResults(bundle.audit_results ?? []);
  const baselines = bundle.artifact_metadata?.result_baselines;
  const stale = computeStaleResultTaskIds(results, bundle.audit_tasks ?? [], baselines);
  const hashes = new Map((bundle.repo_manifest?.files ?? []).map((file) => [file.path, file.hash]));
  const current = new Map(results.filter((result) => {
    const task = tasks.get(result.task_id);
    return task && task.tags?.includes(DEEPENING_TAG) && !stale.has(result.task_id) &&
      result.idempotency_key !== undefined && baselines?.[result.idempotency_key] !== undefined &&
      task.file_paths.every((path) => hashes.get(path) !== undefined && task.inputs?.[`source:${path}`] === hashes.get(path));
  }).map((result) => [result.task_id, result]));
  const existingFollowups = existingFindingFollowups(bundle);
  const attach = (finding: Finding): Finding => {
    const key = architectureDiscoveryKey(finding);
    const result = current.get(taskIdFor("architecture", [key])) ??
      current.get(existingFollowups.get(key)?.task_id ?? "");
    if (!result) return finding;
    const account = result.findings.length > 0
      ? JSON.stringify(result.findings)
      : "No additional finding reported; this is inconclusive about the source claim and is not a refutation.";
    return {
      ...finding,
      verification_status: finding.verification_status ?? "asserted",
      evidence: [...new Set([...(finding.evidence ?? []),
        `Independent follow-up ${result.task_id}: ${account} Treat disagreement as unresolved evidence; no semantic resolution is inferred by the tool.`])],
    };
  };
  return {
    ...bundle,
    audit_results: results.map((result) => ({ ...result, findings: result.findings.map(attach) })),
    ...(bundle.design_assessment ? { design_assessment: {
      ...bundle.design_assessment,
      contract_findings: bundle.design_assessment.contract_findings?.map(attach),
      conceptual_findings: bundle.design_assessment.conceptual_findings?.map(attach),
    } } : {}),
    ...(bundle.charter_register ? { charter_register: { ...bundle.charter_register, findings: bundle.charter_register.findings.map(attach) } } : {}),
    ...(bundle.systemic_challenge ? { systemic_challenge: { ...bundle.systemic_challenge, findings: bundle.systemic_challenge.findings.map(attach) } } : {}),
  };
}
