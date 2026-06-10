import type { ArtifactBundle } from "../io/artifacts.js";
import { buildFileDisposition } from "../extractors/disposition.js";
import {
  buildGraphBundle,
  buildGraphBundleFromFs,
} from "../extractors/graph.js";
import { buildCriticalFlowManifest } from "../extractors/flows.js";
import { buildRiskRegister } from "../extractors/risk.js";
import { buildSurfaceManifest } from "../extractors/surfaces.js";
import { buildUnitManifest } from "./unitBuilder.js";
import { buildDesignAssessment } from "../extractors/designAssessment.js";
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
  const graphBundle = root
    ? await buildGraphBundleFromFs(bundle.repo_manifest, root, disposition, {
        externalAnalyzerResults,
      })
    : buildGraphBundle(bundle.repo_manifest, disposition, {
        externalAnalyzerResults,
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
  const riskRegister = buildRiskRegister(
    unitManifest,
    criticalFlows,
    externalAnalyzerResults,
  );

  return {
    updated: {
      ...bundle,
      file_disposition: disposition,
      unit_manifest: unitManifest,
      surface_manifest: surfaceManifest,
      graph_bundle: graphBundle,
      critical_flows: criticalFlows,
      risk_register: riskRegister,
    },
    artifacts_written: [
      "file_disposition.json",
      "unit_manifest.json",
      "surface_manifest.json",
      "graph_bundle.json",
      "critical_flows.json",
      "risk_register.json",
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
  if (previous?.reviewed) {
    designAssessment.reviewed = true;
    designAssessment.review_findings = previous.review_findings ?? [];
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
): ExecutorRunResult {
  const existing = bundle.design_assessment;
  if (!existing) {
    throw new Error(
      "Cannot auto-complete design review without design_assessment artifact",
    );
  }

  const updated = {
    ...existing,
    reviewed: true,
    review_findings: existing.review_findings ?? [],
  };

  return {
    updated: {
      ...bundle,
      design_assessment: updated,
    },
    artifacts_written: ["design_assessment.json"],
    progress_summary:
      "Design review auto-completed (host-agent review available via next-step).",
  };
}
