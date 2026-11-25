// sites-pinned: tests/audit/review-submission.test.ts, tests/audit/design-review-diff-rereview.test.ts
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
 * Keep genuine source changes as well as structural changes in the input
 * revision. Intake supplies the digest from the frozen source; this projection
 * never reads files. Raw-byte binding remains separate from design freshness.
 * Timestamps, display coordinates, and raw CRLF conversion are not evidence.
 *
 * The generic diff + hashing machinery is single-sourced in
 * `audit-tools/shared/reReview`.
 */
import {
  stableStringifyProjection,
  hashContent,
  type CriticalFlowManifest,
  type GraphBundle,
  type RiskRegister,
  type SurfaceManifest,
  compareCodeUnits,
} from "audit-tools/shared";
import { projectDesignReviewTask, type DesignReviewTaskBundle } from "./designReviewTask.js";
import type { RepoManifest, UnitManifest } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import { designReviewPrimaryFiles, deriveUnitScopeDisposition } from "./intentScopeDisposition.js";

/**
 * The narrow read-only slice of the artifact bundle the design-review projection
 * needs. Defined locally (rather than importing `ArtifactBundle` from
 * `io/artifacts.ts`) so this module — and `designReviewSnapshot.ts`, which the
 * bundle loader imports — do not form an import cycle with `io/artifacts.ts`.
 * `ArtifactBundle` is structurally assignable to this.
 */
export interface DesignReviewBundle extends DesignReviewTaskBundle {
  repo_manifest?: RepoManifest;
  unit_manifest?: UnitManifest;
  graph_bundle?: GraphBundle;
  surface_manifest?: SurfaceManifest;
  critical_flows?: CriticalFlowManifest;
  risk_register?: RiskRegister;
  design_assessment?: DesignAssessment;
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

/**
 * Stable sort of a collection by its projection string (order-independent
 * input). Each item is stringified once, not once per comparison.
 */
function sortByProjection<T>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: stableStringifyProjection(item) }))
    .sort((a, b) => compareCodeUnits(a.key, b.key))
    .map(({ item }) => item);
}

function sortStrings(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/**
 * Project in-scope source paths, languages and their intake code identities.
 * The optional normalized digest is present only where CRLF was converted;
 * other files use the original hash. The raw byte count is not evidence.
 */
function projectRepoManifest(bundle: DesignReviewBundle): unknown {
  const manifest = bundle.repo_manifest;
  if (!manifest) return null;
  const inScope = new Set(designReviewPrimaryFiles(manifest.files.filter(file => !file.excluded).map(file => file.path), bundle.intent_checkpoint));
  const files = manifest.files
    .filter(file => inScope.has(file.path))
    .map((file) => ({ path: file.path, language: file.language, code_identity: file.normalized_hash ?? file.hash ?? null }));
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
  const excluded = new Set(bundle.repo_manifest?.files.filter(file => file.excluded).map(file => file.path));
  const projected = units.map((unit) => ({
    unit_id: unit.unit_id,
    name: unit.name,
    kind: unit.kind ?? null,
    files: sortStrings(unit.files),
    primary_files: sortStrings(designReviewPrimaryFiles(unit.files, checkpoint, excluded)),
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
          provenance: record.provenance ?? null,
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

/** Coordinates are navigation, not identity; retain only actual citation content. */
export function sortedDesignLeadLocations(locations: NonNullable<DesignAssessment["findings"]>[number]["affected_files"]) {
  return sortByProjection(locations.map(({ path, symbol, quoted_text, no_quotable_span }) => ({
    path,
    ...(symbol ? { symbol } : {}),
    ...(quoted_text ? { quoted_text: quoted_text.replaceAll("\r\n", "\n") } : {}),
    ...(no_quotable_span ? { no_quotable_span } : {}),
  })));
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
    affected_files: sortedDesignLeadLocations(finding.affected_files),
    systemic: finding.systemic ?? false,
    // The lead lineage rides the projection: this slice IS what a review pass
    // reads, so dropping the lineage here would hand the reviewer a deterministic
    // heuristic with nothing marking it as an unconfirmed lead — the exact
    // promotion-without-a-boundary failure the property forbids. `null` when the
    // finding has no lineage (a host-authored finding), so an old artifact and a
    // new one project identically where there is nothing to say.
    lead_lineage: finding.lead_lineage ? { producer: finding.lead_lineage.producer, confirmation: finding.lead_lineage.confirmation } : null,
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

/** The complete structural input identity shared by issuance and acceptance. */
export function designReviewInputRevision(bundle: DesignReviewBundle, pass: "contract" | "conceptual" = "contract"): string {
  return hashContent(stableStringifyProjection({ inputs: projectDesignReviewInputs(bundle), task: projectDesignReviewTask(bundle, pass) }));
}
