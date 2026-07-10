import { changedFiles, gitRefExists, isGitRepo, pathMatchesPrefix } from "audit-tools/shared";
import type { GraphBundle } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { CoverageMatrix } from "../types.js";
import type { AuditScopeBudget, AuditScopeManifest } from "../types/auditScope.js";
import { buildDispositionMap } from "../extractors/disposition.js";
import { buildPathLookup } from "../extractors/graph.js";
import {
  HIGH_FAN_DEGREE_THRESHOLD,
  buildGraphDegreeIndex,
  collectGraphEdges,
  graphEdgeConfidence,
  normalizeGraphPath,
} from "./reviewPacketGraph.js";

/** Default cap on in-scope files (seeds + expanded) before expansion stops. */
export const DEFAULT_SCOPE_MAX_FILES = 200;
/** Graph edges below this confidence are never traversed during expansion. */
export const SCOPE_EDGE_CONFIDENCE_FLOOR = 0.5;
/**
 * Expansion stops along a path once the accumulated path-confidence (the product
 * of the traversed edge confidences) drops below this floor. With no fixed hop
 * count, this — together with hub-skipping and the file budget — bounds the
 * frontier deterministically.
 */
export const SCOPE_MIN_FRONTIER_CONFIDENCE = 0.5;

export interface ComputeAuditScopeInput {
  /** The git ref the delta is measured against. */
  since: string;
  /** Raw changed paths (git output, posix-relative). */
  changed: string[];
  /** Canonical auditable file paths (repo-manifest paths, non-excluded). */
  includedFiles: string[];
  /** Dependency graph used to expand from seeds to neighbours. */
  graphBundle?: GraphBundle;
  budget?: AuditScopeBudget;
}

/**
 * Deterministic priority-frontier expansion (Phase 3). Starting from the changed
 * files (seeds), walk the dependency graph outward, always visiting the neighbour
 * with the highest accumulated path-confidence first (tie-broken by path). High
 * fan-in/out hubs are skipped so a single change near a hub does not drag the
 * whole repo into scope, low-confidence edges are dropped, and expansion halts at
 * the file budget or when the best remaining frontier confidence falls below the
 * floor. Same inputs → identical scope.
 */
