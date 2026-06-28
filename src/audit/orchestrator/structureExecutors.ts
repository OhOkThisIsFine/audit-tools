import type { ArtifactBundle } from "../io/artifacts.js";
import { buildFileDisposition } from "../extractors/disposition.js";
import {
  buildGraphBundle,
  buildGraphBundleFromFs,
  mergeAnalyzerGraphContribution,
  type GraphEdgeCache,
} from "../extractors/graph.js";
import { buildCriticalFlowManifest } from "../extractors/flows.js";
import {
  buildRiskRegister,
  mergeAnalyzerRiskSignals,
  deriveRiskConcentration,
} from "../extractors/risk.js";
import {
  mineGitHistoryArtifact,
  gitHistoryGraphEdges,
  gitHistoryRiskSignals,
  GIT_CO_CHANGE_CATEGORY,
} from "../extractors/gitHistory.js";
import type { GitHistory } from "audit-tools/shared";
import { headCommit } from "audit-tools/shared";
import {
  canReuseGitHistory,
  deriveGitHistoryScopeKey,
  readGitHistoryBaseline,
  withGitHistoryBaseline,
} from "./gitHistoryBaseline.js";
import type { GitHistoryBaseline } from "../types/artifactMetadata.js";
import { buildSurfaceManifest } from "../extractors/surfaces.js";
import { buildUnitManifest } from "./unitBuilder.js";
import { buildDesignAssessment } from "../extractors/designAssessment.js";
import { deriveGraphSignals } from "../extractors/graphSignals.js";
import type { ExecutorRunResult } from "./executorResult.js";

export async function runStructureExecutor(
  bundle: ArtifactBundle,
  root?: string,
): Promise<ExecutorRunResult> {
  if (!bundle.repo_manifest) {
    throw new Error("Cannot run structure executor without repo_manifest");
  }

  const externalAnalyzerResults = bundle.external_analyzer_results;
  const disposition =
    bundle.file_disposition ??
    buildFileDisposition(bundle.repo_manifest, root ? { root } : {});
  const unitManifest = buildUnitManifest(bundle.repo_manifest, disposition);
  // C2 incremental graph-build: feed the prior per-file edge cache and collect a
  // refreshed one. buildGraphBundle reuses each file's cached contribution while
  // the global path set and that file's content are unchanged; any drift
  // re-extracts (fail-safe). The cache is persisted as a special bundle artifact.
  const edgeCacheSink: { cache?: GraphEdgeCache } = {};
  const graphBundle = root
    ? await buildGraphBundleFromFs(bundle.repo_manifest, root, disposition, {
        externalAnalyzerResults,
        priorEdgeCache: bundle.graph_edge_cache,
        edgeCacheSink,
      })
    : buildGraphBundle(bundle.repo_manifest, disposition, {
        externalAnalyzerResults,
        priorEdgeCache: bundle.graph_edge_cache,
        edgeCacheSink,
      });
  const surfaceManifest = buildSurfaceManifest(
    bundle.repo_manifest,
    disposition,
    { graphBundle },
  );
  const criticalFlows = buildCriticalFlowManifest(
    bundle.repo_manifest,
    surfaceManifest,
    disposition,
  );
  // Structural graph signals are derived from the dependency graph ONLY —
  // before git-history co-change edges are merged in — so temporal coupling
  // never feeds cycle / hub / seam detection (allGraphEdges also skips the
  // co_change bucket as defense-in-depth).
  const graphSignals = deriveGraphSignals(graphBundle);
  const baseRiskRegister = buildRiskRegister(
    unitManifest,
    criticalFlows,
    externalAnalyzerResults,
    graphSignals,
  );

  // F6 — git-history mining. A deterministic, language-neutral extraction source
  // (degrades to empty without a root / git): co-change coupling the dependency
  // graph misses, churn + authorship-breadth risk signals, and the churn ×
  // complexity compound (the real risk concentration). Merged through the shared
  // analyzer seams so it can never drift in how it re-enters graph / risk.
  //
  // Incremental structure phase (T5 #12): the mine is the costliest deterministic
  // step here, but its output is a pure function of (HEAD commit graph, in-scope
  // file set). When neither moved since the carried baseline, REUSE the prior
  // `git_history` instead of re-spawning git — any drift re-mines (fail-safe).
  const gitHistoryHead = root ? headCommit(root) : null;
  const gitHistoryScopeKey = deriveGitHistoryScopeKey(
    bundle.repo_manifest,
    disposition,
  );
  const reuseGitHistory =
    root !== undefined &&
    canReuseGitHistory({
      head: gitHistoryHead,
      scopeKey: gitHistoryScopeKey,
      priorBaseline: readGitHistoryBaseline(bundle.artifact_metadata),
      hasPriorArtifact: bundle.git_history !== undefined,
    });
  const gitHistory: GitHistory =
    reuseGitHistory && bundle.git_history
      ? bundle.git_history
      : root
        ? mineGitHistoryArtifact(root, bundle.repo_manifest, disposition)
        : { co_change: [], churn: [], authorship: [] };
  // Record a refreshed baseline only when HEAD is known (git available). Reuse
  // keeps the prior baseline (head/scope already matched); a re-mine stamps the
  // live head + scope key. No head ⇒ no baseline recorded (re-mines next run).
  const gitHistoryBaseline: GitHistoryBaseline | undefined =
    gitHistoryHead !== null
      ? { head: gitHistoryHead, scope_key: gitHistoryScopeKey }
      : undefined;

  const coChangeEdges = gitHistoryGraphEdges(gitHistory);
  let graphWithCoChange = mergeAnalyzerGraphContribution(
    graphBundle,
    coChangeEdges,
    { category: GIT_CO_CHANGE_CATEGORY },
  );
  if (coChangeEdges.length > 0) {
    graphWithCoChange = {
      ...graphWithCoChange,
      analyzers_used: [
        ...new Set([...(graphWithCoChange.analyzers_used ?? []), "git-history"]),
      ].sort(),
    };
  }

  const riskRegister = deriveRiskConcentration(
    mergeAnalyzerRiskSignals(
      baseRiskRegister,
      gitHistoryRiskSignals(gitHistory, unitManifest),
    ),
  );

  return {
    updated: {
      ...bundle,
      file_disposition: disposition,
      unit_manifest: unitManifest,
      surface_manifest: surfaceManifest,
      graph_bundle: graphWithCoChange,
      critical_flows: criticalFlows,
      risk_register: riskRegister,
      git_history: gitHistory,
      graph_edge_cache: edgeCacheSink.cache ?? bundle.graph_edge_cache,
      artifact_metadata: gitHistoryBaseline
        ? withGitHistoryBaseline(bundle.artifact_metadata, gitHistoryBaseline)
        : bundle.artifact_metadata,
    },
    artifacts_written: [
      "file_disposition.json",
      "unit_manifest.json",
      "surface_manifest.json",
      "graph_bundle.json",
      "critical_flows.json",
      "risk_register.json",
      "git_history.json",
    ],
    progress_summary:
      `Built structure artifacts for ${unitManifest.units.length} units and ${criticalFlows.flows.length} critical flows.` +
      (criticalFlows.fallback_required
        ? " Deterministic flow inference did not fully meet the confidence bar."
        : ""),
  };
}

