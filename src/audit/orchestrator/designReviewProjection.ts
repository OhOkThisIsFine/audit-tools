/**
 * Semantic / structural projection for audit-code's design-review passes
 * (B2/B3 parity port).
 *
 * The design-review passes (contract-assessment + conceptual-design-critique)
 * read a structural context assembled from several intake/structure artifacts
 * (`renderSharedStructuralContext` in `designReviewPrompt.ts`): the file
 * inventory, unit boundaries, dependency graph, externally-reachable surfaces,
 * critical flows, the risk register, and the deterministic structural findings.
 * When any of those upstreams change, the review's verdict can go stale.
 *
 * The naive trigger — "any byte changed" — re-runs the (expensive, LLM-driven)
 * review on cosmetic churn: a re-derived `generated_at`, a file's content hash
 * moving, a reordered list. This module is the audit-code half of the shared
 * semantic-projection policy (remediate-code's `contractPipeline/
 * semanticProjection.ts` is the other): each reviewed input is projected to ONLY
 * the load-bearing structure the review actually reasons about — provenance and
 * metrics stripped, each entry narrowed to its derivable fields and the
 * collections canonically ordered. A cosmetic upstream edit projects to the same
 * value (review stays fresh); a real structural change (a new module, a changed
 * interface, a new surface, a re-scored risk) projects differently and correctly
 * re-stales the review.
 *
 * This mirrors remediate-code's `DERIVABLE_MODULE_CONTRACT_FIELDS` narrowing —
 * the "finalized-style structural projection" — applied to audit's structural
 * artifact set. The generic diff + hashing machinery is single-sourced in
 * `audit-tools/shared/reReview`.
 */
import {
  stableStringifyProjection,
  type CriticalFlowManifest,
  type GraphBundle,
  type IntentCheckpoint,
  type RiskRegister,
  type SurfaceManifest,
} from "audit-tools/shared";
import type { RepoManifest, UnitManifest } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import { deriveUnitScopeDisposition } from "./intentScopeDisposition.js";

/**
 * The narrow read-only slice of the artifact bundle the design-review projection
 * needs. Defined locally (rather than importing `ArtifactBundle` from
 * `io/artifacts.ts`) so this module — and `designReviewSnapshot.ts`, which the
 * bundle loader imports — do not form an import cycle with `io/artifacts.ts`.
 * `ArtifactBundle` is structurally assignable to this.
 */
export interface DesignReviewBundle {
  repo_manifest?: RepoManifest;
  unit_manifest?: UnitManifest;
  graph_bundle?: GraphBundle;
  surface_manifest?: SurfaceManifest;
  critical_flows?: CriticalFlowManifest;
  risk_register?: RiskRegister;
  design_assessment?: DesignAssessment;
  /**
   * The confirmed intent checkpoint, read ONLY to derive each unit's structured
   * in-scope/excluded disposition (see `projectUnitManifest`). The cosmetic
   * bracket-tag reason text is not projected — only the disposition KIND, which
   * the prompt renders as `[in scope]` vs `[excluded: …]` and which the review
   * actually reasons about (which units to skip).
   */
  intent_checkpoint?: IntentCheckpoint;
}

/**
 * The structural artifacts the design-review passes read. A design-review
 * snapshot records the projection of each of these; a change to any of them
 * (in projection) re-stales the review.
 */
export const DESIGN_REVIEW_INPUTS = [
  "repo_manifest",
  "unit_manifest",
  "graph_bundle",
  "surface_manifest",
  "critical_flows",
  "risk_register",
  "design_assessment",
] as const;

export type DesignReviewInput = (typeof DESIGN_REVIEW_INPUTS)[number];

/** Stable sort of a collection by its projection string (order-independent input). */
function sortByProjection<T>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    stableStringifyProjection(a).localeCompare(stableStringifyProjection(b)),
  );
}

