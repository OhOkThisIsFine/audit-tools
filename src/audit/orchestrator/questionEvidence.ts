// sites-pinned: tests/audit/question-evidence.test.ts
import { readFile, realpath } from "node:fs/promises";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { resolveWithinRoot } from "../../shared/io/pathContainment.js";
import { analyzerProvenanceKey, hashAnalyzerSnippetLines } from "../../shared/analyzers/provenance.js";
import type { ExternalAnalyzerResults } from "../../shared/analyzers/types.js";
import { hashContent } from "../../shared/hash.js";
import type { ReviewDependency, ReviewEvidence } from "../../shared/types/reviewQuestion.js";

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const keyOf = ({ kind, key }: ReviewDependency) => JSON.stringify([kind, key]);

/** Bind a reconstructed set to the discovery rule as well as its logical member IDs.
 * Call only for an authoritative inventory. Unavailable discovery supplies no binding. */
export function fingerprintDiscoveredSet(
  key: string, ruleFingerprint: string, memberIds: readonly string[],
): ReviewDependency {
  return { kind: "membership", key, fingerprint: hashContent(JSON.stringify([ruleFingerprint, sortedUnique(memberIds)])) };
}

export interface EvidenceApplicability {
  status: "applicable" | "changed" | "unknown";
  changed: ReviewDependency[];
  unknown: ReviewDependency[];
}

/** No whole-snapshot fallback. Missing or contradictory resolutions prove nothing.
 * The caller gathers current bindings from the same authoritative discovery rules. */
export function evidenceApplicability(
  required: readonly ReviewDependency[], current: readonly ReviewDependency[],
): EvidenceApplicability {
  const versions = new Map<string, Set<string>>();
  for (const binding of current) {
    const key = keyOf(binding);
    const values = versions.get(key) ?? new Set();
    values.add(binding.fingerprint);
    versions.set(key, values);
  }
  const changed: ReviewDependency[] = [], unknown: ReviewDependency[] = [];
  for (const needed of required) {
    const found = versions.get(keyOf(needed));
    if (found?.size !== 1) unknown.push(needed);
    else if (!found.has(needed.fingerprint)) changed.push(needed);
  }
  return { status: changed.length ? "changed" : unknown.length ? "unknown" : "applicable", changed, unknown };
}

type NamedEvidence = NonNullable<ReviewEvidence["observations"]>[number];
type ExecutionConditions = Pick<NonNullable<ReviewEvidence["execution"]>,
  "tool" | "tool_version" | "config_fingerprint" | "input_fingerprint" | "environment_fingerprint" | "exclusions">;

/** Turn observed execution conditions into a binding which can be recomputed
 * without running the command. Elapsed time and usage aren't applicability. */
export function fingerprintExecutionConditions(
  key: string, conditions: ExecutionConditions,
): ReviewDependency {
  const { tool, tool_version, config_fingerprint, input_fingerprint, environment_fingerprint, exclusions } = conditions;
  return {
    kind: "evidence", key,
    fingerprint: hashContent(JSON.stringify([
      tool, tool_version, config_fingerprint, input_fingerprint, environment_fingerprint, sortedUnique(exclusions),
    ])),
  };
}

/** Producer seam for already-authorized execution. An observed execution can
 * have zero named observations; no observation is synthesized from its status. */
export function buildCommandEvidence(
  input: Omit<ReviewEvidence, "schema_version" | "kind">,
  conditionsKey: string,
): ReviewEvidence {
  const { evidence_id, snapshot_id, source_refs, dependencies, status, description, execution, observations } = input;
  if (status === "observed" && execution?.executed !== true) {
    throw new Error("Observed command evidence requires recorded execution");
  }
  if (status !== "observed" && observations?.length) {
    throw new Error("Unavailable or unrun command evidence cannot name observations");
  }
  return {
    schema_version: "audit-tools/question-review/v1", kind: "command", evidence_id, snapshot_id,
    source_refs, status, description,
    dependencies: execution?.executed ? [...dependencies, fingerprintExecutionConditions(conditionsKey, execution)] : dependencies,
    ...(execution === undefined ? {} : { execution }),
    ...(observations === undefined ? {} : { observations }),
  };
}

/** Command metadata/exit is not a task-specific observation. Only the matching
 * named receipt from an observed, actually executed command can supply one. */
export function resolveEvidenceReference(
  record: ReviewEvidence, ref: { evidence_id: string; observation_id?: string },
): NamedEvidence | undefined {
  if (record.evidence_id !== ref.evidence_id || record.status !== "observed" || ref.observation_id === undefined ||
      (record.kind === "command" && record.execution?.executed !== true)) return undefined;
  const matches = record.observations?.filter((result) => result.observation_id === ref.observation_id);
  return matches?.length === 1 ? matches[0] : undefined;
}

interface AnalyzerCalibrationInputs {
  tool: string;
  tool_version: string;
  config_fingerprint: string;
  selected_paths: readonly string[];
  exclusions: readonly string[];
}

/** Invoke under the existing run consent policy; this record describes observed
 * settings only. Never spread input, because a grant is not calibration data. */
export function makeAnalyzerCalibration(input: AnalyzerCalibrationInputs) {
  const value = {
    schema_version: "audit-tools/analyzer-calibration/v1",
    tool: input.tool,
    tool_version: input.tool_version,
    config_fingerprint: input.config_fingerprint,
    selected_paths: sortedUnique(input.selected_paths),
    exclusions: sortedUnique(input.exclusions),
  } as const;
  return { ...value, fingerprint: hashContent(JSON.stringify(value)) };
}

