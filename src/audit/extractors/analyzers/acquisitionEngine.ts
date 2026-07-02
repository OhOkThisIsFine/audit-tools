import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  runTracked,
  type AnalyzerSetting,
  type RunTrackedResult,
} from "audit-tools/shared";
import {
  normalizeGenericExternalResults,
  normalizeGenericExternalEdges,
} from "../../adapters/normalizeExternal.js";
import type {
  ExternalAnalyzerResults,
  ExternalAnalyzerToolStatus,
} from "../../types/externalAnalyzer.js";
import {
  resolveBinary,
  type BinarySpec,
  type BinaryResolveOptions,
} from "./binaryAcquisition.js";

/**
 * F5 — external analyzer acquisition engine.
 *
 * On-demand acquisition + ephemeral execution of mature, ecosystem-native
 * analyzers (eslint, ruff, cargo-clippy, …). Distinct from the in-tree
 * `LanguageAnalyzer` registry (which enriches the regex floor from a resolved
 * npm package directory): F5 *runs an external tool as a subprocess* and
 * normalizes its native output through the EXISTING adapter seam
 * (`normalizeExternal.ts`) into {@link ExternalAnalyzerResults}, which then
 * re-enters the graph/risk artifacts through the shared
 * CCU-analyzer-merge-helper-seam pair.
 *
 * Design invariants (all enforced here, never by host discretion):
 *  - **No baked-in language→tool / OS→runner table.** Ecosystem is detected
 *    deterministically from repo marker files; the runner (npx/pipx/cargo/bundle)
 *    is capability-probed at RUNTIME (`--version`) before any tool spawn.
 *  - **Single subprocess-SPAWN admission chokepoint** (`admitSpawn`): EVERY
 *    non-DEFAULT candidate is gated on the per-run consent token regardless of
 *    its `AnalyzerSetting` (auto|ephemeral|permanent) — even a `permanent`,
 *    pre-installed tool cannot spawn without consent (CE-005). The small
 *    value-curated DEFAULT set runs without prompting.
 *  - **Own-vs-acquire boundary.** git-history is OWNED by F6 and is rejected at
 *    registration — never acquired here. Secret scanning is ACQUIRED (gitleaks).
 *  - **Run-safety gate written once** (`runSafetyGate`): capability-probe, pin
 *    version, read-only/sandboxed argv, degrade-to-empty.
 *  - **Degrade-to-empty + report-skipped-never-silently.** Every candidate
 *    yields exactly one {@link ExternalAnalyzerToolStatus}; a failure never
 *    throws and never silently drops the candidate.
 */

/**
 * Tool ids OWNED by F6 and never acquired. Only git-history mining is OWNED — it
 * is a truly-agnostic signal with no ecosystem tool. Secret scanning is ACQUIRED
 * (gitleaks), not owned, so it is deliberately NOT listed here.
 */
export const OWNED_TOOL_IDS = new Set<string>([
  "git-history",
  "git-history-mining",
]);

/**
 * Ecosystem runners F5 knows how to drive. `npx`/`pipx`/`cargo`/`bundle` acquire
 * + run a pinned package ephemerally; `binary` runs a standalone release binary
 * resolved (and downloaded-if-absent) by the binary-acquisition seam.
 */
export type EcosystemRunner = "npx" | "pipx" | "cargo" | "bundle" | "binary";

/**
 * One acquirable external analyzer. `defaultRun: true` marks a member of the
 * small value-curated set that may run without a consent token; everything else
 * is gated on the per-run consent token at the spawn chokepoint.
 */
export interface ExternalAnalyzerCandidate {
  /** Stable id; also the `analyzers.<id>` session-config key. */
  id: string;
  /** Runner that acquires + executes the tool ephemerally. */
  runner: EcosystemRunner;
  /** Pinned tool spec, e.g. "eslint@9" / "ruff==0.5.0" (pinned for reproducibility). */
  spec: string;
  /**
   * Build the read-only argv for the tool given the resolved runner argv prefix
   * and repo root. MUST NOT request fixes/writes — F5 is observe-only.
   */
  buildArgv(runnerPrefix: string[], root: string): string[];
  /**
   * Parse the tool's stdout into the generic item shape consumed by
   * `normalizeGenericExternalResults`. Degrades to `[]` on any parse failure.
   */
  parse(stdout: string): Array<{
    id?: string;
    category?: string;
    severity?: string;
    path?: string;
    line_start?: number;
    line_end?: number;
    summary?: string;
    rule?: string;
    raw?: unknown;
    from?: unknown;
    to?: unknown;
  }>;
  /**
   * For tools that ONLY report to a file (e.g. gitleaks) rather than stdout: the
   * report path the tool was told to write (must match `buildArgv`). When set, the
   * engine reads this file (degrade-to-"" if absent) and passes its contents to
   * `parse` instead of stdout, then best-effort removes it. Omit for stdout tools.
   */
  reportFile?(root: string): string;
  /** Whether this ecosystem is present (marker file detection). */
  detect(root: string): boolean;
  /** Member of the value-curated DEFAULT set (runs without prompting). */
  defaultRun: boolean;
  /**
   * Acquisition spec for a `runner: "binary"` candidate — how to probe PATH and,
   * if absent, download + SHA256-verify the pinned release binary. Resolved ahead
   * of the (synchronous) engine by `resolveBinaryCandidates`; ignored for the
   * package-manager runners.
   */
  binary?: BinarySpec;
}

