// sites-pinned: tests/audit/charter-fidelity-executor.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { CharterRegister } from "../types/charterRegister.js";
import {
  applyFidelity,
  differenceFindings,
  groundDesignFindings,
  type CharterDifference,
  type CharterFidelitySubmission,
} from "audit-tools/shared";
import { emptyCharterRegister } from "./charterExtractionExecutor.js";

/**
 * Charter-FIDELITY executor (step 4, judgment half). A SEPARATE lane — one that
 * authored neither the DAGs nor the comparison — judged, per finding candidate,
 * whether the two sources genuinely differ (`supported`), whether a reader
 * over-read a source (`interpretation`, naming the side), or whether the cited
 * slices do not settle it (`unverifiable`). This executor stamps those verdicts
 * (`applyFidelity`), settles any candidate the lane left unanswered as
 * `unverifiable` — never assumed supported — and surfaces every `supported`
 * candidate as a Finding lead, grounded against disk (step 5's finding half).
 *
 * - **omit** (no register, register not `fidelity_pending`, or no submission):
 *   settle `fidelity_pending: false`; a pending register settled with NO
 *   submission stamps every open candidate `unverifiable` with a recorded reason.
 * - **ingest**: stamp, settle the remainder, surface findings.
 */
export function runCharterFidelityExecutor(
  bundle: ArtifactBundle,
  submission: CharterFidelitySubmission | undefined,
): ExecutorRunResult {
  const generated_at = new Date().toISOString();
  const register = bundle.charter_register;

  if (!register) {
    return {
      updated: { ...bundle, charter_register: { ...emptyCharterRegister({ rung: "shallow" }, generated_at, "omitted"), fidelity_pending: false } },
      artifacts_written: ["charter_register.json"],
      progress_summary: "Charter fidelity omitted (no charter register).",
    };
  }
  if (register.fidelity_pending !== true) {
    return {
      updated: { ...bundle, charter_register: { ...register, generated_at, fidelity_pending: false } },
      artifacts_written: ["charter_register.json"],
      progress_summary: "Charter fidelity omitted (no finding candidate awaits a verdict).",
    };
  }

  const validation_issues: string[] = [...register.validation_issues];
  let differences: CharterDifference[] = register.differences;
  if (submission) {
    const applied = applyFidelity(differences, submission);
    differences = applied.differences;
    validation_issues.push(...applied.validation_issues);
  } else {
    validation_issues.push(
      "fidelity settled without a lane submission — every open finding candidate is stamped unverifiable, not supported.",
    );
  }
  differences = differences.map((d) =>
    d.finding_candidate && !d.fidelity
      ? {
          ...d,
          fidelity: {
            verdict: "unverifiable",
            rationale: submission
              ? "no verdict returned by the fidelity lane for this difference"
              : "no fidelity lane submission",
            decided_by: "tool",
          },
        }
      : d,
  );
  const findings = groundDesignFindings(
    differenceFindings(differences, register.correspondences, register.lanes),
    bundle.repo_manifest,
  );

  const updated: CharterRegister = {
    ...register,
    generated_at,
    differences,
    findings,
    validation_issues,
    fidelity_pending: false,
  };
  const supported = differences.filter((d) => d.fidelity?.verdict === "supported").length;
  const interpretation = differences.filter((d) => d.fidelity?.verdict === "interpretation").length;
  return {
    updated: { ...bundle, charter_register: updated },
    artifacts_written: ["charter_register.json"],
    progress_summary:
      `Charter fidelity complete: ${supported} supported → ${findings.length} finding(s), ` +
      `${interpretation} interpretation, ` +
      `${differences.filter((d) => d.fidelity?.verdict === "unverifiable").length} unverifiable.`,
  };
}
