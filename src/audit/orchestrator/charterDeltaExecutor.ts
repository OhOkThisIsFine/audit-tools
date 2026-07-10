import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterRegister } from "../types/charterRegister.js";
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
    const settled: CharterRegister = register
      ? { ...register, generated_at, deltas_pending: false }
      : {
          generated_at,
          target: "charter",
          ceiling: { rung: "shallow" },
          status: "omitted",
          subsystems: [],
          goal_graph: { nodes: [], edges: [] },
          deltas: [],
          findings: [],
          validation_issues: [],
          deltas_pending: false,
        };
    return {
      updated: { ...bundle, charter_register: settled },
      artifacts_written: ["charter_register.json"],
      progress_summary: !register
        ? "Charter delta-mining omitted (no charter register to mine)."
        : register.deltas_pending !== true
          ? "Charter delta-mining omitted (register not awaiting deltas)."
          : "Charter delta-mining: no submission supplied; settled the register with no deltas.",
    };
  }

  const assembled = assembleDeltas(submission, register.subsystems);
  // Ground each surfaced delta-finding's evidence against disk (the provenance
  // grounding this pure-assembly module deferred to the ingest — parity with the
  // design-review findings path).
  const findings = groundDesignFindings(assembled.findings, bundle.repo_manifest);

  const updated: CharterRegister = {
    ...register,
    generated_at,
    deltas: assembled.deltas,
    findings,
    goal_graph: assembled.goal_graph,
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
      `${updated.findings.length} finding(s)` +
      (assembled.validation_issues.length > 0
        ? `, ${assembled.validation_issues.length} gate drop(s).`
        : "."),
  };
}
