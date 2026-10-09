// sites-pinned: tests/audit/artifacts-dir-rollover.test.ts
/**
 * The rollover of a finished audit's working dir into the next run (owner
 * decision 2026-10-08, "keep the artifacts dir"; record
 * docs/reviews/artifacts-dir-rollover-plan-2026-10-08.md).
 *
 * PROPERTY: the next run reuses every derived artifact whose inputs did not
 * change — the staleness DAG decides which — and inherits NOTHING that belongs
 * to the finished run. The carried set is an ALLOW-LIST: every entry not named
 * here is deleted, so a run-scoped file added later can never leak into the
 * next run by being forgotten.
 *
 * A run is FINISHED when its terminal step presented a promoted report: that
 * step writes the run-ended marker (`markRunEnded`). The marker, not byte
 * identity between the dir and the archive, is the gate: a host may still
 * append diagnostics after promotion, and an operator may resynthesize the
 * promoted deliverables, and neither may keep the next audit from starting.
 * The appended diagnostics are archived again here before anything is deleted.
 *
 * Deliberately NOT carried, and why:
 * - `audit_state.json`: a `complete` status short-circuits every derivation.
 * - The intake set (`repo_manifest`, `file_disposition`, `scope`,
 *   `scope_summary.json`): live-tree drift is never detected against a retained
 *   manifest, and `--since` is not a DAG input. Re-intake of an unchanged tree
 *   reproduces the same manifest content hash (`generated_at` is not semantic),
 *   so nothing downstream re-stales.
 * - Per-run choices (`intent_checkpoint`, consent and the analyzer results it
 *   admitted, `auto_fixes_applied`, host fallbacks, and the analyzer install
 *   settings in `analyzer-policy.json`): a per-run choice is never persisted
 *   into the next run.
 * - The finished run's deliverables in place (already promoted one level up)
 *   and every run-scoped record: steps, dispatch, runs, submissions and their
 *   ledger, staging, quarantine, lanes, scratch, friction, logs, handoff,
 *   guidance, the snapshot record.
 * - `tooling_manifest.json`: never read from disk; every bundle load rebuilds it.
 *
 * Measured (2026-10-08): over an UNCHANGED tree the next run re-derives only
 * deterministic planning (`audit_tasks`, `audit_plan_metrics`,
 * `task_affinity_graph`); the re-intaken manifest differs only in its
 * non-semantic `generated_at`, so the analysis artifacts and the host-judged
 * ones (charter, design assessment, systemic challenge) keep their revisions.
 */
import { existsSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AUDIT_FINDINGS_FILENAME,
  auditFindingsPath,
  promotedAuditFindingsPath,
  SESSION_INTENT_RELATIVE_PATH,
} from "audit-tools/shared";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import type { RunLogger } from "../../shared/observability/runLog.js";
import { ARTIFACT_DEFINITIONS, archiveRunDiagnostics } from "./artifacts.js";
import { removeRunSnapshot } from "./runSnapshot.js";
import { CHARTER_PACKET_ARCHIVE_DIRNAME } from "../orchestrator/charterPacketArchive.js";
import { SNAPSHOT_DIRNAME } from "../orchestrator/designReviewSnapshot.js";
import { graphEdgeCachePath } from "../orchestrator/graphEdgeCache.js";

/** Registry artifacts derived from the run's inputs, each staleness-judged by the DAG. */
const CARRIED_ARTIFACTS = [
  "artifact_metadata",
  "audit_results",
  "unit_manifest",
  "graph_bundle",
  "surface_manifest",
  "critical_flows",
  "flow_coverage",
  "risk_register",
  "git_history",
  "design_assessment",
  "conceptual_review_adjudication",
  "docs_digest",
  "structure_decomposition",
  "charter_register",
  "charter_clarification",
  "systemic_challenge",
  "analyzer_capability",
  "coverage_matrix",
  "runtime_validation_tasks",
  "runtime_validation_report",
  "audit_tasks",
  "audit_plan_metrics",
  "task_affinity_graph",
  "requeue_tasks",
  "access_memory",
  "synthesis_narrative",
] as const satisfies ReadonlyArray<keyof typeof ARTIFACT_DEFINITIONS>;