/** Marker-file ecosystem detection — deterministic, no language→tool table. */
function hasAnyMarker(root: string, markers: string[]): boolean {
  return markers.some((m) => existsSync(join(root, m)));
}

export function detectNodeEcosystem(root: string): boolean {
  return hasAnyMarker(root, ["package.json"]);
}

export function detectPythonEcosystem(root: string): boolean {
  return hasAnyMarker(root, ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]);
}

export function detectRustEcosystem(root: string): boolean {
  return hasAnyMarker(root, ["Cargo.toml"]);
}

export function detectRubyEcosystem(root: string): boolean {
  return hasAnyMarker(root, ["Gemfile", "Gemfile.lock", ".rubocop.yml"]);
}

export function detectDockerEcosystem(root: string): boolean {
  return hasAnyMarker(root, ["Dockerfile"]);
}

/**
 * GitHub Actions workflows live under `.github/workflows/`. actionlint only makes
 * sense when that directory exists, so its presence is the ecosystem marker.
 */
export function detectGithubActionsEcosystem(root: string): boolean {
  return hasAnyMarker(root, [join(".github", "workflows")]);
}

/**
 * Map a runner to the capability-probe argv (`--version`) and the argv prefix
 * used to run a pinned tool ephemerally. No OS→runner assumption is baked in:
 * the probe is what proves the runner exists on THIS machine.
 */
function runnerProbeArgv(runner: EcosystemRunner): string[] {
  switch (runner) {
    case "npx": return ["npx", "--version"];
    case "pipx": return ["pipx", "--version"];
    case "cargo": return ["cargo", "--version"];
    case "bundle": return ["bundle", "--version"];
    // `binary` is resolved (+ checksum-gated) ahead of the engine — no runner probe.
    case "binary": return [];
  }
}

function runnerPrefix(runner: EcosystemRunner, spec: string): string[] {
  switch (runner) {
    // `-y` so the ephemeral fetch never blocks on a prompt; pinned spec.
    case "npx": return ["npx", "-y", spec];
    case "pipx": return ["pipx", "run", "--spec", spec];
    case "cargo": return ["cargo", spec];
    case "bundle": return ["bundle", "exec", spec];
    // For `binary` the resolved executable path is supplied via
    // options.resolvedBinaries and used directly — this is never called.
    case "binary": return [];
  }
}

export interface AcquisitionRunner {
  (argv: string[], cwd: string): RunTrackedResult;
}

export interface AcquisitionEngineOptions {
  /**
   * Per-run consent token. REQUIRED to spawn any non-DEFAULT candidate (and any
   * candidate whose setting is ephemeral/permanent). Absent ⇒ only the DEFAULT
   * set runs; everything else is reported `skipped` with a consent note.
   */
  consentToken?: string;
  /** Per-analyzer settings (auto|ephemeral|permanent|skip|repo). */
  analyzers?: Record<string, AnalyzerSetting>;
  /** Injectable command runner; defaults to the shared runTracked. */
  run?: AcquisitionRunner;
  /** Injectable logger; defaults to a no-op (degrade quietly to status records). */
  log?: (...args: unknown[]) => void;
  /**
   * Resolved executable path per `runner: "binary"` candidate id, produced by
   * `resolveBinaryCandidates`. A binary candidate with no entry here is reported
   * `not_resolved` (acquisition failed / was skipped) and never spawned.
   */
  resolvedBinaries?: Record<string, string>;
}

/**
 * Single subprocess-SPAWN admission chokepoint. Returns the reason a spawn is
 * NOT admitted, or `undefined` when admitted. The DEFAULT set is admitted
 * without a token; EVERY other candidate — including `permanent`/`ephemeral`
 * pre-installed tools — requires the per-run consent token (CE-005).
 */
export function admitSpawn(
  candidate: ExternalAnalyzerCandidate,
  setting: AnalyzerSetting,
  consentToken: string | undefined,
): string | undefined {
  if (setting === "skip") return "setting=skip";
  if (candidate.defaultRun) return undefined;
  if (consentToken && consentToken.trim().length > 0) return undefined;
  return "non-default tool requires per-run consent token";
}

