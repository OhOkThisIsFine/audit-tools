// sites-pinned: tests/audit/question-planning.test.ts
import { compareCodeUnits, hashContent, pathMatchesPrefix, stableStringify } from "audit-tools/shared";
import {
  BUILT_IN_REVIEW_LENSES, REVIEW_QUESTION_CONTRACT_VERSION, ReviewLensSchema,
  type ReviewInventoryItem, type ReviewPlan, type ReviewQuestion, type ReviewSourceRef,
} from "../../shared/types/reviewQuestion.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import { isTestPath } from "../extractors/pathPatterns.js";
import { getExternalSignalPaths } from "./requeueUtils.js";
import { fingerprintDiscoveredSet } from "./questionEvidence.js";
import { REVIEW_LENS_PLAYBOOKS } from "./reviewLensPlaybooks.js";
import { resolveIntentLensSelection } from "./lensSelection.js";
// Change when the membership discovery or interpretation changes, not when a
// different revision merely adds/removes a member.
const QUESTION_DISCOVERY_RULE = "review-question-discovery/v1";

type BuiltInLens = keyof typeof REVIEW_LENS_PLAYBOOKS;
type Lens = ReviewQuestion["lens"];
type InventoryKind = ReviewInventoryItem["kind"];
type Part = ReviewQuestion["requested_parts"][number];
type QuestionContext = { start: ReviewSourceRef; behavior?: string };
type SignalDisposition = {
  signal_id: string;
  outcome: "promoted" | "grouped" | "not_promoted";
  reason: string;
  question_id?: string;
  source_refs?: ReviewSourceRef[];
};
type PlanOptions = {
  snapshotId: string;
  scope?: AuditScopeManifest;
  /** Explicit operator or host-mediated questions only, not inferred custom lenses. */
  declaredQuestions?: readonly DeclaredReviewQuestion[];
};

export interface DeclaredReviewQuestion {
  key: string;
  lens: Lens;
  kind: InventoryKind;
  title: string;
  expectation: string;
  source_refs: readonly ReviewSourceRef[];
  contract_refs?: readonly ReviewSourceRef[];
  parts?: readonly Part[];
}

interface Subject {
  lens: Lens;
  inventory: ReviewInventoryItem;
  expectation: string;
  parts: Part[];
  /** Membership is independently recomputable from the structural artifacts. */
  membership?: readonly string[];
  evidence?: readonly (readonly [string, string])[];
  context?: QuestionContext;
}

type AddSubject = (lens: Lens, key: string, kind: InventoryKind, title: string,
  refs: ReviewSourceRef[], contract: ReviewSourceRef[], expectation: string,
  linked?: Pick<Subject, "membership" | "evidence" | "context"> & { parts?: Part[] }) => string;
type RecordSignalDisposition = (signalId: string, outcome: SignalDisposition["outcome"],
  reason: string, refs: ReviewSourceRef[], questionId?: string) => void;

interface Operation {
  id: string;
  title: string;
  entry: string;
  refs: ReviewSourceRef[];
  contract: ReviewSourceRef[];
  expectation: string;
  exposure?: "network" | "local";
  background: boolean;
  declaredBoundary: boolean;
}

const ordered = (items: Iterable<string>) => [...new Set(items)].sort(compareCodeUnits);
const digest = (value: unknown) => hashContent(stableStringify(value));
const source = (path: string): ReviewSourceRef => ({ path });
const locator = (ref: ReviewSourceRef) => ref.start_line !== undefined
  ? `${ref.path}:${ref.start_line}${ref.end_line === undefined ? "" : `-${ref.end_line}`}`
  : ref.symbol ? `${ref.path}#${ref.symbol}` : ref.path;
const sourceRefs = (paths: Iterable<string>) => ordered(paths).map(source);
const ids = (namespace: string, value: string) => `${namespace}:${hashContent(value, { length: 24 })}`;
const isBuiltIn = (value: string): value is BuiltInLens => Object.hasOwn(REVIEW_LENS_PLAYBOOKS, value);
const claimLens = (lens: string): BuiltInLens => isBuiltIn(lens) ? lens :
  lens === "correctness" || lens === "reliability" || lens === "data_integrity" ? "behavior" :
    lens === "observability" ? "operability" : "architecture";

export function classifyConfiguration(path: string): "release" | "runtime" | undefined {
  if (/(?:^|\/)(?:\.github\/workflows\/|\.gitlab-ci\.ya?ml$|Jenkinsfile$|Dockerfile(?:\.[^/]+)?$|(?:docker-)?compose\.ya?ml$|render\.ya?ml$)/iu.test(path)) return "release";
  if (/(?:^|\/)(?:package\.json$|pyproject\.toml$|Cargo\.toml$|\.env\.example$|(?:runtime[-_.]config|config[-_.]runtime|config\.runtime|config\.(?:[cm]?[jt]s|py)$)(?:\.|$)|(?:install|setup|deploy|rollback)\/)/iu.test(path)) return "runtime";
  return undefined;
}