export function runDesignAssessmentExecutor(
  bundle: ArtifactBundle,
): ExecutorRunResult {
  if (
    !bundle.unit_manifest ||
    !bundle.graph_bundle ||
    !bundle.critical_flows ||
    !bundle.risk_register
  ) {
    throw new Error(
      "Cannot run design assessment executor without structure artifacts",
    );
  }

  const designAssessment = buildDesignAssessment({
    unitManifest: bundle.unit_manifest,
    graphBundle: bundle.graph_bundle,
    criticalFlows: bundle.critical_flows,
    riskRegister: bundle.risk_register,
  });

  const previous = bundle.design_assessment;
  if (previous) {
    // Carry forward review completion flags and findings from a prior assessment.
    if (previous.contract_reviewed) {
      designAssessment.contract_reviewed = true;
      designAssessment.contract_findings = previous.contract_findings ?? [];
    }
    if (previous.conceptual_reviewed) {
      designAssessment.conceptual_reviewed = true;
      designAssessment.conceptual_findings = previous.conceptual_findings ?? [];
    }
    // Backward-compat: legacy artifacts only have `reviewed` / `review_findings`.
    if (previous.reviewed && !previous.contract_reviewed && !previous.conceptual_reviewed) {
      designAssessment.reviewed = true;
      designAssessment.review_findings = previous.review_findings ?? [];
    }
  }

  return {
    updated: {
      ...bundle,
      design_assessment: designAssessment,
    },
    artifacts_written: ["design_assessment.json"],
    progress_summary: `Design assessment complete: ${designAssessment.findings.length} structural finding(s).`,
  };
}

export function runDesignReviewAutoComplete(
  bundle: ArtifactBundle,
  pass: "contract" | "conceptual" | "both" = "both",
): ExecutorRunResult {
  const existing = bundle.design_assessment;
  if (!existing) {
    throw new Error(
      "Cannot auto-complete design review without design_assessment artifact",
    );
  }

  const updated = { ...existing };

  if (pass === "contract" || pass === "both") {
    updated.contract_reviewed = true;
    updated.contract_findings = existing.contract_findings ?? [];
  }
  if (pass === "conceptual" || pass === "both") {
    updated.conceptual_reviewed = true;
    updated.conceptual_findings = existing.conceptual_findings ?? [];
  }

  // Remove legacy fields to keep artifacts clean going forward.
  delete updated.reviewed;
  delete updated.review_findings;

  const passLabel = pass === "both" ? "both passes" : `${pass} pass`;
  return {
    updated: {
      ...bundle,
      design_assessment: updated,
    },
    artifacts_written: ["design_assessment.json"],
    progress_summary:
      `Design review auto-completed (${passLabel}; host-agent review available via next-step).`,
  };
}
