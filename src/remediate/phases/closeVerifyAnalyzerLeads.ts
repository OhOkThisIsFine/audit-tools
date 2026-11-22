// sites-pinned: tests/remediate/close-verify-analyzer-leads.test.ts, tests/remediate/unit-source-outcomes.test.ts
import {
  EXTERNAL_ANALYZER_CANDIDATES,
  loadAnalyzerPolicy,
  runExternalAnalyzer,
  resolveBinaryCandidates,
  prepareAcquisition,
  registerExternalAnalyzers,
  type SpawnDeadline,
  analyzerProvenanceKey,
  type AcquisitionRunner,
  type ExternalAnalyzerCandidate,
  type ExternalAnalyzerToolStatus,
  type AnalyzerLeadProvenance,
  type AnalyzerPolicy,
  type MechanicalVerification,
} from "audit-tools/shared";
import type { MechanicalObligationVerification } from "../../shared/types/remediationOutcome.js";
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
  /** Required per-original-source verdicts, keyed by canonical finding ID. */
  obligations: Record<string, MechanicalObligationVerification[]>;
  /** Required analyzer proof was unavailable rather than clear. */
  unverified: string[];
  /** One status per re-run analyzer, for the report. */
  statuses: ExternalAnalyzerToolStatus[];
  /** finding_ids whose lead identity still fires (the re-block set). */
  persisting: string[];
}

/** Test-injectable seams; production callers pass none of these. */
export interface AnalyzerLeadVerifyOverrides {
  deadline?: SpawnDeadline;
  candidates?: ExternalAnalyzerCandidate[];
  run?: AcquisitionRunner;
  analyzerPolicy?: AnalyzerPolicy;
}

const NO_OP: AnalyzerLeadVerifyOutcome = {
  ran: false,
  verdicts: {},
  obligations: {},
  unverified: [],
  statuses: [],
  persisting: [],
};

export async function verifyAnalyzerLeads(params: {
  state: RemediationState;
  root: string;
  overrides?: AnalyzerLeadVerifyOverrides;
}): Promise<AnalyzerLeadVerifyOutcome> {
  const { state, root, overrides } = params;
  type Target = {
    finding_id: string;
    provenance: AnalyzerLeadProvenance;
    original?: { source_finding_id: string; obligation_id: string };
  };
  const targets: Target[] = [];
  for (const finding of state.plan?.findings ?? []) {
    if (state.finding_dispositions?.[finding.id]) continue;
    const units = (state.plan?.units ?? []).filter(unit => unit.source_finding_ids.includes(finding.id));
    const items = units.map(unit => state.items?.[unit.id]);
    if (items.length === 0 || !items.every(item => item && isVerifiedCompleteStatus(item.status)) ||
        (!finding.question_review_sources && !items.some(item => item?.status === "resolved"))) continue;
    if (finding.question_review_sources) {
      for (const source of finding.question_review_sources) {
        for (const obligation of source.verification) {
          if (obligation.kind !== "analyzer") continue;
          targets.push({
            finding_id: finding.id,
            provenance: obligation.provenance,
            original: { source_finding_id: source.finding_id, obligation_id: obligation.obligation_id },
          });
        }
      }
    } else if (finding.analyzer_provenance) {
      targets.push({ finding_id: finding.id, provenance: finding.analyzer_provenance });
    }
  }
  if (targets.length === 0) return NO_OP;

  const persistedAnalyzerPolicy = await loadAnalyzerPolicy(root);
  const analyzerPolicy: AnalyzerPolicy = {
    analyzers: {
      ...persistedAnalyzerPolicy.analyzers,
      ...overrides?.analyzerPolicy?.analyzers,
    },
    // `loadAnalyzerPolicy` drops legacy persisted consent, so only an override supplies it.
    analyzer_consent: {
      ...overrides?.analyzerPolicy?.analyzer_consent,
    },
  };

  const verdicts: Record<string, MechanicalVerification> = {};
  const statuses: ExternalAnalyzerToolStatus[] = [];
  const obligations: AnalyzerLeadVerifyOutcome["obligations"] = {};
  const rank = { verified_mechanically: 0, skipped: 1, lead_persists: 2 } as const;
  const record = (target: Target, verdict: MechanicalVerification) => {
    const key = target.finding_id;
    const prior = verdicts[key];
    if (!prior || rank[verdict.status] > rank[prior.status]) verdicts[key] = verdict;
    if (target.original) (obligations[key] ??= []).push({ ...target.original, ...verdict });
  };

  const byAnalyzer = new Map<string, typeof targets>();
  for (const target of targets) {
    const bucket = byAnalyzer.get(target.provenance.analyzer_id);
    if (bucket) bucket.push(target);
    else byAnalyzer.set(target.provenance.analyzer_id, [target]);
  }

  const candidates = registerExternalAnalyzers(overrides?.candidates ?? EXTERNAL_ANALYZER_CANDIDATES);
  const engineOptions = prepareAcquisition(
    candidates.filter(candidate => byAnalyzer.has(candidate.id)), root, {
      deadline: overrides?.deadline,
      analyzers: analyzerPolicy.analyzers,
      analyzerConsent: analyzerPolicy.analyzer_consent,
      ...(overrides?.run ? { run: overrides.run } : {}),
  }).options;

  const skipAll = (
    bucket: typeof targets,
    analyzer_id: string,
    reason: string,
  ): void => {
    for (const target of bucket) record(target, { status: "skipped", analyzer_id, reason });
  };

  for (const [analyzerId, bucket] of byAnalyzer) {
    const candidate = candidates.find((c) => c.id === analyzerId);
    if (!candidate) {
      skipAll(bucket, analyzerId, "no registered candidate for this analyzer id");
      continue;
    }
    // Binary-runner candidates resolve offline (PATH probe / verified warm cache)
    // ahead of the async engine, exactly as the audit draw does.
    const resolved = await resolveBinaryCandidates([candidate], root, engineOptions);
    // Resolution owns binary failure. Do not ask the engine to produce a second status.
    const unresolved = resolved.unresolvedStatuses[0];
    const outcome = unresolved ? undefined : await runExternalAnalyzer(candidate, root, {
      ...engineOptions,
      resolvedBinaries: resolved.resolvedBinaries,
    });
    const status = unresolved ?? outcome!.status;
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
      outcome!.results.results
        .map((result) => result.provenance)
        .filter((p): p is AnalyzerLeadProvenance => p !== undefined)
        .map(analyzerProvenanceKey),
    );
    for (const target of bucket) {
      record(target, firedKeys.has(analyzerProvenanceKey(target.provenance))
        ? { status: "lead_persists", analyzer_id: analyzerId }
        : { status: "verified_mechanically", analyzer_id: analyzerId });
    }
  }

  return {
    ran: true,
    verdicts,
    obligations,
    unverified: Object.entries(obligations)
      .filter(([, rows]) => rows.some(row => row.status === "skipped"))
      .map(([finding_id]) => finding_id),
    statuses,
    persisting: Object.entries(verdicts)
      .filter(([, v]) => v.status === "lead_persists")
      .map(([finding_id]) => finding_id),
  };
}
