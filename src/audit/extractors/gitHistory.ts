import { mineGitHistory } from "audit-tools/shared";
import type {
  GitHistory,
  GraphEdge,
  RiskRegister,
  RiskItem,
} from "audit-tools/shared";
import type { RepoManifest, UnitManifest } from "../types.js";
import type { FileDisposition } from "audit-tools/shared";
import { buildDispositionMap, isAuditExcludedStatus } from "./disposition.js";
import { graphEdge, graphLookupKey } from "./graphPathUtils.js";

/**
 * F6 — git-history mining.
 *
 * Deterministic extractor that turns the repository's commit log into the
 * language-neutral `git_history.json` artifact: co-change (temporal coupling),
 * churn (change frequency), and authorship breadth (bus-factor). All mining
 * runs through `audit-tools/shared`'s `mineGitHistory`, which itself degrades to
 * empty when git is unavailable / the log fails — so this extractor never
 * throws and is safe to run on any tree (including a fresh, history-less repo).
 *
 * Declared upstream deps: `{repo_manifest, file_disposition}`. Both are used to
 * scope mined paths to the audited file set (excluded / non-manifest paths are
 * dropped) so downstream consumers see only in-scope signals.
 */

const GIT_CO_CHANGE_EDGE_KIND = "git-co-change";
/**
 * Graph-bundle edge category co-change edges are merged into. DELIBERATELY its
 * own bucket (not `references`): co-change is temporal coupling, not a structural
 * dependency, so `allGraphEdges` (graphSignals) skips this category — co-change
 * never inflates fan-in/out, hubs, cycles, or seams. Consumers that want the
 * coupling view read `graph_bundle.graphs.co_change` explicitly.
 */
const GIT_CO_CHANGE_CATEGORY = "co_change";
/**
 * Co-change is a soft, historical signal (files that *happened* to change
 * together) — deliberately below the structural reference confidences so it
 * never outweighs a resolved import/reference edge.
 */
const CO_CHANGE_BASE_CONFIDENCE = 0.4;
const CO_CHANGE_CONFIDENCE_CAP = 0.75;

/** Authorship floor at/above which a unit is flagged broadly-owned. */
const BROAD_AUTHORSHIP_FLOOR = 4;
/** Churn floor at/above which a unit is flagged a change hotspot. */
const CHURN_HOTSPOT_FLOOR = 8;

/**
 * Mine `git_history.json` for `root`, keeping only paths present (and not
 * audit-excluded) in the manifest/disposition. Output is deterministic: the
 * shared miner already sorts every list by a total order, and the in-scope
 * filter preserves that order.
 */
/**
 * The set of in-scope, graph-normalized path keys the git-history mine is scoped
 * to: every manifest file that is neither file-excluded nor audit-excluded by
 * disposition. SINGLE-SOURCED here so the mine's in-scope filter and the
 * incremental-reuse scope key (`deriveGitHistoryScopeKey`) can never drift in
 * what "in scope" means.
 */
export function gitHistoryInScopeKeys(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
): string[] {
  const dispositionMap = buildDispositionMap(disposition);
  const keys: string[] = [];
  for (const file of repoManifest.files) {
    if (file.excluded) continue;
    const status = dispositionMap.get(file.path);
    if (status && isAuditExcludedStatus(status)) continue;
    keys.push(graphLookupKey(file.path));
  }
  return keys;
}

export function mineGitHistoryArtifact(
  root: string,
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
): GitHistory {
  const history = mineGitHistory(root);
  const inScope = new Set<string>(gitHistoryInScopeKeys(repoManifest, disposition));

  const known = (path: string): boolean => inScope.has(graphLookupKey(path));

  return {
    co_change: history.co_change.filter(
      (pair) => known(pair.a) && known(pair.b),
    ),
    churn: history.churn.filter((entry) => known(entry.path)),
    authorship: history.authorship.filter((entry) => known(entry.path)),
    ...(history.skipped_cochange_commits != null
      ? { skipped_cochange_commits: history.skipped_cochange_commits }
      : {}),
  };
}

/**
 * Project mined co-change pairs into language-neutral, undirected graph edges
 * suitable for merging into the graph bundle via
 * `mergeAnalyzerGraphContribution`. Confidence scales with co-change count
 * (more shared commits → stronger coupling) up to a cap. Degrades to an empty
 * list when there is no co-change history.
 */
export function gitHistoryGraphEdges(history: GitHistory): GraphEdge[] {
  return history.co_change.map((pair) =>
    graphEdge({
      from: pair.a,
      to: pair.b,
      kind: GIT_CO_CHANGE_EDGE_KIND,
      direction: "undirected",
      confidence: Math.min(
        CO_CHANGE_CONFIDENCE_CAP,
        CO_CHANGE_BASE_CONFIDENCE + 0.05 * (pair.commits - 1),
      ),
      reason: `Files changed together in ${pair.commits} commit(s) (temporal coupling).`,
    }),
  );
}

/**
 * Derive per-unit git-history risk signals (`change_hotspot`, `broad_authorship`)
 * keyed by `unit_id`, suitable for merging into the risk register via
 * `mergeAnalyzerRiskSignals`. A unit inherits a signal when ANY of its files is
 * so flagged. These are informational signals (they widen the picture, they do
 * not by themselves saturate risk). Degrades to empty when history is empty.
 */
export function gitHistoryRiskSignals(
  history: GitHistory,
  unitManifest: UnitManifest,
): Map<string, string[]> {
  const churnByPath = new Map(history.churn.map((e) => [e.path, e.commits]));
  const authorsByPath = new Map(
    history.authorship.map((e) => [e.path, e.authors]),
  );
  const signalsByUnit = new Map<string, string[]>();
  for (const unit of unitManifest.units) {
    const signals: string[] = [];
    if (
      unit.files.some((path) => (churnByPath.get(path) ?? 0) >= CHURN_HOTSPOT_FLOOR)
    ) {
      signals.push("change_hotspot");
    }
    if (
      unit.files.some(
        (path) => (authorsByPath.get(path) ?? 0) >= BROAD_AUTHORSHIP_FLOOR,
      )
    ) {
      signals.push("broad_authorship");
    }
    if (signals.length > 0) signalsByUnit.set(unit.unit_id, signals);
  }
  return signalsByUnit;
}

export type { GitHistory } from "audit-tools/shared";
export { GIT_CO_CHANGE_EDGE_KIND, GIT_CO_CHANGE_CATEGORY };