export function computeAuditScope(
  input: ComputeAuditScopeInput,
): AuditScopeManifest {
  const maxFiles = input.budget?.max_files ?? DEFAULT_SCOPE_MAX_FILES;

  // normalized graph key -> canonical (repo-manifest) path for auditable files.
  const canonicalByNorm = new Map<string, string>();
  for (const file of input.includedFiles) {
    const key = normalizeGraphPath(file);
    if (!canonicalByNorm.has(key)) {
      canonicalByNorm.set(key, file);
    }
  }

  // Seeds = changed files that are auditable (present in the manifest). Changed
  // files that are excluded, deleted, or otherwise absent simply drop out.
  const seedKeys: string[] = [];
  const seedSeen = new Set<string>();
  for (const path of input.changed) {
    const key = normalizeGraphPath(path);
    if (canonicalByNorm.has(key) && !seedSeen.has(key)) {
      seedSeen.add(key);
      seedKeys.push(key);
    }
  }

  const edges = collectGraphEdges(input.graphBundle);
  const degree = buildGraphDegreeIndex(edges);
  const isHub = (key: string): boolean =>
    (degree.fanIn.get(key) ?? 0) > HIGH_FAN_DEGREE_THRESHOLD ||
    (degree.fanOut.get(key) ?? 0) > HIGH_FAN_DEGREE_THRESHOLD;

  // Bidirectional adjacency: a change to a file is relevant to what it depends
  // on AND to what depends on it. Edges below the confidence floor are dropped.
  const adjacency = new Map<string, Array<{ to: string; confidence: number }>>();
  const addEdge = (from: string, to: string, confidence: number): void => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, confidence });
    adjacency.set(from, list);
  };
  for (const edge of edges) {
    const confidence = graphEdgeConfidence(edge);
    if (confidence < SCOPE_EDGE_CONFIDENCE_FLOOR) {
      continue;
    }
    const from = normalizeGraphPath(edge.from);
    const to = normalizeGraphPath(edge.to);
    addEdge(from, to, confidence);
    addEdge(to, from, confidence);
  }

  // Max-product shortest-path frontier. `best` holds the highest accumulated
  // confidence discovered for each node; seeds start at 1.
  const best = new Map<string, number>();
  for (const key of seedKeys) {
    best.set(key, 1);
  }
  const visited = new Set<string>();
  const inScope = new Set<string>(seedKeys);
  const expandedKeys: string[] = [];
  let budgetHit = false;

  for (;;) {
    let pick: string | undefined;
    let pickConfidence = -1;
    for (const [key, confidence] of best) {
      if (visited.has(key)) continue;
      if (
        confidence > pickConfidence ||
        (confidence === pickConfidence && (pick === undefined || key < pick))
      ) {
        pick = key;
        pickConfidence = confidence;
      }
    }
    if (pick === undefined || pickConfidence < SCOPE_MIN_FRONTIER_CONFIDENCE) {
      break;
    }
    visited.add(pick);

    // Record newly-reached auditable files (seeds are already in scope).
    if (canonicalByNorm.has(pick) && !inScope.has(pick)) {
      if (inScope.size >= maxFiles) {
        budgetHit = true;
        process.stderr.write(
          JSON.stringify({
            kind: "scope_budget_hit",
            max_files: maxFiles,
            since: input.since,
            seed_count: seedKeys.length,
            ts: new Date().toISOString(),
          }) + "\n",
        );
        break;
      }
      inScope.add(pick);
      expandedKeys.push(pick);
    }

    // Relax neighbours, skipping hubs (never traverse through or into a hub) and
    // non-auditable nodes.
    for (const neighbour of adjacency.get(pick) ?? []) {
      if (isHub(neighbour.to) || !canonicalByNorm.has(neighbour.to)) {
        continue;
      }
      const candidate = pickConfidence * neighbour.confidence;
      if (candidate < SCOPE_MIN_FRONTIER_CONFIDENCE) {
        continue;
      }
      if (candidate > (best.get(neighbour.to) ?? 0)) {
        best.set(neighbour.to, candidate);
      }
    }
  }

  const seedFiles = seedKeys
    .map((key) => canonicalByNorm.get(key)!)
    .sort((a, b) => a.localeCompare(b));
  const expandedFiles = expandedKeys
    .map((key) => canonicalByNorm.get(key)!)
    .sort((a, b) => a.localeCompare(b));

  const notes: string[] = [];
  if (seedFiles.length === 0) {
    notes.push(`No auditable files changed since ${input.since}.`);
  }
  if (budgetHit) {
    notes.push(
      `Expansion stopped at the ${maxFiles}-file budget; some graph neighbours were left out of scope.`,
    );
  }

  return {
    mode: "delta",
    since: input.since,
    seed_files: seedFiles,
    expanded_files: expandedFiles,
    budget: { max_files: maxFiles },
    ...(notes.length > 0 ? { dropped_note: notes.join(" ") } : {}),
  };
}

/** A full-audit scope (the default, and every fallback). */
export function fullAuditScope(
  budget?: AuditScopeBudget,
  droppedNote?: string,
): AuditScopeManifest {
  return {
    mode: "full",
    since: null,
    seed_files: [],
    expanded_files: [],
    budget: { max_files: budget?.max_files ?? DEFAULT_SCOPE_MAX_FILES },
    ...(droppedNote ? { dropped_note: droppedNote } : {}),
  };
}

export interface ResolveAuditScopeInput {
  root?: string;
  /** The `--since` ref, if any. Absent/empty → full audit. */
  since?: string;
  bundle: ArtifactBundle;
  budget?: AuditScopeBudget;
}

/**
 * Resolve the scope for a planning run. Returns a full-audit scope unless a
 * `--since` ref was supplied against a real git repository; an unusable ref or
 * missing root degrades to a full audit with an honest note. Reads the auditable
 * file set from the repo manifest + disposition (the same lookup the graph
 * extractor uses) and the dependency graph from the bundle.
 */