/** Same trust boundary for planner references and the full allowed review scope. */
export function reviewSourceScope(bundle: ArtifactBundle, overrideScope?: AuditScopeManifest) {
  const files = new Map(bundle.repo_manifest?.files.map((file) => [file.path, file]));
  const dispositions = new Map(bundle.file_disposition?.files.map((file) => [file.path, file]));
  const intent = bundle.intent_checkpoint;
  const scope = overrideScope ?? bundle.scope;
  const delta = scope?.mode === "delta" ? new Set([...scope.seed_files, ...scope.expanded_files]) : undefined;
  const sourceStatus = (path: string, contract = false): string | undefined => {
    const exclusion = intent?.excluded_scope?.find((row) => pathMatchesPrefix(path, row.path));
    if (exclusion) return exclusion.reason;
    const file = files.get(path);
    if (!file) return "No unique frozen source file was resolved for this surface.";
    if (file.excluded) return file.exclusion_reason ?? "Outside the admitted audit source.";
    const override = intent?.disposition_overrides?.find((row) => pathMatchesPrefix(path, row.path));
    const disposition = override ?? dispositions.get(path);
    const contractDocument = contract && disposition?.status === "doc_only";
    if (disposition?.status !== "included" && !contractDocument) {
      return disposition?.reason ?? (disposition ? `Source disposition: ${disposition.status}.` : "Source disposition has not been established.");
    }
    if (delta && !contractDocument && !delta.has(path)) return "Outside the confirmed changed scope.";
    if (!file.hash) return "Source is present but lacks a verifiable content fingerprint.";
    return undefined;
  };
  return {
    files, dispositions, sourceStatus,
    allowedSourcePaths: ordered([...files.keys()].filter((path) => sourceStatus(path) === undefined)),
    allowedContractPaths: ordered([...files.keys()].filter((path) => sourceStatus(path, true) === undefined)),
  };
}

function discoverOperationEntries(bundle: ArtifactBundle, { files, sourceStatus }: ReturnType<typeof reviewSourceScope>) {
  const resolveRef = (ref: string): ReviewSourceRef | undefined => {
    if (files.has(ref)) return source(ref);
    const boundary = ref.search(/[:#]/u);
    if (boundary < 1) return undefined;
    const path = ref.slice(0, boundary);
    if (!files.has(path)) return undefined;
    const suffix = ref.slice(boundary + 1);
    const lines = /^(\d+)(?:-(\d+))?$/u.exec(suffix);
    if (lines) return { path, start_line: Number(lines[1]), ...(lines[2] ? { end_line: Number(lines[2]) } : {}) };
    return suffix.length > 0 ? { path, symbol: suffix } : source(path);
  };
  const byEntry = new Map<string, NonNullable<ArtifactBundle["critical_flows"]>["flows"]>();
  for (const flow of bundle.critical_flows?.flows ?? []) {
    for (const entry of flow.entrypoints) {
      const path = resolveRef(entry)?.path ?? entry;
      const related = byEntry.get(path) ?? [];
      related.push(flow);
      byEntry.set(path, related);
    }
  }
  const routeCandidates = new Map<string, Set<string>>();
  for (const route of bundle.graph_bundle?.graphs.routes ?? []) {
    if (route.provenance === "filename_inference") continue;
    const id = `route:${route.method ?? "unspecified"}:${route.path}`;
    const handlers = routeCandidates.get(id) ?? new Set<string>();
    handlers.add(route.handler);
    routeCandidates.set(id, handlers);
  }
  const packageRegistrations = new Map<string, { targets: Set<string>; manifest: string }>();
  for (const edge of bundle.graph_bundle?.graphs.references ?? []) {
    if (edge.kind !== "package-entrypoint-link") continue;
    const field = /^Package manifest field '([^']+)'/u.exec(edge.reason ?? "")?.[1];
    const id = `package:${edge.from}:${field ?? edge.to}`;
    const registered = packageRegistrations.get(id) ?? { targets: new Set<string>(), manifest: edge.from };
    registered.targets.add(edge.to);
    packageRegistrations.set(id, registered);
  }
  const entrySurfaces = [
    ...(bundle.surface_manifest?.surfaces ?? []).map((row) => ({ ...row, registered: false, alternatives: [] as string[], registrationSources: [] as string[] })),
    ...[...routeCandidates].map(([id, handlers]) => {
      const [entrypoint, ...alternatives] = ordered(handlers).sort((a, b) => {
        const admitted = (value: string) => { const ref = resolveRef(value); return ref !== undefined && sourceStatus(ref.path) === undefined; };
        return Number(admitted(b)) - Number(admitted(a));
      });
      return { id, kind: "interface" as const, exposure: "network" as const, entrypoint: entrypoint!, alternatives, registered: true, registrationSources: [] };
    }),
    ...[...packageRegistrations].map(([id, { targets, manifest }]) => {
      const [entrypoint, ...alternatives] = ordered(targets).sort((a, b) =>
        Number(sourceStatus(b) === undefined) - Number(sourceStatus(a) === undefined));
      return { id, kind: "interface" as const, exposure: "local" as const, entrypoint: entrypoint!, alternatives, registered: true, registrationSources: [manifest] };
    }),
  ];
  const declaredEntries = new Set(entrySurfaces.filter(({ registered }) => registered)
    .flatMap(({ entrypoint, alternatives }) => [entrypoint, ...alternatives].map((ref) => resolveRef(ref)?.path)));
  const representedEntries = new Set(entrySurfaces.map(({ entrypoint }) => resolveRef(entrypoint)?.path ?? entrypoint));
  for (const [entry] of byEntry) if (!representedEntries.has(entry)) {
    // A recognized flow's entry still needs disposition even if no surface heuristic classified it.
    // A one-entry shared-state flow is inventoried below as an invariant, not a new public operation.
    const crossesOperation = [...representedEntries].filter((path) =>
      byEntry.get(path)?.some((flow) => flow.paths.includes(entry))).length > 1;
    if (!crossesOperation) entrySurfaces.push({ id: `flow-entry:${entry}`, kind: "interface", entrypoint: entry, registered: false, alternatives: [], registrationSources: [] });
  }
  return { resolveRef, byEntry, entrySurfaces, declaredEntries };
}