/** Compare portable analyzer settings, never authorization or run coverage. */
export function reuseAnalyzerCalibration(
  stored: ReturnType<typeof makeAnalyzerCalibration> | undefined,
  current: AnalyzerCalibrationInputs,
): ReturnType<typeof makeAnalyzerCalibration> | undefined {
  const expected = makeAnalyzerCalibration(current);
  return stored?.schema_version === expected.schema_version &&
    stored.fingerprint === expected.fingerprint &&
    makeAnalyzerCalibration(stored).fingerprint === expected.fingerprint ? expected : undefined;
}

interface RuntimeReceipt {
  /** Typed, separately recorded receipt from the authorized executor, not a report summary. */
  conditions_key: string;
  record: Omit<ReviewEvidence, "schema_version" | "kind">;
}

interface QuestionEvidenceInput {
  snapshot_id: string;
  sourceRoot: string;
  /** Frozen, in-scope file hashes from the review planner. */
  sourceFiles: ReadonlyMap<string, string>;
  analyzerResults?: readonly ExternalAnalyzerResults[] | undefined;
  runtimeReceipts?: readonly RuntimeReceipt[];
  /** Recomputed from authoritative current discovery and execution conditions. */
  currentDependencies?: readonly ReviewDependency[];
}

/** Present only currently anchored analyzer leads and named authorized runtime
 * receipts. Analyzer summaries, raw payloads, and exit/coverage claims stay out. */
export async function collectQuestionEvidence(input: QuestionEvidenceInput): Promise<ReviewEvidence[]> {
  const { snapshot_id, sourceFiles, currentDependencies = [] } = input;
  const current = [...currentDependencies, ...[...sourceFiles].map(([key, fingerprint]) =>
    ({ kind: "source" as const, key, fingerprint }))];
  const sourceRoot = await realpath(input.sourceRoot);
  const cache = new Map<string, Promise<readonly string[] | undefined>>();
  function loadFrozen(path: string): Promise<readonly string[] | undefined> {
    const existing = cache.get(path);
    if (existing) return existing;
    // Runtime receipt references are checked concurrently, including multiple
    // spans in one file. Share the pending read, not just its settled value.
    const pending = readFrozen(path);
    cache.set(path, pending);
    return pending;
  }
  async function readFrozen(path: string): Promise<readonly string[] | undefined> {
    let source: readonly string[] | undefined;
    const fingerprint = sourceFiles.get(path);
    if (fingerprint) {
      try {
        const candidate = resolveWithinRoot(sourceRoot, path, { allowRoot: false });
        // Guard the path again after resolving symlinks; a lexical child can
        // point outside the frozen tree.
        const target = candidate && resolveWithinRoot(sourceRoot, await realpath(candidate), { allowRoot: false });
        if (target) {
          const bytes = await readFile(target);
          if (hashContent(bytes) === fingerprint) source = bytes.toString("utf8").split(/\r?\n/u);
        }
      } catch {
        // Missing or unreadable frozen source cannot anchor a receipt.
      }
    }
    return source;
  }
  async function isFrozenRef(ref: ReviewEvidence["source_refs"][number]): Promise<boolean> {
    const source = await loadFrozen(ref.path);
    const start = ref.start_line ?? 1, end = ref.end_line ?? start;
    return source !== undefined && Number.isInteger(start) && Number.isInteger(end) &&
      start >= 1 && end >= start && end <= source.length;
  }
  const records = new Map<string, ReviewEvidence>();
  for (const result of input.analyzerResults ?? []) {
    for (const item of result.results) {
      const p = item.provenance;
      const start = item.line_start;
      if (!p || p.analyzer_id !== result.tool || p.path !== item.path || start === undefined) continue;
      const ref = { path: p.path, start_line: start, end_line: item.line_end ?? start };
      if (!await isFrozenRef(ref)) continue;
      const source = await loadFrozen(ref.path);
      if (source === undefined || hashAnalyzerSnippetLines(source, start, ref.end_line) !== p.snippet_hash) continue;
      const evidence_id = `lead-${hashContent(JSON.stringify([analyzerProvenanceKey(p), start, ref.end_line]))}`;
      records.set(evidence_id, {
        schema_version: "audit-tools/question-review/v1", evidence_id, snapshot_id, kind: "source",
        status: "observed", source_refs: [ref],
        dependencies: [{ kind: "source", key: ref.path, fingerprint: sourceFiles.get(ref.path)! }],
        ...(p.comparison_fingerprint ? { analyzer_provenance: p } : {}),
        description: "An analyzer flagged this frozen source span; inspect the source before interpreting the lead.",
      });
    }
  }
  const runtimeIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const { record } of input.runtimeReceipts ?? []) {
    if (runtimeIds.has(record.evidence_id)) duplicateIds.add(record.evidence_id);
    runtimeIds.add(record.evidence_id);
  }
  for (const { conditions_key, record } of input.runtimeReceipts ?? []) {
    if (record.snapshot_id !== snapshot_id || record.status !== "observed" ||
        record.execution?.executed !== true || !record.observations?.length ||
        duplicateIds.has(record.evidence_id) || records.has(record.evidence_id) ||
        new Set(record.observations.map(o => o.observation_id)).size !== record.observations.length) continue;
    const refs = [...record.source_refs, ...record.observations.flatMap(o => o.source_refs ?? [])];
    if ((await Promise.all(refs.map(isFrozenRef))).some(ok => !ok)) continue;
    const bound = buildCommandEvidence({
      ...record,
      source_refs: [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()],
      dependencies: [...record.dependencies, ...[...new Set(refs.map(ref => ref.path))].map(key =>
        ({ kind: "source" as const, key, fingerprint: sourceFiles.get(key)! }))],
    }, conditions_key);
    if (evidenceApplicability(bound.dependencies, current).status === "applicable") records.set(record.evidence_id, bound);
  }
  return [...records.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, record]) => record);
}
