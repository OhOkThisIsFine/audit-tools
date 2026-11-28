import { compareCodeUnits, hashContent, stableStringify } from "audit-tools/shared";
import type { ReviewAcceptedAnswer, ReviewLens, ReviewPlan } from "../../shared/types/reviewQuestion.js";

const PACK_SIZE = 8;
export const FILE_INSPECTION_PREFIX = "full-file-inspection:";
// Colons cannot occur in validated repository paths. Keep all already valid
// parts byte-for-byte, escaping only those whose whitespace would break ID parsing.
export const fileInspectionPartId = (path: string) =>
  path === path.trim() ? path : "file:" + encodeURIComponent(path);
const pathLens = (path: string): ReviewLens => {
  if (/(^|\/)(tests?|__tests__|specs?)(\/|$)|\.(test|spec)\./iu.test(path)) return "tests";
  if (/(^|\/)(\.github|scripts|deploy|config|configs)(\/|$)|(?:^|\/)(package\.json|Dockerfile|[^/]+\.config\.[^/]+)$/iu.test(path)) return "config_deployment";
  if (/(^|[\/_.-])(auth|permissions?|crypto|secrets?|security)([\/_.-]|$)/iu.test(path)) return "security";
  if (/(^|[\/_.-])(cache|performance|perf|batch)([\/_.-]|$)/iu.test(path)) return "performance";
  if (/(^|[\/_.-])(logging|telemetry|observability|health)([\/_.-]|$)/iu.test(path)) return "operability";
  return "behavior";
};

export function admittedFileCoverage(
  admitted: readonly string[], current: readonly ReviewAcceptedAnswer[], emptyPaths: ReadonlySet<string>,
) {
  const inspected = new Set<string>();
  for (const { submission } of current) {
    const declared = new Set(submission.inspected_sources.map(ref => ref.path));
    const linked = new Set(submission.answer.parts.flatMap(part => part.observation_ids));
    for (const observation of submission.answer.observations) {
      if (observation.kind !== "source_confirmed" || !linked.has(observation.observation_id)) continue;
      for (const ref of observation.source_refs) {
        if (declared.has(ref.path) && (ref.start_line !== undefined || emptyPaths.has(ref.path))) inspected.add(ref.path);
      }
    }
  }
  const gaps = admitted.filter(path => !inspected.has(path));
  return { admitted_count: admitted.length, inspected_count: admitted.length - gaps.length, gaps };
}

/** A supplemental packet is recoverable from its accepted answer because
 * acceptance requires exactly one result per assigned path. The ID binds lens
 * and membership; the revision binds the frozen bytes. */
function inspectionPacket(base: ReviewPlan, lens: ReviewLens, packet: readonly string[], hashes: ReadonlyMap<string, string>) {
  const question_id = FILE_INSPECTION_PREFIX + hashContent(stableStringify({ lens, packet }));
  const source_dependencies = packet.map(key => ({ kind: "source" as const, key, fingerprint: hashes.get(key)! }));
  const revision_id = hashContent(stableStringify({ snapshot: base.snapshot_id, lens, source_dependencies }));
  const item: ReviewPlan["inventory"][number] = {
    inventory_item_id: question_id, kind: "invariant", scope: "in_scope",
    title: "Static inspection of remaining admitted files (" + lens + ")",
    source_refs: packet.map(path => ({ path })), contract_refs: [],
  };
  const question: ReviewPlan["questions"][number] = {
    schema_version: base.schema_version, snapshot_id: base.snapshot_id,
    question_id, revision_id, lens, inventory_item_ids: [question_id],
    expected_outcome: "Inspect each named frozen file for the assigned lens. Read the actual file, not just tool output. Each inspected file needs an inspected_sources entry and a line-anchored source-confirmed observation in its own part (path-only for an empty file). If you cannot read a file, omit its inspected_sources entry and submit its part as inconclusive with the access reason. Do not run tools against targets or infer a defect from a lead.",
    requested_parts: packet.map(path => ({ part_id: fileInspectionPartId(path), expectation: "Inspect " + path + " for " + lens + "; report a supported finding, a checked clean result, or an explicit inconclusive reason." })),
    source_dependencies, evidence_dependencies: [], plan_status: "pending",
  };
  return { item, question };
}