export function resolveAuditScope(
  input: ResolveAuditScopeInput,
): AuditScopeManifest {
  const since = input.since?.trim();
  if (!since) {
    return fullAuditScope(input.budget);
  }
  if (!input.root) {
    return fullAuditScope(
      input.budget,
      `--since '${since}' was ignored: no repository root was available, so a full audit ran.`,
    );
  }
  if (!isGitRepo(input.root)) {
    return fullAuditScope(
      input.budget,
      `--since '${since}' was ignored: '${input.root}' is not a git repository, so a full audit ran.`,
    );
  }
  if (!gitRefExists(input.root, since)) {
    return fullAuditScope(
      input.budget,
      `--since '${since}' could not be resolved to a commit, so a full audit ran.`,
    );
  }

  const dispositionMap = buildDispositionMap(input.bundle.file_disposition);
  const includedFiles = input.bundle.repo_manifest
    ? [
        ...new Set(
          buildPathLookup(input.bundle.repo_manifest, dispositionMap).values(),
        ),
      ].sort((a, b) => a.localeCompare(b))
    : [];

  return computeAuditScope({
    since,
    changed: changedFiles(input.root, since),
    includedFiles,
    graphBundle: input.bundle.graph_bundle,
    budget: input.budget,
  });
}

/**
 * Apply a delta scope to a freshly-built coverage matrix. In-scope files (seeds
 * + expanded neighbours) keep their fresh `pending` status to be re-audited.
 * Out-of-scope files inherit a prior `complete` record verbatim when present (so
 * previously-finished work is preserved, not re-run), and are otherwise excluded
 * from this run with `classification_status: "out_of_scope_delta"`. Deterministic
 * exclusions (non-auditable/trivial) are left untouched. A full scope is a no-op.
 */
export function applyScopeToCoverage(
  coverage: CoverageMatrix,
  scope: AuditScopeManifest,
  priorCoverage?: CoverageMatrix,
): CoverageMatrix {
  if (scope.mode !== "delta") {
    return coverage;
  }
  const inScope = new Set<string>([
    ...scope.seed_files,
    ...scope.expanded_files,
  ]);
  const priorByPath = new Map(
    (priorCoverage?.files ?? []).map((file) => [file.path, file]),
  );

  for (const file of coverage.files) {
    if (file.audit_status === "excluded") {
      continue;
    }
    if (inScope.has(file.path)) {
      continue;
    }
    const prior = priorByPath.get(file.path);
    if (prior && prior.audit_status === "complete") {
      file.required_lenses = [...prior.required_lenses];
      file.completed_lenses = [...prior.completed_lenses];
      file.unit_ids = [...prior.unit_ids];
      file.audit_status = "complete";
      file.classification_status = prior.classification_status;
    } else {
      file.required_lenses = [];
      file.completed_lenses = [];
      file.unit_ids = [];
      file.audit_status = "excluded";
      file.classification_status = "out_of_scope_delta";
    }
  }
  return coverage;
}

/**
 * Apply the intent checkpoint's `excluded_scope` to a coverage matrix: any file
 * whose path matches an exclusion (exact or directory-prefix) is marked excluded
 * so it never becomes an audit task. The user's exclusions layer on top of the
 * deterministic disposition — they catch scope pollution the automatic pass
 * missed. Returns the newly-excluded paths (for the run summary / report); a
 * checkpoint with no exclusions is a no-op.
 */
export function applyIntentExclusionsToCoverage(
  coverage: CoverageMatrix,
  excludedScope: Array<{ path: string; reason: string }> | undefined,
): string[] {
  if (!excludedScope || excludedScope.length === 0) return [];
  const excluded: string[] = [];
  for (const file of coverage.files) {
    if (file.audit_status === "excluded") continue;
    if (
      excludedScope.some((entry) => pathMatchesPrefix(file.path, entry.path))
    ) {
      file.required_lenses = [];
      file.completed_lenses = [];
      file.unit_ids = [];
      file.audit_status = "excluded";
      file.classification_status = "out_of_scope_intent";
      excluded.push(file.path);
    }
  }
  return excluded;
}
