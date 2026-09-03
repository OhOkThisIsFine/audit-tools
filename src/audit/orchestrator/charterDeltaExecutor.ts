import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  CHARTER_REGISTER_SCHEMA_VERSION,
  type CharterRegister,
} from "../types/charterRegister.js";
import {
  assembleDeltas,
  groundDesignFindings,
  type CharterDeltaSubmission,
} from "audit-tools/shared";

/**
 * Charter-DELTA executor (Phase C.2). The INDEPENDENT delta-miner half of the
 * charter layer: the charter-extraction pass authored the charters only and left
 * the register with `deltas_pending`; this pass reads those already-assembled
 * charters and mines the pairwise deltas + the goal DAG across subsystems. Keeping
 * it a SEPARATE pass realigns to the design of record — no author marks its own
 * homework, `revealed` was extracted blind to the deltas it will later disagree
 * with. Two modes, mirroring charter_extraction:
 *
 * - **omit** (no register, register not `deltas_pending`, or no submission): write
 *   the register back with `deltas_pending: false` and its existing (possibly
 *   empty) deltas/findings/goal_graph — the obligation self-satisfies with no host
 *   turn (e.g. an omitted register, or a register with no subsystems to mine).
 * - **ingest** (a `deltas_pending` register + a host submission): assemble the
 *   routed+gated deltas from the submission (the deterministic enforcement half —
 *   the design's routing table, the Phase-A low-confidence gate; `assembleDeltas`),
 *   ground every surfaced delta-finding's evidence against disk, and clear
 *   `deltas_pending`.
 */
export function runCharterDeltaExecutor(
  bundle: ArtifactBundle,
  submission: CharterDeltaSubmission | undefined,
): ExecutorRunResult {
  const generated_at = new Date().toISOString();
  const register = bundle.charter_register;

  if (!register || register.deltas_pending !== true || !submission) {
    // Nothing to mine (or nothing to mine it FROM): settle the register so the
    // obligation is satisfied without a host turn. Preserve whatever deltas/
    // findings/goal_graph it already carries (normally empty).
    // A `deltas_pending` register settled with NO submission is a DEAD-MINER
    // settle, not a clean mine (a clean mine affirms `no_deltas: true` on its
    // submission). Record the distinction on the register so downstream readers
    // never mistake "no miner ran" for "mined clean".
    const deadMinerSettle = register !== undefined && register.deltas_pending === true && !submission;
    const settled: CharterRegister = register
      ? {
          ...register,
          generated_at,
          deltas_pending: false,
          ...(deadMinerSettle
            ? {
                validation_issues: [
                  ...register.validation_issues,
                  "deltas settled without a miner submission — deltas here are UNMINED, not affirmed-clean (a clean mine submits `no_deltas: true`).",
                ],
              }
            : {}),
        }
      : {
          schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
          generated_at,
          target: "charter",
          ceiling: { rung: "shallow" },
          status: "omitted",
          subsystems: [],
          goal_graph: { nodes: [], edges: [] },
          deltas: [],
          findings: [],
          triangulated: [],
          disagreement: [],
          validation_issues: [],
          // There is no register to mine, so nothing was authored and nothing is
          // certified. `no_citations` rather than `checked`: this pass examined
          // no work, and an affirmation over work never examined is the exact
          // false-green the field exists to close. (The settle branch above
          // spreads the existing register, so a real one carries its own
          // affirmation and coverage through unchanged.)
          citation_validation: {
            status: "no_citations",
            citation_count: 0,
            checked_count: 0,
            failed_count: 0,
            delivered_evidence_checked: false,
          },
          evidence_coverage: [],
          deltas_pending: false,
        };
    return {
      updated: { ...bundle, charter_register: settled },
      artifacts_written: ["charter_register.json"],
      progress_summary: !register
        ? "Charter delta-mining omitted (no charter register to mine)."
        : register.deltas_pending !== true
          ? "Charter delta-mining omitted (register not awaiting deltas)."
          : "Charter delta-mining: no submission supplied; settled the register with " +
            "UNMINED deltas (not affirmed-clean — recorded as a register validation issue).",
    };
  }

  // True nominations are admissible at the DEEPEST rung only — the consent gate
  // that used to live on the extraction lane set (design resolution 4: `true` is
  // nominated downstream of triangulation, never extracted). Rung-keyed, matching
  // the retired lane's semantics; `explicit_opt_in` stays the capture-time
  // contract on setting a deepest ceiling.
  const assembled = assembleDeltas(submission, register.subsystems, {
    allowTrueNominations: register.ceiling.rung === "deepest",
  });
  // Ground each surfaced delta-finding's evidence against disk (the provenance
  // grounding this pure-assembly module deferred to the ingest — parity with the
  // design-review findings path).
  const findings = groundDesignFindings(assembled.findings, bundle.repo_manifest);

  const updated: CharterRegister = {
    ...register,
    generated_at,
    // The miner may have appended gate-surviving True nominations to a unit's
    // charters — persist the augmented subsystems, not the pre-mine ones.
    subsystems: assembled.subsystems,
    deltas: assembled.deltas,
    findings,
    goal_graph: assembled.goal_graph,
    triangulated: assembled.triangulated,
    disagreement: assembled.disagreement,
    validation_issues: [
      ...register.validation_issues,
      ...assembled.validation_issues,
    ],
    deltas_pending: false,
  };
  return {
    updated: { ...bundle, charter_register: updated },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter delta-mining complete: ${updated.deltas.length} routed delta(s) → ` +
      `${updated.findings.length} finding(s), ${updated.triangulated.length} ` +
      `triangulated telos(es)` +
      (assembled.validation_issues.length > 0
        ? `, ${assembled.validation_issues.length} gate drop(s).`
        : "."),
  };
}
