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
}

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
const sourceRefs = (paths: Iterable<string>) => ordered(paths).map(source);
const ids = (namespace: string, value: string) => `${namespace}:${hashContent(value, { length: 24 })}`;
const isBuiltIn = (value: string): value is BuiltInLens => Object.hasOwn(REVIEW_LENS_PLAYBOOKS, value);

function classifyConfiguration(path: string): "release" | "runtime" | undefined {
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

/**
 * Reconcile discovered execution surfaces and native wiring before assigning questions.
 * Neither planner priority nor the presence of a follow-up can make an entry disappear.
 */
export function buildReviewQuestionPlan(bundle: ArtifactBundle, options: PlanOptions): ReviewPlan {
  if (!options.snapshotId) throw new Error("Question planning requires a frozen snapshot identity");
  const intent = bundle.intent_checkpoint;
  const { files, dispositions, sourceStatus } = reviewSourceScope(bundle, options.scope);
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
  const subjects: Subject[] = [];
  const inventory: ReviewInventoryItem[] = [];
  const omissions: ReviewPlan["omissions"] = [];
  const owners = new Map<string, Set<string>>();
  for (const unit of bundle.unit_manifest?.units ?? []) for (const path of unit.files) {
    const units = owners.get(path) ?? new Set<string>();
    units.add(unit.unit_id);
    owners.set(path, units);
  }
  const ownership = (refs: readonly ReviewSourceRef[]) => ordered(refs.flatMap((ref) => [...(owners.get(ref.path) ?? [])]));
  const statements = bundle.charter_register?.lanes.find(({ kind }) => kind === "stated")?.nodes ?? [];
  const externalPaths = getExternalSignalPaths(bundle.external_analyzer_results);
  const add = (lens: Lens, key: string, kind: InventoryKind, title: string, refs: ReviewSourceRef[],
    contract: ReviewSourceRef[], expectation: string, linked?: Pick<Subject, "membership" | "evidence"> & { parts?: Part[] }) => {
    const item: ReviewInventoryItem = { inventory_item_id: ids(kind, key), kind,
      title, source_refs: refs, contract_refs: contract, scope: "in_scope" };
    if (!inventory.some(({ inventory_item_id }) => inventory_item_id === item.inventory_item_id)) inventory.push(item);
    subjects.push({ lens, inventory: item, expectation,
      parts: linked?.parts ?? [{ part_id: "supported-outcome", expectation }],
      membership: linked?.membership, evidence: linked?.evidence });
  };
  const operationRows: Operation[] = [];
  const routeCandidates = new Map<string, Set<string>>();
  for (const route of bundle.graph_bundle?.graphs.routes ?? []) {
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
  for (const surface of entrySurfaces.sort((a, b) => compareCodeUnits(a.id, b.id))) {
    const ref = resolveRef(surface.entrypoint);
    const reason = ref ? sourceStatus(ref.path) : "The discovered surface has no unique source binding in the frozen snapshot.";
    const related = ref ? (byEntry.get(ref.path) ?? []) : [];
    const title = related[0]?.name ?? surface.id;
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
    if (ref.symbol) refs[refs.findIndex(({ path }) => path === ref.path)] = ref;
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
    add("behavior", op.id, "operation", op.title, refs, contract, expectation, surface.registered
      ? { membership: [surface.entrypoint, ...surface.alternatives] } : undefined);
    if (op.declaredBoundary || externalPaths.has(ref.path) || related.some((flow) => flow.concerns.includes("security"))) {
      add("security", op.id, "trust_boundary", `Authority for ${title}`, refs, contract,
        "Identify the external or differently authorized caller, the enforced authority decision, and the protected effect.");
    }
    if (ownership(refs).length > 1) add("architecture", op.id, "operation", title, refs, contract,
      "Explain which components own the contract and decisions. Compare the present delegation with a concrete alternative and its trade-offs.",
      { membership: ownership(refs) });
    if (op.background || related.some((flow) => flow.concerns.includes("performance"))) {
      add("performance", op.id, "workload", `Representative workload: ${title}`, refs, contract,
        "Quantify or bound ordinary and relevant unchanged, cold, or retry workload time, memory, I/O, or spend where runnable; report hypotheses as hypotheses.");
    }
    if (surface.kind === "interface" || op.background) add("operability", op.id, "operator_transition", `Interpreting ${title}`, refs, contract,
      "Determine how a caller or operator distinguishes outcomes and chooses the next action from available output and state.");
    if (refs.some(({ path }) => isTestPath(path))) add("tests", op.id, "operation", title, refs, contract,
      "Name the support contract each reachable fixture asserts, what regression it would catch, and material gaps or execution cost.");
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
      { membership: members.map(({ id }) => id), parts: members.map((op) => ({
        part_id: op.id, expectation: `Establish how ${op.title} preserves the shared rule.`,
      })) });
  }

  for (const difference of bundle.charter_register?.differences ?? []) {
    if (difference.relation === "complementary") continue;
    const refs = difference.accounts.flatMap((account) => account.provenance
      .flatMap(({ ref }) => resolveRef(ref) ?? []));
    const sources = sourceRefs(refs.filter(({ path }) => sourceStatus(path) === undefined).map(({ path }) => path));
    if (sources.length === 0) continue;
    const contract = sourceRefs(refs.filter(({ path }) => sourceStatus(path, true) === undefined).map(({ path }) => path));
    add("architecture", `charter:${difference.difference_id}`, "invariant", "Charter and implementation fit", sources, contract,
      `Resolve what the evidence establishes about this recorded divergence: ${difference.gap}`,
      { evidence: [[`charter:${difference.difference_id}`, digest(difference)]] });
  }

  // The existing structural pass supplies local architecture leads even when
  // the implicated code is in one unit. Do not turn its signal into a verdict.
  for (const lead of bundle.design_assessment?.findings ?? []) {
    if (lead.lens !== "architecture") continue;
    const refs = sourceRefs(lead.affected_files.map(({ path }) => path).filter((path) => sourceStatus(path) === undefined));
    if (refs.length === 0) continue;
    add("architecture", `design-lead:${lead.id}`, "invariant", lead.title, refs, [],
      "Check the indicated structural or maintainability cost against actual callers, ownership and a concrete alternative; retain the justification for necessary complexity.",
      { evidence: [[`design-lead:${lead.id}`, digest(lead)]] });
  }

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
    const expectedOutcome = isBuiltIn(lens) ? `${subject.expectation} Optional review guidance: ${REVIEW_LENS_PLAYBOOKS[lens]}` : subject.expectation;
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
  return { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, snapshot_id: options.snapshotId,
    inventory: inventory.sort((a, b) => compareCodeUnits(a.inventory_item_id, b.inventory_item_id)),
    questions: [...questions.values()].sort((a, b) => compareCodeUnits(a.question_id, b.question_id)),
    omissions: omissions.sort((a, b) => compareCodeUnits(a.surface_id, b.surface_id)), lens_decisions: lensDecisions };
}
