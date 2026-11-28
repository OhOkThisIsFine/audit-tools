import { isDegradedExternalAnalyzerStatus } from "../../shared/analyzers/types.js";
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
  existingRuntimeRequired,
  type ExistingAnalyzerRuntime,
  prepareAcquisition,
  compareCodeUnits,
  stableStringify,
  defaultBinaryFetcher,
  resolveBinaryCandidates,
  resolveAnalyzerRelease,
  type ExternalAnalyzerToolStatus,
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
  existingRuntimes?: Readonly<Record<string, ExistingAnalyzerRuntime>>;
  resolveExecutable?: BinaryResolveOptions["resolveExecutable"];
  /** Hermeticity gate: acquisition runs ONLY when true. Default off (empty marker). */
  enabled?: boolean;
  /** Ordinary CLI asks the host to select applicable checks before acquisition. */
  hostSelection?: boolean;
  /** Resolve the current upstream release for each admitted, managed analyzer. */
  latestReleases?: boolean;
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

/** Bounded selection context from frozen intake, not commands to execute. */
export function analyzerSelectionContext(bundle: ArtifactBundle) {
  const dispositions = new Map(bundle.file_disposition?.files.map(file => [file.path, file.status]));
  const languages = new Map<string, number>();
  const configuration: string[] = [];
  for (const file of bundle.repo_manifest?.files ?? []) {
    if (file.excluded) continue;
    const status = dispositions.get(file.path);
    if (status !== "included" && status !== "doc_only") continue;
    if (status === "included" && file.language) languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
    const name = file.path.split("/").pop() ?? "";
    if (/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.(?:mod|work)|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json|Makefile|CMakeLists\.txt|tsconfig(?:\.[^/]+)?\.json|eslint\.config\.[^/]+|\.semgrep\.ya?ml|\.golangci\.ya?ml|\.gitlab-ci\.yml)$/u.test(name)
      || /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.path)) configuration.push(file.path);
  }
  return {
    languages: [...languages].sort(([a], [b]) => compareCodeUnits(a, b)),
    configuration: configuration.sort(compareCodeUnits),
  };
}