/**
 * The run-safety gate, written once: capability-probe the runner, then (if the
 * probe passes) the caller may spawn the pinned, read-only argv. Returns the
 * probe outcome so a missing runner degrades to an empty result + a status.
 */
export function runSafetyGate(
  candidate: ExternalAnalyzerCandidate,
  run: AcquisitionRunner,
  root: string,
): { ok: true } | { ok: false; reason: string } {
  // Pinned version is mandatory for reproducibility — a candidate without a
  // pinned tool spec is never executed (degrades to empty + status).
  if (!candidate.spec || candidate.spec.trim().length === 0) {
    return { ok: false, reason: `tool '${candidate.id}' has no pinned version spec` };
  }
  const probe = run(runnerProbeArgv(candidate.runner), root);
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      reason: `runner '${candidate.runner}' not available: ${
        probe.error?.message ?? `exit ${probe.status}`
      }`,
    };
  }
  return { ok: true };
}

function emptyResults(tool: string): ExternalAnalyzerResults {
  return { tool, generated_at: new Date().toISOString(), results: [] };
}

function settingFor(
  analyzers: Record<string, AnalyzerSetting> | undefined,
  id: string,
): AnalyzerSetting {
  return analyzers?.[id] ?? "auto";
}

export interface AcquisitionOutcome {
  results: ExternalAnalyzerResults;
  status: ExternalAnalyzerToolStatus;
}

/**
 * Acquire + run ONE external analyzer candidate ephemerally, normalizing its
 * output through the adapter seam. Never throws; always returns exactly one
 * {@link ExternalAnalyzerToolStatus} alongside the (possibly empty) results.
 */
export function runExternalAnalyzer(
  candidate: ExternalAnalyzerCandidate,
  root: string,
  options: AcquisitionEngineOptions = {},
): AcquisitionOutcome {
  if (OWNED_TOOL_IDS.has(candidate.id)) {
    // Defence in depth — registration already rejects these.
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        resolved: false,
        status: "skipped",
        error: "owned by F6 (git-history/secret-scan); never acquired",
      },
    };
  }

  const run = options.run ?? ((argv, cwd) => runTracked(argv, { cwd }));
  const log = options.log ?? (() => {});
  const setting = settingFor(options.analyzers, candidate.id);

  if (!candidate.detect(root)) {
    return {
      results: emptyResults(candidate.id),
      status: { tool: candidate.id, resolved: false, status: "skipped", error: "ecosystem not detected" },
    };
  }

  // Single spawn-admission chokepoint — consent gating before anything spawns.
  const denied = admitSpawn(candidate, setting, options.consentToken);
  if (denied) {
    log("[f5] %s spawn not admitted: %s", candidate.id, denied);
    return {
      results: emptyResults(candidate.id),
      status: { tool: candidate.id, resolved: false, status: "skipped", error: denied },
    };
  }

  // Resolve the argv prefix. A `binary` candidate is gated by binary-acquisition
  // (PATH probe / checksum-verified download) AHEAD of the engine, so it skips the
  // runner probe and uses its resolved executable path; everything else passes the
  // capability-probe run-safety gate before its first real spawn.
  let prefix: string[];
  if (candidate.runner === "binary") {
    const resolved = options.resolvedBinaries?.[candidate.id];
    if (!resolved) {
      log("[f5] %s binary not acquired", candidate.id);
      return {
        results: emptyResults(candidate.id),
        status: {
          tool: candidate.id,
          resolved: false,
          status: "not_resolved",
          error: "binary not acquired (PATH probe failed and download unavailable)",
        },
      };
    }
    prefix = [resolved];
  } else {
    const gate = runSafetyGate(candidate, run, root);
    if (!gate.ok) {
      log("[f5] %s safety gate failed: %s", candidate.id, gate.reason);
      return {
        results: emptyResults(candidate.id),
        status: { tool: candidate.id, resolved: false, status: "not_resolved", error: gate.reason },
      };
    }
    prefix = runnerPrefix(candidate.runner, candidate.spec);
  }

  const argv = candidate.buildArgv(prefix, root);
  const command = argv.join(" ");
  let result: RunTrackedResult;
  try {
    result = run(argv, root);
  } catch (error) {
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        command,
        resolved: true,
        status: "spawn_error",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (result.error) {
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        command,
        resolved: true,
        status: "spawn_error",
        exit_code: result.status,
        error: result.error.message,
      },
    };
  }

  // Tools that report to a file (gitleaks) are read from there; stdout tools use
  // stdout. The report file is best-effort removed after parsing.
  let parseInput = result.stdout;
  if (candidate.reportFile) {
    const reportPath = candidate.reportFile(root);
    try {
      parseInput = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    } catch {
      parseInput = "";
    }
    try {
      if (existsSync(reportPath)) rmSync(reportPath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  let items: ReturnType<ExternalAnalyzerCandidate["parse"]>;
  try {
    items = candidate.parse(parseInput);
  } catch (error) {
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        command,
        resolved: true,
        status: "parse_error",
        exit_code: result.status,
        error: error instanceof Error ? error.message : String(error),
        output_snippet: result.stdout.slice(0, 200),
      },
    };
  }

  const normalized = normalizeGenericExternalResults(candidate.id, items);
  const edges = normalizeGenericExternalEdges(items);
  if (edges.length > 0) normalized.graph_edges = edges;

  return {
    results: normalized,
    status: {
      tool: candidate.id,
      command,
      resolved: true,
      status: normalized.results.length > 0 ? "findings" : "success",
      exit_code: result.status,
    },
  };
}

