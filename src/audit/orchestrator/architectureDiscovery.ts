// sites-pinned: tests/audit/audit-frontier.test.ts, tests/audit/intent-checkpoint.test.ts
import { hashContent, stableStringify, findingReEmissionKey, pathMatchesPrefix } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditResult, AuditTask, Finding } from "../types.js";
import { uniqueSorted } from "audit-tools/shared";
import { DEEPENING_TAG, taskIdFor, sanitizeSegment } from "./selectiveDeepening/shared.js";
import { computeStaleResultTaskIds } from "./resultBaseline.js";
import { selectCurrentResults } from "./ledger.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { resolveIntentLensSelection } from "./lensSelection.js";
import { lineCountForPath } from "./lineCounts.js";

const ARCHITECTURE_DISCOVERY_TAG = "architecture_discovery";
const ARCHITECTURE_SAMPLE_TAG = "architecture_source_sample";
const ARCHITECTURE_SAMPLE_ID = "architecture-sample";
const MAX_SAMPLE_FILES = 4;
const MAX_SAMPLE_BYTES = 64 * 1024;

const QUESTION_DEPENDENCY_TAG = "requires_question:";

/**
 * Evidence-gathering is independent of unresolved interpretation questions.
 * Returns the held-task test for one bundle, so the unanswered-question set is
 * built once per partition rather than once per task.
 */
export function inspectionTaskHeldIn(bundle: ArtifactBundle): (task: AuditTask) => boolean {
  const unanswered = new Set((bundle.charter_clarification?.asked ?? [])
    .filter((question) => question.answer === undefined).map((question) => question.request_id));
  return (task) => (task.tags ?? []).some((tag) => tag.startsWith(QUESTION_DEPENDENCY_TAG) &&
    unanswered.has(tag.slice(QUESTION_DEPENDENCY_TAG.length)));
}

/** Current accepted discoveries may originate in any work family. Semantic identity prevents echoes. */
function inspectionDiscoveries(
  bundle: Pick<ArtifactBundle, "audit_tasks" | "artifact_metadata">,
  results: AuditResult[],
): Finding[] {
  const stale = computeStaleResultTaskIds(results, bundle.audit_tasks ?? [], bundle.artifact_metadata?.result_baselines);
  return results.filter((result) => !stale.has(result.task_id))
    .flatMap((result) => result.findings)
    .filter((finding) => finding.verification_status !== "refuted_at_head")
    .sort((a, b) => compareCodeUnits(a.id, b.id));
}

function architectureDiscoveryKey(finding: Finding): string {
  return hashContent(stableStringify({ identity: findingReEmissionKey(finding),
    paths: uniqueSorted(finding.affected_files.map((file) => file.path)) }), { length: 16 });
}

/** Reuse the same already-bound verification question; never rewrite an issued task. */
function existingFindingFollowups(bundle: ArtifactBundle, currentResults: AuditResult[]): Map<string, AuditTask> {
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
  for (const result of currentResults) {
    for (const finding of result.findings) {
      const task = candidates.get(coordinate(`source_task:${sanitizeSegment(result.task_id)}`,
        `finding:${sanitizeSegment(finding.id)}`, finding.lens,
        [...new Set(finding.affected_files.map((file) => file.path))]));
      if (task) byDiscovery.set(architectureDiscoveryKey(finding), task);
    }
  }
  return byDiscovery;
}

/**
 * The sorted files a clarification question's charter difference spans: the
 * register lane nodes its correspondence's members name. The only part of the
 * register's differences, correspondences and lanes discovery reads — shared
 * with the audit_tasks.json slice projection (dependencySlices.ts).
 */
export function charterQuestionFiles(bundle: Pick<ArtifactBundle, "charter_register">, differenceId: string): string[] {
  const register = bundle.charter_register;
  const difference = register?.differences.find((item) => item.difference_id === differenceId);
  const correspondence = register?.correspondences.find((item) => item.correspondence_id === difference?.correspondence_id);
  return uniqueSorted((correspondence?.members ?? []).flatMap((member) =>
    register?.lanes.find((lane) => lane.kind === member.kind)?.nodes
      .filter((node) => member.node_ids.includes(node.node_id)).flatMap((node) => node.files ?? []) ?? []));
}

/** One real workflow spanning units, not the same review applied to every file. */
function selectArchitectureSample(bundle: ArtifactBundle, inScope: (path: string) => boolean) {
  const scope = bundle.scope?.mode === "delta" ? new Set([...bundle.scope.seed_files, ...bundle.scope.expanded_files]) : undefined;
  const disposition = new Map(bundle.file_disposition?.files.map((file) => [file.path, file.status]));
  const files = new Map(bundle.repo_manifest?.files.map((file) => [file.path, file]));
  const owners = new Map<string, string>();
  const risks = new Map<string, number>();
  for (const unit of [...(bundle.unit_manifest?.units ?? [])].sort((a, b) => compareCodeUnits(a.unit_id, b.unit_id))) {
    risks.set(unit.unit_id, unit.risk_score ?? 0);
    for (const path of unit.files) if (!owners.has(path)) owners.set(path, unit.unit_id);
  }
  const risk = (path: string) => risks.get(owners.get(path) ?? "") ?? 0;
  const entryRisk = (paths: readonly string[]) => paths.reduce((max, path) => Math.max(max, risk(path)), 0);
  const flows = [...(bundle.critical_flows?.flows ?? [])].sort((a, b) =>
    Number(b.confidence === "high") - Number(a.confidence === "high") ||
    entryRisk(b.entrypoints) - entryRisk(a.entrypoints) || compareCodeUnits(a.id, b.id));
  for (const flow of flows) {
    const paths: string[] = [];
    const crossing = new Set<string>();
    let bytes = 0;
    const ordered = [...uniqueSorted(flow.entrypoints), ...uniqueSorted(flow.paths)];
    for (const path of ordered) {
      const file = files.get(path);
      const owner = owners.get(path);
      const override = bundle.intent_checkpoint?.disposition_overrides?.find((entry) => pathMatchesPrefix(path, entry.path));
      if (!file?.hash || file.size_bytes <= 0 || bytes + file.size_bytes > MAX_SAMPLE_BYTES ||
          !owner || crossing.has(owner) || !inScope(path) || (scope && !scope.has(path)) ||
          (override?.status ?? disposition.get(path)) !== "included") continue;
      crossing.add(owner);
      paths.push(path);
      bytes += file.size_bytes;
      if (paths.length === MAX_SAMPLE_FILES) break;
    }
    // A non-entry slice cannot establish how the workflow crosses its first boundary.
    if (paths.length >= 2 && paths.some((path) => flow.entrypoints.includes(path))) {
      return { flow, paths, components: [...crossing] };
    }
  }
  return undefined;
}