export function incompleteAnalyzerStatuses(bundle: ArtifactBundle): ExternalAnalyzerToolStatus[] {
  return (bundle.external_analyzer_acquisition?.tool_statuses ?? []).filter(status =>
    status.status !== "skipped" && (
      isDegradedExternalAnalyzerStatus(status) || Boolean(status.source_read_failures)
    ),
  );
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
  retryTools?: readonly string[],
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
  // Retries use the same frozen root and original admission rules. They can
  // select known tools, never add permissions or silently widen the run.
  const previous = bundle.external_analyzer_acquisition?.tool_statuses ?? [];
  const retrySet = retryTools && new Set(retryTools);
  const candidates = prepared.candidates.filter(candidate => !retrySet || retrySet.has(candidate.id));
  if (retrySet) {
    const attempted = new Set(previous.filter(row => row.status !== "skipped").map(row => row.tool));
    if (candidates.length !== retrySet.size || candidates.some(candidate => !attempted.has(candidate.id))) {
      throw new Error("Retry must name only previously attempted analyzers.");
    }
  }
  const engineOptions = prepared.options;
  const versions = new Map<string, string>();
  const versionFailures: ExternalAnalyzerToolStatus[] = [];
  const selected = await Promise.all(candidates.map(async candidate => {
    if (!options.latestReleases || engineOptions.admissions?.get(candidate.id) !== null ||
        options.existingRuntimes?.[candidate.id] || existingRuntimeRequired(candidate, engineOptions)) return candidate;
    const recorded = bundle.external_analyzer_acquisition?.tool_statuses.find(status => status.tool === candidate.id)?.version;
    try {
      const release = await resolveAnalyzerRelease(candidate, fetcher,
        (engineOptions.deadline?.at ?? Date.now()) - Date.now(), recorded);
      if (!release) return candidate;
      versions.set(candidate.id, release.version);
      return release.candidate;
    } catch {
      versionFailures.push({
        tool: candidate.id, resolved: false, status: "not_resolved", stage: "resolve",
        error: recorded ? "Recorded analyzer version could not be reused" : "Could not resolve the latest stable upstream release (metadata unavailable or incompatible)",
      });
      return null;
    }
  }));
  const availableCandidates = selected.filter(candidate => candidate !== null);

  const { resolvedBinaries, unresolvedStatuses } = await resolveBinaryCandidates(
    availableCandidates,
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

  const unresolvedIds = new Set(unresolvedStatuses.map(status => status.tool));
  const runnable = availableCandidates.filter(candidate => !unresolvedIds.has(candidate.id));
  const { results, statuses } = await runAcquisitionEngine(runnable, root, {
    ...engineOptions, resolvedBinaries,
  });
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const statusById = new Map<string, (typeof statuses)[number]>();
  for (const status of [...versionFailures, ...unresolvedStatuses, ...statuses]) {
    if (!candidateIds.has(status.tool)) throw new Error(`unregistered analyzer status producer: ${status.tool}`);
    if (statusById.has(status.tool)) throw new Error(`duplicate analyzer status producer: ${status.tool}`);
    statusById.set(status.tool, status);
  }
  const orderedStatuses = candidates.map(candidate => {
    const status = statusById.get(candidate.id);
    if (!status) throw new Error(`missing analyzer status producer: ${candidate.id}`);
    const version = versions.get(candidate.id);
    if (!options.latestReleases) return status;
    const stage = status.stage ?? (status.status === "parse_error" ? "parse"
      : status.resolved ? "scan" : "resolve");
    return { ...status, ...(version ? { version } : {}), ...(status.status !== "skipped" ? { stage } : {}) };
  });

  let mergedResults = bundle.external_analyzer_results;
  for (const toolResults of results) {
    const prior = retrySet ? mergedResults?.find(entry => entry.tool === toolResults.tool) : undefined;
    // A calibration rerun can change the rules as well as the files scanned.
    // Current adapters can report some paths, but cannot prove that the prior
    // finding's rule or graph query ran. Absence in a rerun is not retraction.
    // Retain prior leads; only an equivalent observation deduplicates.
    const retained = prior?.results ?? [];
    const edges = prior?.graph_edges ?? [];
    const ownership = prior?.ownership_roots ?? [];
    if (retained.length || edges.length || ownership.length) {
      const unique = <T>(rows: T[]) => [...new Map(rows.map(row => [stableStringify(row), row])).values()];
      const items = unique([...retained, ...toolResults.results]);
      const graph = unique([...edges, ...(toolResults.graph_edges ?? [])]);
      const roots = unique([...ownership, ...(toolResults.ownership_roots ?? [])]);
      mergedResults = upsertExternalToolResults(mergedResults, {
        ...toolResults, results: items, ...(graph.length && { graph_edges: graph }),
        ...(roots.length && { ownership_roots: roots }),
      });
    } else {
      mergedResults = upsertExternalToolResults(mergedResults, toolResults);
    }
  }

  let toolStatuses = orderedStatuses;
  if (retrySet) {
    // The producer checks above guarantee one status per tool. A skipped retry
    // does not supersede prior evidence; keep every prior row in its old slot.
    const updatesById = new Map<string, ExternalAnalyzerToolStatus>();
    for (const status of orderedStatuses) {
      if (status.status !== "skipped") updatesById.set(status.tool, status);
    }
    toolStatuses = previous.map(status => updatesById.get(status.tool) ?? status);
  }

  const marker: ExternalAnalyzerAcquisitionMarker = {
    generated_at,
    enabled: true,
    ...(retrySet && bundle.external_analyzer_acquisition?.calibration_retries
      ? { calibration_retries: bundle.external_analyzer_acquisition.calibration_retries } : {}),
    // resolveBinaryCandidates records a status for every binary that didn't
    // resolve; the engine records one per candidate it ran. Union = exactly one
    // status per candidate (report-skipped-never-silently).
    tool_statuses: toolStatuses,
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
  const failures = incompleteAnalyzerStatuses(updated);
  const failureSummary = failures.length === 0 ? "" :
    "\nAnalyzer coverage incomplete: " + failures.map(status =>
      `${status.tool} (${status.version ?? "version unavailable"}, ${status.stage ?? status.status}): ${status.status}`
    ).join("; ") + ". Dispatcher: diagnose each failure and rerun only that analyzer on the same frozen snapshot, within existing consent. Record any version override and use import-external-analyzer for recovered normalized results. If recovery fails, report incomplete coverage; do not restart the audit or treat this as clean.";
  return {
    updated,
    artifacts_written: artifactsWritten,
    progress_summary:
      `External analyzer acquisition ran ${ran.length} tool(s)` +
      (ran.length > 0 ? ` (${ran.join(", ")})` : "") +
      `, contributing ${findingCount} finding(s).` + failureSummary,
  };
}
