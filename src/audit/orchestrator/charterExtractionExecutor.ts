// sites-pinned: tests/audit/charter-extraction-executor.test.ts
import { join } from "node:path";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  CHARTER_REGISTER_SCHEMA_VERSION,
  type CharterRegister,
} from "../types/charterRegister.js";
import {
  CHARTER_PACKET_MANIFEST_SCHEMA_VERSION,
  CharterLaneKindSchema,
  assembleLaneGraph,
  proposeCorrespondences,
  checkCitations,
  laneAssetsDir,
  readOptionalJsonFile,
  type CharterPacketCoverage,
  type CharterPacketManifest,
  type CharterLaneGraph,
  type CharterLaneSubmission,
  type Ceiling,
  type CitationValidationSummary,
  type DeliveredExcerpt,
  type IntentCheckpoint,
  resolveRunBoundDesignReview,
} from "audit-tools/shared";
import { charterExtractionCoverageFilename } from "../cli/laneSubmissions.js";
import { charterExtractionKindsForCeiling } from "../cli/charterExtractionPrompt.js";

/** The tool-merged extraction submission: every lane's DAG, in canonical kind order. */
export interface CharterExtractionMerged {
  lanes: CharterLaneSubmission[];
}

/**
 * Resolve the charter-layer ceiling from the confirmed checkpoint. The ceiling is
 * the consent dial captured at `intent_checkpoint`; when the host never set it we
 * fall back to the run-bound `conceptual_depth` (deep → a `deep` ceiling) and default
 * to `shallow` — conversation-first, the charter layer is opt-in. Exported so the
 * obligation gate and the prompt renderer resolve depth identically (one source).
 */
export function resolveCharterCeiling(
  checkpoint: IntentCheckpoint | undefined,
): Ceiling {
  const dr = checkpoint?.design_review;
  if (dr?.ceiling) return dr.ceiling;
  if (resolveRunBoundDesignReview(checkpoint)?.conceptual_depth === "deep") {
    return { rung: "deep" };
  }
  return { rung: "shallow" };
}

/** Whether the ceiling authorizes a charter-extraction pass at all (deep or deeper). */
export function ceilingRequestsCharters(ceiling: Ceiling): boolean {
  return ceiling.rung === "deep" || ceiling.rung === "deepest";
}

/** Provenance kinds whose `ref` is a repository path, so a citation check applies. */
const PATH_SHAPED_PROVENANCE = new Set(["doc", "code", "comment"]);

/**
 * Read the per-kind packet manifests the EMIT pass persisted. The packet is built
 * at emit and the register is written at ingest — different invocations — so the
 * manifest is the only way this pass can know what each blind lane was actually
 * handed. A missing manifest is an abstention, never an assumption.
 */
async function loadPacketManifests(
  artifactsDir: string | undefined,
  ceiling: Ceiling,
): Promise<CharterPacketManifest[]> {
  if (!artifactsDir) return [];
  const manifests: CharterPacketManifest[] = [];
  for (const kind of charterExtractionKindsForCeiling(ceiling)) {
    const manifest = await readOptionalJsonFile<CharterPacketManifest>(
      join(laneAssetsDir(artifactsDir), charterExtractionCoverageFilename(kind)),
    );
    if (
      manifest?.schema_version === CHARTER_PACKET_MANIFEST_SCHEMA_VERSION &&
      manifest.coverage
    ) {
      manifests.push(manifest);
    }
  }
  return manifests;
}

/** Canonical kind order — content-derived, never arrival order. */
function kindIndex(kind: string): number {
  const index = CharterLaneKindSchema.options.indexOf(kind as CharterLaneGraph["kind"]);
  return index < 0 ? 99 : index;
}

function sortCoverage(
  coverage: readonly CharterPacketCoverage[],
): CharterPacketCoverage[] {
  return [...coverage].sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind));
}

/**
 * Check every path-shaped provenance citation the lane DAGs carry — on nodes AND
 * on edges — against the repository and against the line runs the packets
 * actually delivered. `citation_validation` is the affirmation that the check
 * RAN: an empty issue list is only ever emitted beside a stated status and count.
 */
