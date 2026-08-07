import {
  EXTERNAL_ANALYZER_CANDIDATES,
  runExternalAnalyzer,
  resolveBinaryCandidates,
  analyzerProvenanceKey,
  type AcquisitionRunner,
  type ExternalAnalyzerCandidate,
  type ExternalAnalyzerToolStatus,
  type AnalyzerLeadProvenance,
  type SessionConfig,
  type MechanicalVerification,
} from "audit-tools/shared";
import { loadRemediateSessionConfig } from "../steps/sessionConfigLoad.js";
import type { RemediationState } from "../state/store.js";

/**
 * Item C (`spec/mechanical-analyzer-layer-design.md`) — the close-gate verify
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
 * Admission is unchanged (`admitSpawn` over the same persisted session config
 * the audit run wrote): an analyzer that is not admitted or does not resolve
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
  sessionConfig?: SessionConfig;
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
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );

  // Only `resolved` items claim an applied fix worth mechanically verifying.
  // `verified_no_change` deliberately left the lead in place — re-running the
  // analyzer would trivially re-find it, which is not evidence of anything.
  const targets: Array<{ finding_id: string; provenance: AnalyzerLeadProvenance }> = [];
  for (const item of Object.values(state.items ?? {})) {
    if (item.status !== "resolved") continue;
    const provenance = findingsById.get(item.finding_id)?.analyzer_provenance;
    if (provenance) targets.push({ finding_id: item.finding_id, provenance });
  }
  if (targets.length === 0) return NO_OP;

  const sessionConfig =
    overrides?.sessionConfig ??
    (await loadRemediateSessionConfig({ root, artifactsFirst: true }));

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
    analyzers: sessionConfig?.analyzers,
    analyzerConsent: sessionConfig?.analyzer_consent,
    consentToken: sessionConfig?.external_acquisition?.consent_token,
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
    if (sessionConfig?.external_acquisition?.enabled === false) {
      skipAll(bucket, analyzerId, "external acquisition disabled in session config");
      continue;
    }

    // Binary-runner candidates resolve (PATH probe / checksum-gated download)
    // ahead of the synchronous engine, exactly as the audit draw does.
    const resolved = await resolveBinaryCandidates([candidate], root, engineOptions);
    const outcome = runExternalAnalyzer(candidate, root, {
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