/** Content-keyed stores outside the registry, each self-invalidating. */
const CARRIED_STORES = [SNAPSHOT_DIRNAME, basename(graphEdgeCachePath("")), CHARTER_PACKET_ARCHIVE_DIRNAME];

/**
 * The operator's hand-authored repository intent (docs/audit-pkg/operator-guide.md).
 * It grants nothing to a run on its own; the tool never writes it.
 */
const CARRIED_INTENT = [basename(SESSION_INTENT_RELATIVE_PATH)];

const CARRIED: ReadonlySet<string> = new Set([
  ...CARRIED_ARTIFACTS.map((key) => ARTIFACT_DEFINITIONS[key].fileName),
  ...CARRIED_STORES,
  ...CARRIED_INTENT,
]);

const STATE_FILE = ARTIFACT_DEFINITIONS.audit_state.fileName;
const runEndedPath = (artifactsDir: string): string => join(artifactsDir, "run-ended.json");

/**
 * Record that the run ended: its terminal step presented a promoted report.
 * Written by the terminal step only after the promotion succeeded.
 */
export async function markRunEnded(artifactsDir: string): Promise<void> {
  await writeFile(runEndedPath(artifactsDir), "{}\n");
}

function warn(message: string): void {
  process.stderr.write(`[audit-code] ${message}\n`);
}

/**
 * Roll an ENDED run over (see `markRunEnded`), under the artifact-tree hold:
 * archive its diagnostics again, remove its snapshot, and delete every entry
 * that is not carried. The state file and the marker go LAST, so a rollover
 * that fails part-way is retried in full on the next call and never leaves a
 * run-scoped record (consent above all) for the next run to adopt. When a
 * diagnostic does not archive, or the snapshot cannot be removed, nothing is
 * deleted: the dir then holds the only copy, or the record of what to clean.
 * Returns whether it rolled the dir over.
 */
export async function rollOverFinishedRun(artifactsDir: string, runLogger?: RunLogger): Promise<boolean> {
  if (!existsSync(runEndedPath(artifactsDir))) return false;
  return await withArtifactTreeHold(artifactsDir, runLogger, async () => {
    if (!existsSync(runEndedPath(artifactsDir))) return false;
    // The machine contract is promoted at the terminal step, never re-copied
    // here (an operator may have resynthesized the promoted pair). An in-place
    // contract with no promoted copy is the only copy: keep the dir.
    if (existsSync(auditFindingsPath(artifactsDir)) && !existsSync(promotedAuditFindingsPath(artifactsDir))) {
      warn(`the finished audit in ${artifactsDir} was not rolled over: ${AUDIT_FINDINGS_FILENAME} has no promoted copy ` +
        `at ${promotedAuditFindingsPath(artifactsDir)}; copy it there, or run \`audit-code cleanup --force\` to discard it`);
      return false;
    }
    const { lost } = await archiveRunDiagnostics({ artifactsDir });
    if (lost.length > 0) {
      warn(`the finished audit in ${artifactsDir} was not rolled over: could not archive ${lost.join("; ")}`);
      return false;
    }
    const problems = await removeRunSnapshot(artifactsDir);
    if (problems.length > 0) {
      warn(`the finished audit in ${artifactsDir} was not rolled over: run snapshot cleanup: ${problems.join("; ")}`);
      return false;
    }
    // Lock files are never deleted: the hold this runs under owns one of them.
    const last = [STATE_FILE, basename(runEndedPath(artifactsDir))];
    for (const entry of await readdir(artifactsDir)) {
      if (CARRIED.has(entry) || entry.endsWith(".lock") || last.includes(entry)) continue;
      await rm(join(artifactsDir, entry), { recursive: true, force: true });
    }
    for (const entry of last) await rm(join(artifactsDir, entry), { force: true });
    return true;
  });
}