/** Use the same admitted operation candidates for the checkpoint and for review assignments. */
export function hasReviewableOperation(bundle: ArtifactBundle, scope: AuditScopeManifest): boolean {
  const sourceScope = reviewSourceScope(bundle, scope);
  const { resolveRef, entrySurfaces } = discoverOperationEntries(bundle, sourceScope);
  return entrySurfaces.some(({ entrypoint }) => {
    const ref = resolveRef(entrypoint);
    return ref !== undefined && sourceScope.sourceStatus(ref.path) === undefined;
  });
}

/**
 * Reconcile discovered execution surfaces and native wiring before assigning questions.
 * Neither planner priority nor the presence of a follow-up can make an entry disappear.
 */
export function buildReviewQuestionPlan(bundle: ArtifactBundle, options: PlanOptions): ReviewPlan {
  if (!options.snapshotId) throw new Error("Question planning requires a frozen snapshot identity");
  const intent = bundle.intent_checkpoint;
  const sourceScope = reviewSourceScope(bundle, options.scope);
  const { files, dispositions, sourceStatus } = sourceScope;
  const { resolveRef, byEntry, entrySurfaces, declaredEntries } = discoverOperationEntries(bundle, sourceScope);
  const subjects: Subject[] = [];
  const inventory: ReviewInventoryItem[] = [];
  const omissions: ReviewPlan["omissions"] = [];
  const signalDispositions: SignalDisposition[] = [];
  const owners = new Map<string, Set<string>>();
  for (const unit of bundle.unit_manifest?.units ?? []) for (const path of unit.files) {
    const units = owners.get(path) ?? new Set<string>();
    units.add(unit.unit_id);
    owners.set(path, units);
  }
  const ownership = (refs: readonly ReviewSourceRef[]) => ordered(refs.flatMap((ref) => [...(owners.get(ref.path) ?? [])]));
  const statements = bundle.charter_register?.lanes.find(({ kind }) => kind === "stated")?.nodes ?? [];
  const externalPaths = getExternalSignalPaths(bundle.external_analyzer_results);
  const add: AddSubject = (lens, key, kind, title, refs, contract, expectation, linked) => {
    // The bound question and its structured starting list must agree on where
    // to start; the remaining source and contract refs still provide context.
    const start = linked?.context?.start;
    const startKey = start && stableStringify(start);
    const startIndex = startKey === undefined ? -1 : refs.findIndex(ref => stableStringify(ref) === startKey);
    const startingRefs = startIndex > 0 ? [refs[startIndex]!, ...refs.slice(0, startIndex), ...refs.slice(startIndex + 1)] : refs;
    const item: ReviewInventoryItem = { inventory_item_id: ids(kind, key), kind,
      title, source_refs: startingRefs, contract_refs: contract, scope: "in_scope" };
    if (!inventory.some(({ inventory_item_id }) => inventory_item_id === item.inventory_item_id)) inventory.push(item);
    subjects.push({ lens, inventory: item, expectation,
      parts: linked?.parts ?? [{ part_id: "supported-outcome", expectation }],
      membership: linked?.membership, evidence: linked?.evidence, context: linked?.context });
    return ids(lens, item.inventory_item_id);
  };
  const disposition: RecordSignalDisposition = (signal_id, outcome, reason, refs, question_id) => {
    signalDispositions.push({ signal_id, outcome, reason,
      ...(refs.length ? { source_refs: refs } : {}), ...(question_id ? { question_id } : {}) });
  };
  const operationRows: Operation[] = [];
  for (const surface of entrySurfaces.sort((a, b) => compareCodeUnits(a.id, b.id))) {
    const ref = resolveRef(surface.entrypoint);
    const reason = ref ? sourceStatus(ref.path) : "The discovered surface has no unique source binding in the frozen snapshot.";
    const related = ref ? (byEntry.get(ref.path) ?? []) : [];
    const title = surface.registered ? surface.id : related[0]?.name ?? surface.id;
    if (reason !== undefined || !ref) {
      const declared = !!ref && (files.has(ref.path) && dispositions.has(ref.path) || !!intent?.excluded_scope?.some((row) => pathMatchesPrefix(ref.path, row.path)));
      const state = declared && ref && files.get(ref.path)?.hash ? "excluded" : "deferred";
      const hint = /^(?:[\w@.-]+\/)+[\w@.-]+$/u.test(surface.entrypoint) &&
        !surface.entrypoint.split("/").some((segment) => segment === "." || segment === "..")
        ? source(surface.entrypoint) : undefined;
      const item: ReviewInventoryItem = { inventory_item_id: ids("operation", surface.id),
        kind: "operation", title, source_refs: ref ? [ref] : hint ? [hint] : [], contract_refs: [], scope: state, scope_reason: reason! };
      inventory.push(item);
      omissions.push({ surface_id: surface.id, source_refs: item.source_refs, reason: reason! });
      continue;
    }
    // A path-heuristic record is descriptive overlap, not a second operation,
    // when native registration already identifies handlers on the same path.
    if (!surface.registered && declaredEntries.has(ref.path)) continue;
    const otherHandlers = surface.alternatives.flatMap((handler) => {
      const alternative = resolveRef(handler);
      if (alternative && sourceStatus(alternative.path) === undefined) return [alternative.path];
      omissions.push({ surface_id: `${surface.id}:unavailable-registration`, source_refs: alternative ? [alternative] : [],
        reason: `A competing registration for ${title} could not be resolved within the admitted source.` });
      return [];
    });
    const registrationPaths = surface.registered && surface.exposure === "network"
      ? (bundle.graph_bundle?.graphs.calls ?? []).flatMap((edge) =>
        edge.kind === "route-handler-link" && [ref.path, ...otherHandlers].includes(edge.to) ? [edge.from] : [])
      : [];
    const relatedPaths = [...related.flatMap((flow) => flow.paths), ...otherHandlers, ...registrationPaths, ...surface.registrationSources];
    const refs = sourceRefs([ref.path, ...relatedPaths.filter((path) => sourceStatus(path) === undefined)]);
    refs[refs.findIndex(({ path }) => path === ref.path)] = ref;
    const goals = statements.filter((statement) => statement.files?.includes(ref.path) ||
      statement.provenance.some((provenance) => resolveRef(provenance.ref)?.path === ref.path));
    const contract = sourceRefs(goals.flatMap((goal) => goal.provenance.flatMap((provenance) => {
      const match = resolveRef(provenance.ref);
      return match && sourceStatus(match.path, true) === undefined ? [match.path] : [];
    })));
    const expectation = surface.alternatives.length > 0
      ? "Resolve which registered implementation actually receives the operation and under what conditions; preserve conflicting or unresolved evidence."
      : goals.length === 1 && contract.length > 0
      ? `Verify the stated outcome: ${goals[0]!.purpose}`
      : goals.length > 1
        ? "Establish which of the cited expectations governs this operation; preserve contradictions rather than silently deciding."
        : "Establish this supported operation’s expected outcome and resulting state from its contracts and tests before claiming it is correct.";
    const op = { id: surface.id, title, entry: ref.path, refs, contract, expectation, exposure: surface.exposure,
      background: surface.kind === "background", declaredBoundary: surface.exposure === "network" };
    operationRows.push(op);
    const context = { start: ref, behavior: expectation };
    add("behavior", op.id, "operation", op.title, refs, contract, expectation, {
      context, ...(surface.registered ? { membership: [surface.entrypoint, ...surface.alternatives] } : {}),
    });
    if (op.declaredBoundary || externalPaths.has(ref.path) || related.some((flow) => flow.concerns.includes("security"))) {
      add("security", op.id, "trust_boundary", `Authority for ${title}`, refs, contract,
        "Identify the external or differently authorized caller, the enforced authority decision, and the protected effect.", { context });
    }
    if (ownership(refs).length > 1) add("architecture", op.id, "operation", title, refs, contract,
      "Explain which components own the contract and decisions. Compare the present delegation with a concrete alternative and its trade-offs.",
      { membership: ownership(refs), context });
    if (op.background || related.some((flow) => flow.concerns.includes("performance"))) {
      add("performance", op.id, "workload", `Representative workload: ${title}`, refs, contract,
        "Quantify or bound ordinary and relevant unchanged, cold, or retry workload time, memory, I/O, or spend where runnable; report hypotheses as hypotheses.", { context });
    }
    if (surface.kind === "interface" || op.background) add("operability", op.id, "operator_transition", `Interpreting ${title}`, refs, contract,
      "Determine how a caller or operator distinguishes outcomes and chooses the next action from available output and state.", { context });
    add("tests", op.id, "operation", title, refs, contract, refs.some(({ path }) => isTestPath(path))
      ? "Name the support contract each reachable fixture asserts, what regression it would catch, and material gaps or execution cost."
      : "Trace this operation's supported outcome to any available tests. Identify a material regression that could escape detection if the evidence supports a gap.", { context });
  }

  // Existing source discovery supplies the shared state surface; do not infer
  // an invariant merely because two routes import the same utility.
  for (const [entry, flows] of [...byEntry].sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (sourceStatus(entry) !== undefined || operationRows.some((op) => op.entry === entry)) continue;
    const members = operationRows.filter((op) => op.refs.some(({ path }) => path === entry));
    if (members.length < 2) continue;
    const refs = sourceRefs([entry, ...members.map(({ entry: path }) => path), ...flows.flatMap((flow) => flow.paths.filter((path) => sourceStatus(path) === undefined))]);
    const contract = sourceRefs(members.flatMap((op) => op.contract.map(({ path }) => path)));
    const expectation = "Establish the shared state-preservation rule and trace each registered operation that can affect it without assuming an unwritten policy.";
    add("behavior", `shared-state:${entry}`, "invariant", `Shared invariant at ${entry}`, refs, contract, expectation,
      { context: { start: source(entry) }, membership: members.map(({ id }) => id), parts: members.map((op) => ({
        part_id: op.id, expectation: `Establish how ${op.title} preserves the shared rule.`,
      })) });
  }

  routePriorReviewSignals(bundle, (options.scope ?? bundle.scope)?.mode === "full",
    operationRows, resolveRef, sourceStatus, add, disposition);

  const transitionPaths = [...files.keys()].filter((path) => sourceStatus(path) === undefined && classifyConfiguration(path) !== undefined);
  const runtimeConfiguration = sourceRefs(transitionPaths.filter((path) => classifyConfiguration(path) === "runtime"));
  if (runtimeConfiguration.length) add("config_deployment", "runtime", "release_transition", "Runtime configuration", runtimeConfiguration, [],
    "Confirm supported configuration precedence and the selected runtime behavior.");
  for (const release of ordered(transitionPaths.filter((path) => classifyConfiguration(path) === "release"))) {
    add("config_deployment", `release:${release}`, "release_transition", `Release and recovery via ${release}`, [source(release)], [],
      "Trace the candidate revision, which checks actually qualify it, the artifact that ships, and recovery. If this is not a release workflow, determine its role.");
  }
  for (const declaration of options.declaredQuestions ?? []) {
    const refs = declaration.source_refs.filter(({ path }) => sourceStatus(path) === undefined);
    const contracts = declaration.contract_refs?.filter(({ path }) => sourceStatus(path, true) === undefined) ?? [];
    const deferred = refs.length !== declaration.source_refs.length || refs.length === 0;
    if (deferred) {
      omissions.push({ surface_id: declaration.key, source_refs: refs,
        reason: "The explicitly declared question cannot be bound to all requested in-scope inputs." });
      continue;
    }
    add(declaration.lens, `declared:${declaration.key}`, declaration.kind, declaration.title, refs, contracts, declaration.expectation,
      { parts: declaration.parts ? [...declaration.parts] : undefined });
  }

  const requested = intent?.lens_selection?.include;
  const effective = resolveIntentLensSelection(intent?.lens_selection);
  const allowed = effective === undefined ? undefined : new Set<string>(effective);
  const excluded = intent?.lens_selection?.exclude ?? [];
  const eligible = new Set(subjects.map(({ lens }) => lens));
  const lensDecisions: ReviewPlan["lens_decisions"] = [...BUILT_IN_REVIEW_LENSES,
    ...ordered([...subjects.map(({ lens }) => lens), ...(requested ?? []), ...excluded]
      .filter((lens) => !isBuiltIn(lens) && ReviewLensSchema.safeParse(lens).success)) as Lens[]].map((lens) => {
    if (allowed && !allowed.has(lens)) {
      return { lens, decision: "excluded",
        reason: intent?.lens_selection?.omission_reasons?.[lens] ?? "Not selected in the confirmed audit lens scope." };
    }
    if (!eligible.has(lens)) return { lens, decision: "not_applicable", reason: "No applicable subject was established from the admitted source, contract and structure evidence." };
    return { lens, decision: "selected", reason: requested ? "Selected in the confirmed audit lens scope." : "Applicable to a discovered in-scope subject." };
  });
  const selected = new Set(lensDecisions.filter(({ decision }) => decision === "selected").map(({ lens }) => lens));
  const questions = new Map<string, ReviewQuestion>();
  for (const subject of subjects) {
    const { inventory: item, lens } = subject;
    if (!selected.has(lens)) continue;
    const questionId = ids(lens, item.inventory_item_id);
    if (questions.has(questionId)) throw new Error(`Duplicate review question identity for ${item.inventory_item_id}`);
    const sourceDependencies: ReviewQuestion["source_dependencies"] = ordered([...item.source_refs, ...item.contract_refs].map(({ path }) => path))
      .map((path) => ({ kind: "source", key: path, fingerprint: files.get(path)!.hash! }));
    if (subject.membership !== undefined) sourceDependencies.push(
      fingerprintDiscoveredSet(item.inventory_item_id, QUESTION_DISCOVERY_RULE, subject.membership),
    );
    const evidenceDependencies: ReviewQuestion["evidence_dependencies"] = (subject.evidence ?? []).map(([key, fingerprint]) => ({ kind: "evidence", key, fingerprint }));
    const start = subject.context?.start ?? item.source_refs[0] ?? item.contract_refs[0];
    const behavior = subject.context?.behavior;
    const expectedOutcome = [
      `Review ${item.title}.`,
      ...(start ? [`Start at ${locator(start)}.`] : []),
      ...(behavior && behavior !== subject.expectation ? [`Supported behavior to verify: ${behavior}`] : []),
      subject.expectation,
      ...(isBuiltIn(lens) ? [`Optional review guidance: ${REVIEW_LENS_PLAYBOOKS[lens]}`] : []),
    ].join(" ");
    const revision = digest({ lens, expectedOutcome, parts: subject.parts, sourceDependencies, evidenceDependencies });
    questions.set(questionId, { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, question_id: questionId, revision_id: revision, lens,
      inventory_item_ids: [item.inventory_item_id], expected_outcome: expectedOutcome, snapshot_id: options.snapshotId,
      requested_parts: subject.parts, source_dependencies: sourceDependencies, evidence_dependencies: evidenceDependencies,
      plan_status: "pending" });
  }
  const assigned = new Set([...questions.values()].flatMap(({ inventory_item_ids }) => inventory_item_ids));
  for (const item of inventory) if (item.scope === "in_scope" && !assigned.has(item.inventory_item_id)) {
    omissions.push({ surface_id: item.inventory_item_id, source_refs: item.source_refs,
      reason: "Applicable question lies outside the selected lens scope." });
  }
  const signal_dispositions = signalDispositions.map(({ question_id, ...item }): SignalDisposition =>
    question_id && questions.has(question_id) ? { ...item, question_id }
      : question_id ? { ...item, outcome: "not_promoted", reason: "Verification is outside the selected lens scope." } : item)
    .sort((a, b) => compareCodeUnits(a.signal_id, b.signal_id));
  return { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, snapshot_id: options.snapshotId,
    inventory: inventory.sort((a, b) => compareCodeUnits(a.inventory_item_id, b.inventory_item_id)),
    questions: [...questions.values()].sort((a, b) => compareCodeUnits(a.question_id, b.question_id)),
    omissions: omissions.sort((a, b) => compareCodeUnits(a.surface_id, b.surface_id)), lens_decisions: lensDecisions,
    ...(signal_dispositions.length ? { signal_dispositions } : {}) };
}