/** Supplements the frozen base plan without changing its identity. Once a
 * packet has an accepted answer, keep its original membership: reopening a
 * semantic answer may expose new gaps but must not reshuffle proven work. */
export function extendFullFileReview(
  base: ReviewPlan, admitted: readonly string[], fingerprints: ReadonlyMap<string, string>,
  currentBase: readonly ReviewAcceptedAnswer[], emptyPaths: ReadonlySet<string>,
  history: readonly ReviewAcceptedAnswer[] = [], allowNew = true,
): ReviewPlan {
  const selected = base.lens_decisions.filter(row => row.decision === "selected").map(row => row.lens);
  const lenses = selected.length ? selected :
    base.lens_decisions.filter(row => row.decision === "not_applicable").map(row => row.lens);
  if (!lenses.length) return base;
  const admittedByPart = new Map(admitted.map(path => [fileInspectionPartId(path), path]));
  const coveredByPacket = new Set<string>();
  const packets = new Map<string, ReturnType<typeof inspectionPacket>>();
  for (const { submission } of history) {
    if (!submission.question_id.startsWith(FILE_INSPECTION_PREFIX) || packets.has(submission.question_id) ||
        submission.snapshot_id !== base.snapshot_id) continue;
    const paths = submission.answer.parts.flatMap(part => admittedByPart.get(part.part_id) ?? []).sort(compareCodeUnits);
    if (paths.length !== submission.answer.parts.length || !paths.length || paths.length > PACK_SIZE ||
        new Set(paths).size !== paths.length || paths.some(path => !fingerprints.has(path))) continue;
    for (const lens of lenses) {
      const packet = inspectionPacket(base, lens, paths, fingerprints);
      if (packet.question.question_id !== submission.question_id || packet.question.revision_id !== submission.revision_id) continue;
      packets.set(submission.question_id, packet);
      for (const path of paths) coveredByPacket.add(path);
      break;
    }
  }
  if (allowNew) {
    const byLens = new Map<ReviewLens, string[]>();
    for (const path of admittedFileCoverage(admitted, currentBase, emptyPaths).gaps) {
      if (!fingerprints.has(path) || coveredByPacket.has(path)) continue;
      const preferred = pathLens(path);
      const lens = lenses.includes(preferred) ? preferred : lenses.includes("behavior") ? "behavior" : lenses[0]!;
      const paths = byLens.get(lens) ?? [];
      paths.push(path);
      byLens.set(lens, paths);
    }
    for (const [lens, paths] of byLens) {
      for (let offset = 0; offset < paths.length; offset += PACK_SIZE) {
        const packet = inspectionPacket(base, lens, paths.slice(offset, offset + PACK_SIZE), fingerprints);
        packets.set(packet.question.question_id, packet);
      }
    }
  }
  if (!packets.size) return base;
  const ordered = [...packets.values()].sort((a, b) =>
    compareCodeUnits(a.question.lens, b.question.lens) || compareCodeUnits(a.item.source_refs[0]!.path, b.item.source_refs[0]!.path));
  const usedLenses = new Set(ordered.map(row => row.question.lens));
  return { ...base,
    lens_decisions: base.lens_decisions.map(row => row.decision === "not_applicable" && usedLenses.has(row.lens)
      ? { ...row, decision: "selected", reason: "Static inspection of admitted source without a discovered semantic subject." }
      : row),
    inventory: [...base.inventory, ...ordered.map(row => row.item)],
    questions: [...base.questions, ...ordered.map(row => row.question)],
  };
}
