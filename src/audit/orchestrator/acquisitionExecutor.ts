import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { AnalyzerSetting } from "audit-tools/shared";
import {
  runAcquisitionEngine,
  resolveBinaryCandidates,
} from "../extractors/analyzers/acquisitionEngine.js";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../extractors/analyzers/candidates.js";
import type {
  BinaryFetcher,
  BinaryCommandRunner,
} from "../extractors/analyzers/binaryAcquisition.js";
import {
  upsertExternalToolResults,
  type ExternalAnalyzerAcquisitionMarker,
} from "../types/externalAnalyzer.js";

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
  /** Hermeticity gate: acquisition runs ONLY when true. Default off (empty marker). */
  enabled?: boolean;
  /** Injected network fetch for binary acquisition; defaults to a global-fetch adapter. */
  fetch?: BinaryFetcher;
  /** Injected command runner (probe / spawn); defaults to the shared runTracked. */
  run?: BinaryCommandRunner;
  /** Per-run consent token gating non-default candidates (semgrep / eslint). */
  consentToken?: string;
  /** Per-analyzer resolution policy (auto|ephemeral|permanent|skip|repo). */
  analyzers?: Record<string, AnalyzerSetting>;
  /** Override the binary cache dir / platform / arch (tests). */
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Global-`fetch`-backed binary fetcher: returns the URL's bytes or null on failure. */
const defaultBinaryFetcher: BinaryFetcher = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
};

/**
 * Slice D — production wiring of the external-analyzer acquisition engine.
 *
 * Resolves (PATH → cache → checksum-verified download) every `binary` candidate,
 * runs the whole registered candidate set through the engine, and upserts each
 * tool's normalized findings into `external_analyzer_results`. Writes the
 * provenance/staleness marker `external_analyzer_acquisition.json` either way.
 *
 * Never throws: the engine degrades every candidate to a status record, and the
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
  const candidates = EXTERNAL_ANALYZER_CANDIDATES;

  const { resolvedBinaries, unresolvedStatuses } = await resolveBinaryCandidates(
    candidates,
    root,
    {
      fetch: fetcher,
      run: options.run,
      consentToken: options.consentToken,
      analyzers: options.analyzers,
      cacheDir: options.cacheDir,
      platform: options.platform,
      arch: options.arch,
    },
  );

  const { results, statuses } = runAcquisitionEngine(candidates, root, {
    run: options.run,
    resolvedBinaries,
    consentToken: options.consentToken,
    analyzers: options.analyzers,
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
    tool_statuses: [...unresolvedStatuses, ...statuses],
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