/** Concrete unverified discoveries earn bounded follow-up, never another full audit. */
export function architectureDiscoveryTasks(bundle: ArtifactBundle, lineIndex: Record<string, number> = {}): AuditTask[] {
  const selected = resolveIntentLensSelection(bundle.intent_checkpoint?.lens_selection);
  const allowsLens = (lens: string) => selected === undefined || selected.includes(lens);
  const currentResults = selectCurrentResults(bundle.audit_results ?? []);
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
    ...inspectionDiscoveries(bundle, currentResults).filter((finding) => finding.systemic === true ||
      new Set(finding.affected_files.map((file) => file.path)).size > 1),
  ];
  const tasks = new Map<string, AuditTask>();
  const existingFollowups = existingFindingFollowups(bundle, currentResults);
  const existingDiscoveryIds = new Set((bundle.audit_tasks ?? []).filter(isArchitectureDiscoveryTask).map((task) => task.task_id));
  const make = (id: string, paths: string[], lens: string, rationale: string, tags: string[]): AuditTask => ({
    task_id: id, unit_id: `discovery:${id}`, pass_id: "deepening:architecture", lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(paths.map((path) => [path, lineCountForPath(path, { lineIndex })])),
    inputs: Object.fromEntries(paths.map((path) => [`source:${path}`, sourceHashes.get(path) ?? "unversioned"])),
    rationale, priority: "high", status: "pending", tags: [DEEPENING_TAG, ARCHITECTURE_DISCOVERY_TAG, ...tags],
  });
  if (bundle.intent_checkpoint?.lens_selection?.include?.includes("architecture") && allowsLens("architecture")) {
    const sample = selectArchitectureSample(bundle, inScope);
    if (sample) {
      const { flow, paths, components } = sample;
      const id = taskIdFor(ARCHITECTURE_SAMPLE_ID, [flow.id, ...paths]);
      const task = make(id, paths, "architecture",
        `Trace this bounded source sample of the ${flow.name.slice(0, 160)} workflow across its component boundaries. ` +
        `Entry points: ${flow.entrypoints.filter((path) => paths.includes(path)).join(", ")}. ` +
        `Components: ${components.map((component) => component.slice(0, 100)).join(", ")}. ` +
        `Recorded concerns: ${flow.concerns.join("; ").slice(0, 400) || "none"}. ` +
        "Use the frozen source to trace the user contract, responsibility for state and decisions, and the observable hand-off. " +
        "Distinguish upstream-owned behavior and uninspected callers from evidence in this sample. " +
        "Only report source-anchored architecture findings; an empty result applies to this sample, not to the entire repository.",
        [ARCHITECTURE_SAMPLE_TAG]);
      tasks.set(id, { ...task, coverage_policy: "complete" });
    }
  }
  for (const finding of findings) {
    if (!allowsLens(finding.lens)) continue;
    if (finding.verification_status === "judge_confirmed" || finding.verification_status === "refuted_at_head") continue;
    if (finding.severity !== "critical" && finding.severity !== "high" && finding.confidence !== "low") continue;
    const paths = uniqueSorted(finding.affected_files.map((location) => location.path).filter(inScope));
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
    const paths = charterQuestionFiles(bundle, question.difference_id).filter(inScope);
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

/**
 * Re-derive the discovery family inside `bundle.audit_tasks` for a producer that
 * rewrites audit_tasks.json without replanning (result ingestion). The DAG stamps
 * that write against the current discovery inputs, so the family must be current
 * when it lands: an issued task whose derivation is unchanged is kept as issued
 * (status, estimates), a new one is added, a retired one is dropped.
 */
export function reconcileArchitectureDiscoveryTasks(bundle: ArtifactBundle, lineIndex: Record<string, number> = {}): AuditTask[] {
  const tasks = bundle.audit_tasks ?? [];
  const derivation = (task: AuditTask) => stableStringify({
    paths: task.file_paths, inputs: task.inputs, rationale: task.rationale, coverage_policy: task.coverage_policy,
  });
  const issued = new Map(tasks.filter(isArchitectureDiscoveryTask).map((task) => [task.task_id, task]));
  const discovery = architectureDiscoveryTasks(bundle, lineIndex).map((task) => {
    const existing = issued.get(task.task_id);
    return existing && derivation(existing) === derivation(task) ? existing : task;
  });
  return [...tasks.filter((task) => !isArchitectureDiscoveryTask(task)), ...discovery];
}