/**
 * Register external analyzer candidates, rejecting any whose id is OWNED by F6
 * (git-history/secret-scan). Returns the accepted candidates; the own-vs-acquire
 * boundary is enforced HERE so an owned tool can never enter the engine.
 */
export function registerExternalAnalyzers(
  candidates: ExternalAnalyzerCandidate[],
): ExternalAnalyzerCandidate[] {
  const accepted: ExternalAnalyzerCandidate[] = [];
  for (const candidate of candidates) {
    if (OWNED_TOOL_IDS.has(candidate.id)) continue;
    accepted.push(candidate);
  }
  return accepted;
}

export interface ResolvedBinaries {
  /** id → resolved executable path/name, for candidates that resolved. */
  resolvedBinaries: Record<string, string>;
  /** One status per `binary` candidate that did NOT resolve (skipped/unavailable). */
  unresolvedStatuses: ExternalAnalyzerToolStatus[];
}

/**
 * Resolve (acquiring if absent) the executable for every `runner: "binary"`
 * candidate, ahead of the synchronous engine. This is where the async network
 * I/O + checksum gate lives. Owned tools and non-binary candidates are skipped.
 * Never throws; an unresolved binary yields a `not_resolved`/`skipped` status so
 * the caller can record the coverage gap (never silently dropped).
 */
export async function resolveBinaryCandidates(
  candidates: ExternalAnalyzerCandidate[],
  root: string,
  options: AcquisitionEngineOptions & BinaryResolveOptions = {},
): Promise<ResolvedBinaries> {
  const resolvedBinaries: Record<string, string> = {};
  const unresolvedStatuses: ExternalAnalyzerToolStatus[] = [];
  for (const candidate of candidates) {
    if (candidate.runner !== "binary" || !candidate.binary) continue;
    if (OWNED_TOOL_IDS.has(candidate.id)) continue;
    if (!candidate.detect(root)) {
      unresolvedStatuses.push({
        tool: candidate.id,
        resolved: false,
        status: "skipped",
        error: "ecosystem not detected",
      });
      continue;
    }
    const setting = settingFor(options.analyzers, candidate.id);
    const denied = admitSpawn(candidate, setting, options.consentToken);
    if (denied) {
      unresolvedStatuses.push({
        tool: candidate.id,
        resolved: false,
        status: "skipped",
        error: denied,
      });
      continue;
    }
    const resolution = await resolveBinary(candidate.binary, options);
    if (resolution.command) {
      resolvedBinaries[candidate.id] = resolution.command;
    } else {
      unresolvedStatuses.push({
        tool: candidate.id,
        resolved: false,
        status: "not_resolved",
        error: resolution.note ?? "binary unavailable",
      });
    }
  }
  return { resolvedBinaries, unresolvedStatuses };
}

export interface RunAllOutcome {
  results: ExternalAnalyzerResults[];
  statuses: ExternalAnalyzerToolStatus[];
}

/**
 * Drive the whole registered candidate set through the engine for one repo,
 * collecting one status per candidate. Owned tools are rejected at registration;
 * each survivor passes through the spawn-admission chokepoint and run-safety gate.
 */
export function runAcquisitionEngine(
  candidates: ExternalAnalyzerCandidate[],
  root: string,
  options: AcquisitionEngineOptions = {},
): RunAllOutcome {
  const registered = registerExternalAnalyzers(candidates);
  const results: ExternalAnalyzerResults[] = [];
  const statuses: ExternalAnalyzerToolStatus[] = [];
  for (const candidate of registered) {
    const outcome = runExternalAnalyzer(candidate, root, options);
    statuses.push(outcome.status);
    if (outcome.results.results.length > 0 || outcome.results.graph_edges?.length) {
      results.push(outcome.results);
    }
  }
  return { results, statuses };
}
