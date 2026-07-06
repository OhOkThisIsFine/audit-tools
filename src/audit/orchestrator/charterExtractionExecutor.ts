import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterRegister } from "../types/charterRegister.js";
import {
  assembleCharterRegister,
  type CharterSubmission,
  type Ceiling,
  type IntentCheckpoint,
} from "audit-tools/shared";
import { groundDesignFindings } from "audit-tools/shared";

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
 * node is grounded out by `assembleCharterRegister`.
 */
function consensusMembers(bundle: ArtifactBundle): Map<string, string[]> {
  const members = new Map<string, string[]>();
  for (const node of bundle.structure_decomposition?.consensus ?? []) {
    members.set(node.node_id, node.members);
  }
  return members;
}

/**
 * Charter-extraction executor (Phase C). Two modes, gated by the ceiling:
 *
 * - **omit** (`shallow` ceiling, or no submission): write an empty `status:omitted`
 *   register so the obligation is satisfied with no LLM pass. Mirrors the
 *   synthesis-narrative omit — the charter layer is opt-in at a `deep`+ ceiling.
 * - **ingest** (`deep`/`deepest` ceiling + a host submission): validate + assemble
 *   the gated register from the submission (the deterministic enforcement half —
 *   id assignment, routing table, Phase-A gates; `assembleCharterRegister`),
 *   grounding every subsystem against the consensus scaffold and every surfaced
 *   Finding's evidence against disk.
 */
export function runCharterExtractionExecutor(
  bundle: ArtifactBundle,
  submission: CharterSubmission | undefined,
): ExecutorRunResult {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  if (!submission || !ceilingRequestsCharters(ceiling)) {
    const omitted: CharterRegister = {
      generated_at,
      target: "charter",
      ceiling,
      status: "omitted",
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      validation_issues: [],
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

  const assembled = assembleCharterRegister(
    submission,
    consensusMembers(bundle),
  );
  // Ground each surfaced delta-finding's evidence against disk (the provenance
  // grounding this pure-assembly module deferred to the ingest — parity with the
  // design-review findings path).
  const findings = groundDesignFindings(assembled.findings, bundle.repo_manifest);

  const register: CharterRegister = {
    generated_at,
    target: "charter",
    ceiling,
    subsystems: assembled.subsystems,
    goal_graph: assembled.goal_graph,
    deltas: assembled.deltas,
    findings,
    validation_issues: assembled.validation_issues,
  };
  return {
    updated: { ...bundle, charter_register: register },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter extraction complete: ${register.subsystems.length} subsystem(s), ` +
      `${register.deltas.length} routed delta(s) → ${register.findings.length} finding(s)` +
      (register.validation_issues.length > 0
        ? `, ${register.validation_issues.length} gate drop(s).`
        : "."),
  };
}
