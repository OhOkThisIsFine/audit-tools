import { join } from "node:path";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  CHARTER_REGISTER_SCHEMA_VERSION,
  type CharterRegister,
} from "../types/charterRegister.js";
import {
  CHARTER_PACKET_MANIFEST_SCHEMA_VERSION,
  CharterKindSchema,
  assembleCharters,
  checkCitations,
  laneAssetsDir,
  readOptionalJsonFile,
  type CharterPacketCoverage,
  type CharterPacketManifest,
  type CharterSubmission,
  type CharterSubsystem,
  type Ceiling,
  type CitationValidationSummary,
  type DeliveredExcerpt,
  type IntentCheckpoint,
} from "audit-tools/shared";
import { charterExtractionCoverageFilename } from "../cli/laneSubmissions.js";
import { charterExtractionKindsForCeiling } from "../cli/charterExtractionPrompt.js";

/**
 * Resolve the charter-layer ceiling from the confirmed checkpoint. The ceiling is
 * the consent dial captured at `intent_checkpoint`; when the host never set it we
 * fall back to the legacy `conceptual_depth` (deep → a `deep` ceiling) and default
 * to `shallow` — conversation-first, the charter layer is opt-in. Exported so the
 * obligation gate and the prompt renderer resolve depth identically (one source).
 */
export function resolveCharterCeiling(
  checkpoint: IntentCheckpoint | undefined,
): Ceiling {
  const dr = checkpoint?.design_review;
  if (dr?.ceiling) return dr.ceiling;
  if (dr?.conceptual_depth === "deep") return { rung: "deep" };
  return { rung: "shallow" };
}

/** Whether the ceiling authorizes a charter-extraction pass at all (deep or deeper). */
export function ceilingRequestsCharters(ceiling: Ceiling): boolean {
  return ceiling.rung === "deep" || ceiling.rung === "deepest";
}

/**
 * Build the `node_id → members` lookup from the Phase-B consensus scaffold. Only
 * CONSENSUS nodes (confident on both robustness scores) are charter-reviewable;
 * contested nodes are hotspots, not subsystems. A submission referencing any other
 * node is grounded out by `assembleCharters`.
 */
function consensusMembers(bundle: ArtifactBundle): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const node of bundle.structure_decomposition?.consensus ?? []) {
    members.set(node.node_id, node.members);
  }
  return members;
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

/** Canonical kind order for `evidence_coverage` — content-derived, never arrival order. */
function sortCoverage(
  coverage: readonly CharterPacketCoverage[],
): CharterPacketCoverage[] {
  const order = new Map(
    CharterKindSchema.options.map((kind, index) => [kind, index] as const),
  );
  return [...coverage].sort(
    (a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99),
  );
}

/**
 * Check every path-shaped provenance citation the submission carried, against
 * the repository and against what the packets actually delivered.
 *
 * `validation_issues: []` printed identically at 1-of-15 correct citations and at
 * 75-of-75, because its only two producers were node-file membership and the
 * True-charter gate — and the overshoots lived in `provenance[].ref`, a field the
 * check never read. This is the check that was missing, and
 * `citation_validation` is the affirmation that it RAN: an empty issue list is
 * only ever emitted beside a stated status and a stated count.
 */