function sortStrings(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/**
 * Project the file inventory to repository identity + the set of source files
 * by path and language. Per-file metrics (`size_bytes`, `hash`) and the
 * `generated_at` stamp are provenance — a content edit that does not add/remove a
 * file or change its language does not re-stale the architecture review (which
 * re-roams the live code regardless). Excluded files are dropped: they are not
 * part of the reviewed surface, and toggling exclusion is captured via their
 * presence/absence here.
 */
function projectRepoManifest(bundle: DesignReviewBundle): unknown {
  const manifest = bundle.repo_manifest;
  if (!manifest) return null;
  const files = (manifest.files ?? [])
    .filter((file) => !file.excluded)
    .map((file) => ({ path: file.path, language: file.language }));
  return {
    name: manifest.repository?.name ?? null,
    files: sortByProjection(files),
  };
}

/**
 * Project units to their boundaries: id, name, kind, files, lenses, flows, and
 * the structured in-scope/excluded `scope` disposition.
 *
 * The `scope` field keeps dc4's per-unit determination INSIDE the projection so a
 * scope change re-stales: when an `excluded_scope` / `disposition_overrides` edit
 * flips a unit between in-scope and excluded, the prompt's `[in scope]` vs
 * `[excluded: …]` tag flips with it, and the review must re-run (a unit it was
 * told to skip is now reviewable, or vice versa). Only the disposition KIND is
 * captured, NOT the reason text: the bracket-tag reason (`[excluded: <reason>]`)
 * is cosmetic prose — re-wording "third-party code" to "third party" does not
 * change which units the review covers, so it must not re-stale. The reason is
 * read by no other downstream consumer (only this one prompt-render path puts it
 * in front of the model, and it carries no machine-checkable meaning), so
 * excluding it is sound under CE-008.
 */
function projectUnitManifest(bundle: DesignReviewBundle): unknown {
  const units = bundle.unit_manifest?.units;
  if (!units) return null;
  const checkpoint = bundle.intent_checkpoint;
  const projected = units.map((unit) => ({
    unit_id: unit.unit_id,
    name: unit.name,
    kind: unit.kind ?? null,
    files: sortStrings(unit.files),
    required_lenses: sortStrings(unit.required_lenses),
    critical_flows: sortStrings(unit.critical_flows),
    scope: deriveUnitScopeDisposition(unit.files, checkpoint).kind,
  }));
  return sortByProjection(projected);
}

/**
 * Project the dependency graph to its edge sets per kind. Each edge narrows to
 * its endpoints (`from`/`to`, or a route's `path`/`handler`/`method`); the
 * `confidence`/`reason`/`direction` annotations are analyzer provenance, not the
 * structure the review reasons about. Language-neutral: every graph kind is
 * walked, not a hardcoded subset.
 */
function projectGraphBundle(bundle: DesignReviewBundle): unknown {
  const graphs = bundle.graph_bundle?.graphs;
  if (!graphs) return null;
  const out: Record<string, unknown> = {};
  for (const [kind, edges] of Object.entries(graphs)) {
    if (!Array.isArray(edges)) continue;
    const projected = edges.map((edge) => {
      const record = (edge ?? {}) as Record<string, unknown>;
      if ("from" in record || "to" in record) {
        return { from: record.from ?? null, to: record.to ?? null };
      }
      if ("path" in record || "handler" in record) {
        return {
          path: record.path ?? null,
          handler: record.handler ?? null,
          method: record.method ?? null,
        };
      }
      return record;
    });
    out[kind] = sortByProjection(projected);
  }
  return out;
}

/** Project surfaces to id, kind, entrypoint, exposure, methods (notes dropped). */
function projectSurfaceManifest(bundle: DesignReviewBundle): unknown {
  const surfaces = bundle.surface_manifest?.surfaces;
  if (!surfaces) return null;
  const projected = surfaces.map((surface) => ({
    id: surface.id,
    kind: surface.kind,
    entrypoint: surface.entrypoint,
    exposure: surface.exposure ?? null,
    methods: sortStrings(surface.methods),
  }));
  return sortByProjection(projected);
}

/** Project flows to id, name, entrypoints, paths, concerns, confidence. */
function projectCriticalFlows(bundle: DesignReviewBundle): unknown {
  const flows = bundle.critical_flows?.flows;
  if (!flows) return null;
  const projected = flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    entrypoints: sortStrings(flow.entrypoints),
    paths: sortStrings(flow.paths),
    concerns: sortStrings(flow.concerns),
    confidence: flow.confidence ?? null,
  }));
  return sortByProjection(projected);
}

/** Project risk items to unit_id, score, signals (notes dropped). */
function projectRiskRegister(bundle: DesignReviewBundle): unknown {
  const items = bundle.risk_register?.items;
  if (!items) return null;
  const projected = items.map((item) => ({
    unit_id: item.unit_id,
    risk_score: item.risk_score,
    signals: sortStrings(item.signals),
  }));
  return sortByProjection(projected);
}

/**
 * Project the design assessment to ONLY its deterministic structural `findings`
 * (the slice the review actually reads), each narrowed to its identity/content
 * fields. The review verdicts the passes themselves write
 * (`contract_findings` / `conceptual_findings` / the `*_reviewed` flags) are
 * deliberately excluded — including them would make the review's own output an
 * input to its staleness (a self-referential re-stale loop). `generated_at` is
 * provenance.
 */
function projectDesignAssessmentFindings(bundle: DesignReviewBundle): unknown {
  const findings = bundle.design_assessment?.findings;
  if (!findings) return null;
  const projected = findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    lens: finding.lens,
    summary: finding.summary,
    affected_files: sortStrings(
      (finding.affected_files ?? []).map((location) => location.path),
    ),
    systemic: finding.systemic ?? false,
  }));
  return sortByProjection(projected);
}

const PROJECTORS: Record<DesignReviewInput, (bundle: DesignReviewBundle) => unknown> = {
  repo_manifest: projectRepoManifest,
  unit_manifest: projectUnitManifest,
  graph_bundle: projectGraphBundle,
  surface_manifest: projectSurfaceManifest,
  critical_flows: projectCriticalFlows,
  risk_register: projectRiskRegister,
  design_assessment: projectDesignAssessmentFindings,
};

/**
 * Project a single design-review input artifact from the bundle to its
 * load-bearing structure. Returns `null` when the artifact is absent.
 */
export function projectDesignReviewInput(
  input: DesignReviewInput,
  bundle: DesignReviewBundle,
): unknown {
  return PROJECTORS[input](bundle);
}

/**
 * Project every design-review input to its load-bearing structure, keyed by
 * input name — the captured shape a design-review snapshot records and a
 * re-review diffs against.
 */
export function projectDesignReviewInputs(
  bundle: DesignReviewBundle,
): Record<DesignReviewInput, unknown> {
  const out = {} as Record<DesignReviewInput, unknown>;
  for (const input of DESIGN_REVIEW_INPUTS) {
    out[input] = PROJECTORS[input](bundle);
  }
  return out;
}
