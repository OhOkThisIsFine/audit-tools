// sites-pinned: tests/audit/charter-comparison-executor.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterRegister } from "../types/charterRegister.js";
import {
  assembleComparison,
  precheckFidelity,
  checkCitations,
  type CharterComparisonSubmission,
  type CharterProvenance,
} from "audit-tools/shared";
import { emptyCharterRegister } from "./charterExtractionExecutor.js";

/**
 * Charter-COMPARISON executor (steps 2–3). The comparison reader authored none
 * of the three lane DAGs; it confirmed, rejected, widened or added
 * correspondences over the tool's candidates and recorded the typed differences.
 * This executor is the enforcement half: `assembleComparison` grounds every
 * member and evidence ref, refuses malformed records with a named issue, and
 * routes each difference by the fixed table; then the MECHANICAL half of step 4
 * runs here — every finding candidate's cited quotes are re-read from disk and a
 * missing quote settles the record `unverifiable` before any lane sees it.
 *
 * - **omit** (no register, register not `comparison_pending`, or no submission):
 *   settle the register (`comparison_pending: false`) with no host turn. A pending
 *   register settled with NO submission is recorded as UNCOMPARED, never as
 *   affirmed-clean (a clean comparison submits `no_correspondences: true`).
 * - **ingest**: assemble, pre-check, and flag `fidelity_pending` when ≥1 finding
 *   candidate still awaits the fidelity lane.
 */
export function runCharterComparisonExecutor(
  bundle: ArtifactBundle,
  submission: CharterComparisonSubmission | undefined,
  options: { root?: string } = {},
): ExecutorRunResult {
  const generated_at = new Date().toISOString();
  const register = bundle.charter_register;

  if (!register || register.comparison_pending !== true || !submission) {
    const uncompared = register !== undefined && register.comparison_pending === true && !submission;
    const settled: CharterRegister = register
      ? {
          ...register,
          generated_at,
          comparison_pending: false,
          ...(uncompared
            ? {
                validation_issues: [
                  ...register.validation_issues,
                  "comparison settled without a reader submission — the lane DAGs are UNCOMPARED, not affirmed-clean (a clean comparison submits `no_correspondences: true`).",
                ],
              }
            : {}),
        }
      : { ...emptyCharterRegister({ rung: "shallow" }, generated_at, "omitted"), comparison_pending: false };
    return {
      updated: { ...bundle, charter_register: settled },
      artifacts_written: ["charter_register.json"],
      progress_summary: !register
        ? "Charter comparison omitted (no charter register to compare)."
        : register.comparison_pending !== true
          ? "Charter comparison omitted (register not awaiting a comparison)."
          : "Charter comparison: no submission supplied; settled the register UNCOMPARED (recorded as a validation issue).",
    };
  }

  const universe = new Set((bundle.repo_manifest?.files ?? []).map((file) => file.path));
  const assembled = assembleComparison(submission, {
    candidates: register.candidates,
    graphs: register.lanes,
    universe,
  });

  // Step 4, mechanical half: re-read every cited quote on every finding
  // candidate's accounts. Without a root the check cannot run and every quote is
  // "unknown" (undefined) — nothing is settled, everything goes to the lane, and
  // the abstention is visible as `fidelity_pending` with no tool verdicts.
  const quoteFound = buildQuoteOracle(assembled.differences.flatMap((d) => d.accounts.flatMap((a) => a.provenance)), options.root);
  const pre = precheckFidelity(assembled.differences, quoteFound);

  const updated: CharterRegister = {
    ...register,
    generated_at,
    correspondences: assembled.correspondences,
    differences: pre.differences,
    validation_issues: [...register.validation_issues, ...assembled.validation_issues],
    comparison_pending: false,
    fidelity_pending: pre.pendingLane.length > 0,
  };
  const settledByTool = pre.differences.filter((d) => d.fidelity?.decided_by === "tool").length;
  return {
    updated: { ...bundle, charter_register: updated },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter comparison complete: ${updated.correspondences.length} correspondence(s), ` +
      `${updated.differences.length} difference(s); ${pre.pendingLane.length} finding candidate(s) ` +
      `await the fidelity lane, ${settledByTool} settled unverifiable by the quote pre-check` +
      (assembled.validation_issues.length > 0
        ? `, ${assembled.validation_issues.length} record(s) refused:\n` +
          assembled.validation_issues.map((m) => `  - ${m}`).join("\n")
        : "."),
  };
}

/**
 * The quote oracle the pre-check consumes: `true` when the cited quote is found
 * at its ref, `false` when the check ran and did not find it, `undefined` when
 * no check could run (no root) or the provenance is not path-shaped.
 */
function buildQuoteOracle(
  provenance: readonly CharterProvenance[],
  root: string | undefined,
): (p: CharterProvenance) => boolean | undefined {
  if (!root) return () => undefined;
  const pathShaped = new Set(["doc", "code", "comment"]);
  const citations = provenance
    .filter((p) => pathShaped.has(p.kind) && p.quote !== undefined)
    .map((p, i) => ({ owner_id: `q${i}`, ref: p.ref, quote: p.quote! }));
  const result = checkCitations({ root, corpus: new Set<string>(), citations });
  const verdictByKey = new Map<string, boolean>();
  result.checks.forEach((check, i) => {
    const source = citations[i];
    if (!source) return;
    verdictByKey.set(`${source.ref}\n${source.quote}`, check.verdict === "ok");
  });
  return (p) => {
    if (!pathShaped.has(p.kind) || p.quote === undefined) return undefined;
    return verdictByKey.get(`${p.ref}\n${p.quote}`);
  };
}