export function checkLaneCitations(
  lanes: readonly CharterLaneGraph[],
  options: { root?: string; manifests: readonly CharterPacketManifest[] },
): { issues: string[]; summary: CitationValidationSummary } {
  const citations: { owner_id: string; ref: string; quote?: string }[] = [];
  let citationCount = 0;
  for (const lane of lanes) {
    const owners = [
      ...lane.nodes.map((n) => ({ id: `${lane.kind}:${n.node_id}`, provenance: n.provenance })),
      ...lane.edges.map((e) => ({ id: `${lane.kind}:${e.from}->${e.to}`, provenance: e.provenance })),
    ];
    for (const owner of owners) {
      for (const provenance of owner.provenance) {
        citationCount += 1;
        if (!PATH_SHAPED_PROVENANCE.has(provenance.kind)) continue;
        citations.push({
          owner_id: owner.id,
          ref: provenance.ref,
          ...(provenance.quote ? { quote: provenance.quote } : {}),
        });
      }
    }
  }

  if (!options.root) {
    // A RECORDED ABSTENTION, never an implicit pass.
    return {
      issues: [],
      summary: {
        status: "not_run",
        citation_count: citationCount,
        checked_count: 0,
        failed_count: 0,
        delivered_evidence_checked: false,
      },
    };
  }

  const delivered: DeliveredExcerpt[] = options.manifests.flatMap((manifest) =>
    manifest.excerpts.map((excerpt) => ({
      source_path: excerpt.source_path,
      line_runs: excerpt.line_runs,
      prefix_width: excerpt.prefix_width,
    })),
  );
  const result = checkCitations({
    root: options.root,
    corpus: new Set<string>(),
    citations,
    ...(options.manifests.length > 0 ? { delivered } : {}),
  });
  const failures = result.checks.filter((check) => check.verdict !== "ok");
  return {
    issues: failures.map(
      (check) =>
        `${check.owner_id}: citation "${check.ref}" ${check.verdict}${check.detail ? ` — ${check.detail}` : ""}`,
    ),
    summary: {
      status: "checked",
      citation_count: citationCount,
      checked_count: result.checked_count,
      failed_count: failures.length,
      delivered_evidence_checked: result.delivered_evidence_checked,
    },
  };
}

/** An empty register — the omit shape, shared by every charter executor's omit branch. */
export function emptyCharterRegister(
  ceiling: Ceiling,
  generated_at: string,
  status: "omitted" | undefined,
): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at,
    target: "charter",
    ceiling,
    ...(status ? { status } : {}),
    lanes: [],
    candidates: [],
    correspondences: [],
    differences: [],
    findings: [],
    validation_issues: [],
    evidence_coverage: [],
    // A pass that authored nothing has nothing to certify. Reporting `checked`
    // here would be an affirmation over work never examined.
    citation_validation: {
      status: "no_citations",
      citation_count: 0,
      checked_count: 0,
      failed_count: 0,
      delivered_evidence_checked: false,
    },
  };
}

/**
 * Charter-extraction executor (step 1). Two modes, gated by the ceiling:
 *
 * - **omit** (`shallow` ceiling, or no submission): write an empty `status:omitted`
 *   register so the obligation is satisfied with no LLM pass.
 * - **ingest** (`deep`/`deepest` ceiling + the merged lane submissions): assemble
 *   each lane's goal DAG (ids unique, edges resolve, cycles refused, levels
 *   derived, scopes grounded — `assembleLaneGraph`), CHECK every path-shaped
 *   provenance citation on nodes and edges against the repository and the packets,
 *   PROPOSE the correspondence candidates deterministically, and flag
 *   `comparison_pending` whenever any lane produced a node — the comparison reader
 *   (a different pass; no author marks its own homework) is owed the next turn.
 *
 * `root` and `artifactsDir` are OPTIONAL: the omit branch needs no disk, and
 * forcing a root would throw before the `not_run` abstention could be recorded.
 */
export async function runCharterExtractionExecutor(
  bundle: ArtifactBundle,
  submission: CharterExtractionMerged | undefined,
  options: { root?: string; artifactsDir?: string } = {},
): Promise<ExecutorRunResult> {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  if (!submission || !ceilingRequestsCharters(ceiling)) {
    const omitted = emptyCharterRegister(ceiling, generated_at, "omitted");
    return {
      updated: { ...bundle, charter_register: omitted },
      artifacts_written: ["charter_register.json"],
      progress_summary:
        ceilingRequestsCharters(ceiling) && !submission
          ? "Charter extraction: no submission supplied; recorded an empty register."
          : `Charter extraction omitted (ceiling '${ceiling.rung}' does not request the charter layer).`,
    };
  }

  const universe = new Set(
    (bundle.repo_manifest?.files ?? []).map((file) => file.path),
  );
  const validation_issues: string[] = [];
  const lanes: CharterLaneGraph[] = [];
  for (const lane of [...submission.lanes].sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind))) {
    const assembled = assembleLaneGraph(lane, { universe });
    lanes.push(assembled.graph);
    validation_issues.push(...assembled.validation_issues);
  }

  const manifests = await loadPacketManifests(options.artifactsDir, ceiling);
  const citation = checkLaneCitations(lanes, {
    ...(options.root ? { root: options.root } : {}),
    manifests,
  });
  const candidates = proposeCorrespondences(lanes);
  const nodeCount = lanes.reduce((n, l) => n + l.nodes.length, 0);

  const register: CharterRegister = {
    ...emptyCharterRegister(ceiling, generated_at, undefined),
    lanes,
    candidates,
    validation_issues: [...validation_issues, ...citation.issues],
    evidence_coverage: sortCoverage(manifests.map((manifest) => manifest.coverage)),
    citation_validation: citation.summary,
    comparison_pending: nodeCount > 0,
  };
  const dropSummary =
    register.validation_issues.length > 0
      ? `, ${register.validation_issues.length} validation issue(s):\n` +
        register.validation_issues.map((m) => `  - ${m}`).join("\n")
      : ".";
  return {
    updated: { ...bundle, charter_register: register },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter extraction complete: ${lanes.length} lane DAG(s), ${nodeCount} node(s), ` +
      `${candidates.length} correspondence candidate(s)` +
      (register.comparison_pending ? " awaiting the comparison reader" : "") +
      dropSummary,
  };
}
