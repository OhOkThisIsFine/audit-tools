// sites-pinned: tests/remediate/close-verify-analyzer-leads.test.ts, tests/remediate/unit-source-outcomes.test.ts
import {
  EXTERNAL_ANALYZER_CANDIDATES,
  loadAnalyzerPolicy,
  runExternalAnalyzer,
  resolveBinaryCandidates,
  analyzerProvenanceKey,
  type AcquisitionRunner,
  type ExternalAnalyzerCandidate,
  type ExternalAnalyzerToolStatus,
  type AnalyzerLeadProvenance,
  type AnalyzerPolicy,
  type MechanicalVerification,
} from "audit-tools/shared";
import { isVerifiedCompleteStatus } from "../state/itemStatus.js";
import type { RemediationState } from "../state/store.js";

/**
 * CLAUDE.md's own-vs-acquire analyzer design — the close-gate verify
 * leg for analyzer-born findings. Findings born from analyzer leads are closed
 * by the same analyzer re-run: the one place mechanical output is authoritative
 * rather than a lead, because "this exact provenance identity no longer fires"
 * is a fact, not a judgment.
 *
 * Instance-level semantics: pass = the finding's {analyzer_id, rule, path,
 * snippet_hash} identity is absent from the re-run's provenance set. Residual
 * findings elsewhere in the file do not fail it. Unlike the suite legs (which
 * re-block ALL resolved items on red), a persisting lead re-blocks only ITS
 * item — attribution is exact.
 *
 * Admission reads the provider-neutral analyzer policy artifact shared with the
 * audit draw: an analyzer that is not admitted or does not resolve
 * yields per-item `skipped` verdicts with the tool status as reason — recorded,
 * never silent, and never a false `verified_mechanically`.
 */

export interface AnalyzerLeadVerifyOutcome {
  /** False when no resolved item carries analyzer provenance (leg is a no-op). */
  ran: boolean;
  /** Per finding_id mechanical verification verdicts. */
  verdicts: Record<string, MechanicalVerification>;
  /** One status per re-run analyzer, for the report. */
  statuses: ExternalAnalyzerToolStatus[];
  /** finding_ids whose lead identity still fires (the re-block set). */
  persisting: string[];
}

/** Test-injectable seams; production callers pass none of these. */
export interface AnalyzerLeadVerifyOverrides {
  candidates?: ExternalAnalyzerCandidate[];
  run?: AcquisitionRunner;
  analyzerPolicy?: AnalyzerPolicy;
}

const NO_OP: AnalyzerLeadVerifyOutcome = {
  ran: false,
  verdicts: {},
  statuses: [],
  persisting: [],
};

export async function verifyAnalyzerLeads(params: {
  state: RemediationState;
  root: string;
  overrides?: AnalyzerLeadVerifyOverrides;
}): Promise<AnalyzerLeadVerifyOutcome> {
  const { state, root, overrides } = params;
  const targets: Array<{ finding_id: string; provenance: AnalyzerLeadProvenance }> = [];
  for (const finding of state.plan?.findings ?? []) {
    if (state.finding_dispositions?.[finding.id]) continue;
    const units = (state.plan?.units ?? []).filter(unit => unit.source_finding_ids.includes(finding.id));
    const items = units.map(unit => state.items?.[unit.id]);
    if (items.length === 0 || !items.every(item => item && isVerifiedCompleteStatus(item.status)) ||
        !items.some(item => item?.status === "resolved")) continue;
    if (finding.analyzer_provenance) targets.push({finding_id: finding.id, provenance: finding.analyzer_provenance});
  }
  if (targets.length === 0) return NO_OP;

  const persistedAnalyzerPolicy = await loadAnalyzerPolicy(root);
  const analyzerPolicy: AnalyzerPolicy = {
    analyzers: {
      ...persistedAnalyzerPolicy.analyzers,
      ...overrides?.analyzerPolicy?.analyzers,
    },
    analyzer_consent: {
      ...persistedAnalyzerPolicy.analyzer_consent,
      ...overrides?.analyzerPolicy?.analyzer_consent,
    },
  };

  const verdicts: Record<string, MechanicalVerification> = {};
  const statuses: ExternalAnalyzerToolStatus[] = [];

  const byAnalyzer = new Map<string, typeof targets>();
  for (const target of targets) {
    const bucket = byAnalyzer.get(target.provenance.analyzer_id);
    if (bucket) bucket.push(target);
    else byAnalyzer.set(target.provenance.analyzer_id, [target]);
  }

  const candidates = overrides?.candidates ?? EXTERNAL_ANALYZER_CANDIDATES;
  const engineOptions = {
    analyzers: analyzerPolicy.analyzers,
    analyzerConsent: analyzerPolicy.analyzer_consent,
    ...(overrides?.run ? { run: overrides.run } : {}),
  };

  const skipAll = (
    bucket: typeof targets,
    analyzer_id: string,
    reason: string,
  ): void => {
    for (const { finding_id } of bucket) {
      verdicts[finding_id] = { status: "skipped", analyzer_id, reason };
    }
  };

  for (const [analyzerId, bucket] of byAnalyzer) {
    const candidate = candidates.find((c) => c.id === analyzerId);
    if (!candidate) {
      skipAll(bucket, analyzerId, "no registered candidate for this analyzer id");
      continue;
    }
    // Binary-runner candidates resolve (PATH probe / checksum-gated download)
    // ahead of the async engine, exactly as the audit draw does.
    const resolved = await resolveBinaryCandidates([candidate], root, engineOptions);
    const outcome = await runExternalAnalyzer(candidate, root, {
      ...engineOptions,
      resolvedBinaries: resolved.resolvedBinaries,
    });
    const status =
      candidate.runner === "binary" && resolved.unresolvedStatuses.length > 0
        ? resolved.unresolvedStatuses[0]
        : outcome.status;
    statuses.push(status);

    if (status.status !== "findings" && status.status !== "success") {
      skipAll(
        bucket,
        analyzerId,
        `analyzer did not re-run: ${status.status}${status.error ? ` (${status.error})` : ""}`,
      );
      continue;
    }

    const firedKeys = new Set(
      outcome.results.results
        .map((result) => result.provenance)
        .filter((p): p is AnalyzerLeadProvenance => p !== undefined)
        .map(analyzerProvenanceKey),
    );
    for (const { finding_id, provenance } of bucket) {
      verdicts[finding_id] = firedKeys.has(analyzerProvenanceKey(provenance))
        ? { status: "lead_persists", analyzer_id: analyzerId }
        : { status: "verified_mechanically", analyzer_id: analyzerId };
    }
  }

  return {
    ran: true,
    verdicts,
    statuses,
    persisting: Object.entries(verdicts)
      .filter(([, v]) => v.status === "lead_persists")
      .map(([finding_id]) => finding_id),
  };
}
