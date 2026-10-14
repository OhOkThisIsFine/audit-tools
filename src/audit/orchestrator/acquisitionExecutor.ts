// sites-pinned: tests/audit/acquisition-executor.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type {
  AnalyzerSetting,
  AnalyzerConsentTokenGrant,
  AnalyzerConsentDecisions,
} from "audit-tools/shared";
import {
  runAcquisitionEngine,
  prepareAcquisition,
  defaultBinaryFetcher,
  resolveBinaryCandidates,
} from "audit-tools/shared";
import { EXTERNAL_ANALYZER_CANDIDATES } from "audit-tools/shared";
import type {
  BinaryFetcher,
  BinaryResolveOptions,
  SpawnDeadline,
  BinaryCommandRunner,
} from "audit-tools/shared";
import {
  upsertExternalToolResults,
  type ExternalAnalyzerAcquisitionMarker,
} from "audit-tools/shared";

/**
 * Advance-level options for the external-analyzer acquisition executor.
 *
 * The HERMETICITY GATE is `enabled`: the executor is a NO-OP that writes an empty
 * marker UNLESS `enabled === true`. The unit/integration suite never sets it, so
 * no subprocess or network ever runs in tests; only the real CLI next-step path
 * enables acquisition (and supplies the global-`fetch` adapter). `fetch`/`run` are
 * injectable so an enabled-path test can drive the engine without touching the
 * network or spawning a real process.
 */
export interface ExternalAcquisitionAdvanceOptions {
  deadline?: SpawnDeadline;
  resolveExecutable?: BinaryResolveOptions["resolveExecutable"];
  /** Hermeticity gate: acquisition runs ONLY when true. Default off (empty marker). */
  enabled?: boolean;
  /** Injected network fetch for binary acquisition; defaults to a global-fetch adapter. */
  fetch?: BinaryFetcher;
  /** Injected command runner (probe / spawn); defaults to the shared runTrackedAsync. */
  run?: BinaryCommandRunner;
  /**
   * Per-run, tool-SCOPED consent grant gating non-default candidates (semgrep /
   * eslint / …). Typed as {@link AnalyzerConsentTokenGrant} — never a bare string —
   * so a grant admits ONLY the candidates it names and an operator's recorded
   * decline is overridden by nothing.
   */
  consentToken?: AnalyzerConsentTokenGrant;
  /** Per-analyzer resolution policy (auto|ephemeral|permanent|skip|repo). */
  analyzers?: Record<string, AnalyzerSetting>;
  /**
   * Current-run declines veto admission, including for default tools.
   * Grants use the scoped token above; no durable policy grants admission.
   */
  analyzerConsent?: AnalyzerConsentDecisions;
  /** Override the binary cache dir / platform / arch (tests). */
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Slice D — production wiring of the external-analyzer acquisition engine.
 *
 * Resolves (PATH → cache → checksum-verified download) every `binary` candidate,
 * runs the whole registered candidate set through the engine, and upserts each
 * tool's normalized findings into `external_analyzer_results`. Writes the
 * provenance/staleness marker `external_analyzer_acquisition.json` either way.
 *
 * Runtime failures degrade to status records; registry/status invariant violations
 * throw rather than silently concealing missing or duplicate producers. The
 * disabled path is a pure marker write. `external_analyzer_results.json` is listed
 * in `artifacts_written` only when a tool actually contributed findings, so an
 * unchanged results array never churns its downstreams.
 */
export async function runExternalAnalyzerAcquisitionExecutor(
  bundle: ArtifactBundle,
  root: string | undefined,
  options: ExternalAcquisitionAdvanceOptions = {},
): Promise<ExecutorRunResult> {
  const generated_at = new Date().toISOString();

  // Hermeticity gate — disabled (or no root) ⇒ empty marker, nothing spawned.
  if (!options.enabled || !root) {
    const marker: ExternalAnalyzerAcquisitionMarker = {
      generated_at,
      enabled: false,
      tool_statuses: [],
    };
    return {
      updated: { ...bundle, external_analyzer_acquisition: marker },
      artifacts_written: ["external_analyzer_acquisition.json"],
      progress_summary: !root
        ? "External analyzer acquisition skipped (no repo root)."
        : "External analyzer acquisition disabled (hermetic no-op marker).",
    };
  }

  const fetcher = options.fetch ?? defaultBinaryFetcher;
  const prepared = prepareAcquisition(EXTERNAL_ANALYZER_CANDIDATES, root, options);
  const candidates = prepared.candidates;
  const engineOptions = prepared.options;

  const { resolvedBinaries, unresolvedStatuses } = await resolveBinaryCandidates(
    candidates,
    root,
    {
      ...engineOptions,
      resolveExecutable: options.resolveExecutable,
      fetch: fetcher,
      run: options.run,
      consentToken: options.consentToken,
      analyzers: options.analyzers,
      analyzerConsent: options.analyzerConsent,
      cacheDir: options.cacheDir,
      platform: options.platform,
      arch: options.arch,
    },
  );

  const runnable = candidates.filter(candidate => candidate.runner !== "binary" ||
    Object.hasOwn(resolvedBinaries, candidate.id));
  const { results, statuses } = await runAcquisitionEngine(runnable, root, {
    ...engineOptions, resolvedBinaries,
  });
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const statusById = new Map<string, (typeof statuses)[number]>();
  for (const status of [...unresolvedStatuses, ...statuses]) {
    if (!candidateIds.has(status.tool)) throw new Error(`unregistered analyzer status producer: ${status.tool}`);
    if (statusById.has(status.tool)) throw new Error(`duplicate analyzer status producer: ${status.tool}`);
    statusById.set(status.tool, status);
  }
  const orderedStatuses = candidates.map(candidate => {
    const status = statusById.get(candidate.id);
    if (!status) throw new Error(`missing analyzer status producer: ${candidate.id}`);
    return status;
  });

  let mergedResults = bundle.external_analyzer_results;
  for (const toolResults of results) {
    mergedResults = upsertExternalToolResults(mergedResults, toolResults);
  }

  const marker: ExternalAnalyzerAcquisitionMarker = {
    generated_at,
    enabled: true,
    // resolveBinaryCandidates records a status for every binary that didn't
    // resolve; the engine records one per candidate it ran. Union = exactly one
    // status per candidate (report-skipped-never-silently).
    tool_statuses: orderedStatuses,
  };

  const artifactsWritten = ["external_analyzer_acquisition.json"];
  const updated: ArtifactBundle = {
    ...bundle,
    external_analyzer_acquisition: marker,
  };
  if (results.length > 0) {
    updated.external_analyzer_results = mergedResults;
    artifactsWritten.push("external_analyzer_results.json");
  }

  const findingCount = results.reduce((sum, r) => sum + r.results.length, 0);
  const ran = statuses.filter((s) => s.resolved).map((s) => s.tool);
  return {
    updated,
    artifacts_written: artifactsWritten,
    progress_summary:
      `External analyzer acquisition ran ${ran.length} tool(s)` +
      (ran.length > 0 ? ` (${ran.join(", ")})` : "") +
      `, contributing ${findingCount} finding(s).`,
  };
}