// Prior claims and structural/analyzer cues nominate bounded subjects; only the
// planner applies lens selection and turns those subjects into final questions.
function routePriorReviewSignals(
  bundle: ArtifactBundle,
  fullScope: boolean,
  operationRows: readonly Operation[],
  resolveRef: ReturnType<typeof discoverOperationEntries>["resolveRef"],
  sourceStatus: ReturnType<typeof reviewSourceScope>["sourceStatus"],
  add: AddSubject,
  disposition: RecordSignalDisposition,
): void {
  const distinctRefs = (refs: readonly ReviewSourceRef[]) => [...new Map(
    refs.map(ref => [stableStringify(ref), ref]),
  ).entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, ref]) => ref);
  for (const difference of bundle.charter_register?.differences ?? []) {
    const key = `charter:${difference.difference_id}`;
    const refs = difference.accounts.flatMap((account) => account.provenance
      .flatMap(({ ref }) => resolveRef(ref) ?? []));
    const sources = distinctRefs(refs.filter(({ path }) => sourceStatus(path) === undefined));
    const contract = distinctRefs(refs.filter(({ path }) => sourceStatus(path, true) === undefined));
    const material = difference.finding_candidate && (difference.relation === "incompatible" || difference.covered_channel_gap === true);
    if (!material || sources.length === 0) {
      disposition(key, "not_promoted", !material ? "Agreement or complementary context, not a material disagreement."
        : "Material charter difference lacks a resolved in-scope source anchor.", contract);
      continue;
    }
    const target = add("architecture", key, "invariant", "Charter and implementation fit", sources, contract,
      [`Decide whether this material charter gap changes the supported operation: ${difference.gap}`,
        ...difference.accounts.map(account => `${account.kind}: ${account.claim}`),
        ...(difference.fidelity ? [`Prior fidelity review (${difference.fidelity.verdict}): ${difference.fidelity.rationale}`] : []),
        "Identify the governing account and the source-backed discrepancy, or explain agreement or which evidence is missing."].join("\n"),
      { evidence: [[key, digest(difference)]] });
    disposition(key, "promoted", "Material charter comparison with reviewable source.", contract, target);
  }

  type Finding = NonNullable<ArtifactBundle["design_assessment"]>["findings"][number];
  const anchors = (finding: Finding) => distinctRefs(finding.affected_files.flatMap(location => {
    const item = typeof location === "string" ? resolveRef(location) : {
      path: location.path,
      ...(location.line_start ? { start_line: location.line_start } : {}),
      ...(location.line_end ? { end_line: location.line_end } : {}),
      ...(location.symbol ? { symbol: location.symbol } : {}),
    };
    return item && sourceStatus(item.path) === undefined ? [item] : [];
  }));
  const lanes = [
    ["contract", bundle.design_assessment?.contract_reviewed ? bundle.design_assessment.contract_findings : []],
    ["conceptual", bundle.design_assessment?.conceptual_reviewed ? bundle.design_assessment.conceptual_findings : []],
    ["systemic", bundle.systemic_challenge?.findings],
  ] as const;
  for (const [lane, claims] of lanes) for (const claim of claims ?? []) {
    const key = `design-${lane}:${claim.id}`, refs = anchors(claim);
    if (!refs.length || claim.grounding?.status === "refuted" || claim.severity === "info") {
      disposition(key, "not_promoted", !refs.length ? "Accepted claim lacks a resolved in-scope source anchor."
        : claim.grounding?.status === "refuted" ? "Prior executable evidence refuted the claim."
          : "Informational context is not a verification obligation.", refs);
      continue;
    }
    const lens = claimLens(claim.lens);
    const expectation = `Verify the accepted ${lane} claim without assuming its conclusion: ${claim.title}. ${claim.summary}\n` +
      "Trace the implicated callers and resulting state. Decide whether the claimed consequence is supported, current behavior is justified, or essential evidence is missing.";
    const target = add(lens, key, "invariant", claim.title, refs, [], expectation, { evidence: [[key, digest(claim)]] });
    disposition(key, "promoted", `Accepted ${lane} claim preserved for verification, not treated as proof.`, refs, target);
  }

  // Prefer actual relationship endpoints, exact in-file sites, or a unique
  // workflow. Full scope can also verify a file-wide complexity cue without
  // mistaking the metric for a particular mechanism or a verdict.
  const groups = new Map<string, { operation?: Operation; fileWide?: boolean; routine?: ReviewSourceRef; items: Array<{ lead: Finding; refs: ReviewSourceRef[] }> }>();
  const namedRelationship = new Set(["architectural_seam", "dependency_cycle", "hidden_coupling"]);
  const metricFamily = new Set(["complexity_hotspot", "code_duplication"]);
  const pathMetrics = new Map<string, number>();
  const structural = (bundle.design_assessment?.findings ?? []).map(lead => {
    const refs = anchors(lead);
    const paths = ordered(refs.map(ref => ref.path));
    const allPathsBound = new Set(lead.affected_files.map(item => typeof item === "string" ? item : item.path)).size === paths.length;
    return { lead, refs, paths, allPathsBound };
  });
  const routineAnchors = new Map<string, ReviewSourceRef[]>();
  for (const { lead, refs, allPathsBound } of structural) {
    const ref = refs[0];
    if (lead.lens !== "architecture" || lead.category !== "complexity_hotspot" || !allPathsBound ||
        refs.length !== 1 || !ref || (!ref.symbol && (ref.start_line === undefined || ref.end_line === undefined))) continue;
    const sameFile = routineAnchors.get(ref.path) ?? [];
    if (!sameFile.some(candidate => stableStringify(candidate) === stableStringify(ref))) sameFile.push(ref);
    routineAnchors.set(ref.path, sameFile);
  }
  const sameRoutine = (anchor: ReviewSourceRef, site: ReviewSourceRef) => {
    if (anchor.path !== site.path || (anchor.symbol && site.symbol && anchor.symbol !== site.symbol)) return false;
    if (anchor.start_line !== undefined && anchor.end_line !== undefined &&
        site.start_line !== undefined && site.end_line !== undefined) {
      return anchor.start_line <= site.start_line && site.end_line <= anchor.end_line;
    }
    return anchor.symbol !== undefined && anchor.symbol === site.symbol;
  };
  for (const { lead, paths } of structural) {
    if (paths.length === 1) {
      const key = stableStringify([lead.category, paths[0]]);
      pathMetrics.set(key, (pathMetrics.get(key) ?? 0) + 1);
    }
  }
  const directCalls = new Map<string, Set<string>>();
  for (const edge of bundle.graph_bundle?.graphs.calls ?? []) {
    const targets = directCalls.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    directCalls.set(edge.from, targets);
  }
  // A flow's broad path inventory is not proof of ownership. Its entry
  // must be the site itself or call the site directly. Imports from tests
  // are not evidence that the subject executes there. Ambiguity leaves the
  // signal independent or in need of a locator.
  const workflowFor = (paths: string[]) => {
    const operations = operationRows.filter(op => paths.every(path =>
      op.refs.some(ref => ref.path === path) &&
      (path === op.entry || directCalls.get(op.entry)?.has(path))));
    const direct = operations.filter(op => paths.includes(op.entry));
    const candidates = direct.length > 0 ? direct : operations;
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  for (const { lead, refs, paths, allPathsBound } of structural) {
    const key = `design-lead:${lead.id}`;
    const relationship = namedRelationship.has(lead.category) && paths.length > 1 && allPathsBound;
    const exactSites = refs.length > 0 && refs.every(ref => ref.start_line !== undefined || ref.symbol !== undefined);
    const oneMetricPerFile = paths.length === 1 && metricFamily.has(lead.category) &&
      pathMetrics.get(stableStringify([lead.category, paths[0]])) === 1;
    const workflow = refs.length && allPathsBound && !relationship && (!exactSites || oneMetricPerFile)
      ? workflowFor(paths) : undefined;
    const fileWide = fullScope && lead.category === "complexity_hotspot" && allPathsBound &&
      paths.length === 1 && !isTestPath(paths[0]!) && !exactSites && !workflow;
    if (lead.lens !== "architecture" || (!relationship && !exactSites && !workflow && !fileWide)) {
      disposition(key, "not_promoted", !refs.length ? "No resolved in-scope source anchor."
        : lead.lens !== "architecture" ? "Signal is not an architecture verification question."
          : lead.category === "orphan_units" ? "No bound unit-wide locator: a representative file does not establish reachability of the unit."
          : "Needs a locator: no concrete site, fully bound relationship, or unique discovered workflow. Record a named caller or source span to verify it.", refs);
      continue;
    }
    // Group only identical concrete sites/relationships, or two metric
    // families whose entire footprint fits inside one unambiguous routine.
    // An operation gives context, not permission to group its unrelated files.
    const routines = paths.length === 1 && allPathsBound && metricFamily.has(lead.category) && exactSites
      ? (routineAnchors.get(paths[0]!) ?? []).filter(anchor =>
        lead.category === "complexity_hotspot" ? refs.length === 1 && stableStringify(anchor) === stableStringify(refs[0])
          : refs.length > 1 && refs.every(ref => sameRoutine(anchor, ref)))
      : [];
    const routine = routines.length === 1 ? routines[0] : undefined;
    const operation = routine ? workflowFor(paths) : workflow;
    const mechanism = stableStringify(routine ? ["complexity_hotspot", [routine]]
      : exactSites ? [lead.category, refs] : relationship ? [lead.category, paths]
        : fileWide ? [lead.category, "file-wide", paths, lead.summary] : [lead.category, operation?.id, paths, lead.summary]);
    const group = groups.get(mechanism) ?? { operation, fileWide, routine, items: [] };
    group.items.push({ lead, refs });
    groups.set(mechanism, group);
  }
  for (const [mechanism, { operation, fileWide, routine, items: group }] of groups) {
    group.sort((a, b) => compareCodeUnits(a.lead.id, b.lead.id));
    const first = group[0]!.lead;
    const entry = operation?.refs.find(ref => ref.path === operation.entry);
    const refs = distinctRefs([...(entry ? [entry] : []), ...group.flatMap(item => item.refs)]);
    const evidence = group.map(({ lead }) => [`design-lead:${lead.id}`, digest(lead)] as const);
    const topic = first.category.replaceAll("_", " ");
    const joint = routine && group.some(({ lead }) => lead.category !== first.category);
    const decision = joint
      ? "Decide whether one simplification preserves the caller contract while addressing both the complexity and duplicated responsibility, or whether the cues justify separate changes, no change, or further evidence."
      : "Decide whether the actual caller makes this an avoidable cost, demonstrates a necessary boundary, or leaves specific evidence missing. A justified or disproven signal is an answered question.";
    const expectation = joint
      ? `Trace the routine at ${locator(routine)} and its live caller. Establish the behavior and contract any refactor must preserve.`
      : fileWide ? "Locate the relevant routine and its caller. A file-wide complexity metric is a cue, not a finding."
      : `Trace the actual caller or relationship for this ${topic} and establish the supported behavior any change must preserve.`;
    const parts = group.map(({ lead, refs }) => ({ part_id: `design-lead:${lead.id}`,
      expectation: `${lead.summary} Inspect ${refs.map(locator).join(", ")}.` }));
    const title = joint ? `Simplifying the routine at ${locator(routine)}` : first.title;
    const target = add("architecture", `design-mechanism:${mechanism}`, "invariant",
      operation ? `${operation.title}: ${title}` : title, refs, operation?.contract ?? [],
      `${expectation} Answer each source cue separately; do not treat a cue as a verdict. ${decision}`,
      { evidence, parts, context: { start: routine ?? entry ?? group[0]!.refs[0]!, behavior: operation?.expectation } });
    for (const [index, { lead, refs }] of group.entries()) {
      disposition(`design-lead:${lead.id}`, index ? "grouped" : "promoted",
        joint ? "Same concrete routine and simplification decision; independent requested part."
          : fileWide ? "Fully bound file-wide complexity cue in full scope; identify its actual routine and caller."
          : index ? "Same source relationship or exact site and mechanism; independent requested part." : "Concrete structural mechanism for review.", refs, target);
    }
  }
}