function checkCharterCitations(
  subsystems: readonly CharterSubsystem[],
  options: { root?: string; manifests: readonly CharterPacketManifest[] },
): { issues: string[]; summary: CitationValidationSummary } {
  const citations: { owner_id: string; ref: string; quote?: string }[] = [];
  let citationCount = 0;
  for (const subsystem of subsystems) {
    for (const charter of subsystem.charters ?? []) {
      for (const provenance of charter.provenance ?? []) {
        citationCount += 1;
        if (!PATH_SHAPED_PROVENANCE.has(provenance.kind)) continue;
        citations.push({
          owner_id: charter.charter_id,
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

/**
 * Charter-extraction executor (Phase C). Two modes, gated by the ceiling:
 *
 * - **omit** (`shallow` ceiling, or no submission): write an empty `status:omitted`
 *   register so the obligation is satisfied with no LLM pass. Mirrors the
 *   synthesis-narrative omit — the charter layer is opt-in at a `deep`+ ceiling.
 * - **ingest** (`deep`/`deepest` ceiling + a host submission): validate + assemble
 *   the gated CHARTERS from the submission (the deterministic enforcement half —
 *   id assignment, per-kind merge, the Phase-A True gate; `assembleCharters`),
 *   grounding every subsystem against the consensus scaffold, then CHECKING every
 *   path-shaped provenance citation against the repository and against the line
 *   runs the packets actually delivered. This pass authors charters ONLY — the
 *   deltas + goal_graph are mined by the INDEPENDENT charter_delta pass (no author
 *   marks its own homework), so the register is left with empty
 *   deltas/findings/goal_graph and `deltas_pending` set whenever it produced ≥1
 *   subsystem for the delta-miner to reason over.
 *
 * `root` and `artifactsDir` are both OPTIONAL and are passed through unchanged.
 * They are NOT required: the omit branch needs no disk at all, and forcing a root
 * would throw before the `not_run` abstention could ever be recorded — which
 * would make the abstention unreachable and the affirmation a lie.
 */
export async function runCharterExtractionExecutor(
  bundle: ArtifactBundle,
  submission: CharterSubmission | undefined,
  options: { root?: string; artifactsDir?: string } = {},
): Promise<ExecutorRunResult> {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  if (!submission || !ceilingRequestsCharters(ceiling)) {
    const omitted: CharterRegister = {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at,
      target: "charter",
      ceiling,
      status: "omitted",
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      triangulated: [],
      disagreement: [],
      validation_issues: [],
      evidence_coverage: [],
      // A pass that authored nothing has nothing to certify. Reporting
      // `checked` here would be an affirmation over work never examined —
      // the false-green shape this field exists to close.
      citation_validation: {
        status: "no_citations",
        citation_count: 0,
        checked_count: 0,
        failed_count: 0,
        delivered_evidence_checked: false,
      },
    };
    return {
      updated: { ...bundle, charter_register: omitted },
      artifacts_written: ["charter_register.json"],
      progress_summary:
        ceilingRequestsCharters(ceiling) && !submission
          ? "Charter extraction: no submission supplied; recorded an empty register."
          : `Charter extraction omitted (ceiling '${ceiling.rung}' does not request the charter layer).`,
    };
  }

  // The repo universe every teleology node's file scope must ground against —
  // the manifest's complete path set (the host cannot conjure files the repo
  // does not contain).
  const universe = new Set(
    (bundle.repo_manifest?.files ?? []).map((file) => file.path),
  );
  const assembled = assembleCharters(submission, {
    hint: consensusMembers(bundle),
    universe,
  });

  const manifests = await loadPacketManifests(options.artifactsDir, ceiling);
  const citation = checkCharterCitations(assembled.subsystems, {
    ...(options.root ? { root: options.root } : {}),
    manifests,
  });

  const register: CharterRegister = {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at,
    target: "charter",
    ceiling,
    subsystems: assembled.subsystems,
    // Deltas + goal_graph + triangulation are the INDEPENDENT delta-miner's
    // product (Phase C.2); left empty here and flagged `deltas_pending` so
    // charter_delta_current owes a turn whenever this pass produced ≥1 subsystem
    // to mine.
    goal_graph: { nodes: [], edges: [] },
    deltas: [],
    findings: [],
    triangulated: [],
    disagreement: [],
    validation_issues: [...assembled.validation_issues, ...citation.issues],
    evidence_coverage: sortCoverage(
      manifests.map((manifest) => manifest.coverage),
    ),
    citation_validation: citation.summary,
    deltas_pending: assembled.subsystems.length > 0,
  };
  // Surface each gate-drop MESSAGE, not just a count — a silently-dropped charter
  // (e.g. a second charter of the same kind for a subsystem, kept-first) is
  // invisible to the operator when only "N gate drop(s)" is shown, so they never
  // learn a submission was over-count and discarded. The messages are short
  // one-liners (assembleCharters), so listing them is bounded and cheap.
  const dropSummary =
    register.validation_issues.length > 0
      ? `, ${register.validation_issues.length} validation issue(s):\n` +
        register.validation_issues.map((m) => `  - ${m}`).join("\n")
      : ".";
  return {
    updated: { ...bundle, charter_register: register },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter extraction complete: ${register.subsystems.length} subsystem(s)` +
      (register.deltas_pending ? " awaiting the independent delta-miner" : "") +
      dropSummary,
  };
}
