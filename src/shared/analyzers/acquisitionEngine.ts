import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runTrackedAsync, type RunTrackedResult } from "../tooling/exec.js";
import type { AnalyzerSetting } from "../analyzerPolicy.js";
import {
  normalizeGenericExternalResults,
  normalizeGenericExternalEdges,
} from "./normalizeExternal.js";
import {
  readParseOutcome,
  type ExternalAnalyzerParseOutcome,
  type ExternalAnalyzerParsedItem,
  type ExternalAnalyzerResults,
  type ExternalAnalyzerToolStatus,
} from "./types.js";
import {
  resolveBinary,
  type BinarySpec,
  type BinaryResolveOptions,
} from "./binaryAcquisition.js";

/**
 * External analyzer acquisition engine.
 *
 * On-demand acquisition + ephemeral execution of mature, ecosystem-native
 * analyzers (eslint, ruff, cargo-clippy, …). Distinct from the in-tree
 * `LanguageAnalyzer` registry (which enriches the regex floor from a resolved
 * npm package directory): this engine *runs an external tool as a subprocess* and
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
 *  - **Own-vs-acquire boundary.** git-history is OWNED in-house and is rejected at
 *    registration — never acquired here. Secret scanning is ACQUIRED (gitleaks).
 *  - **Run-safety gate written once** (`runSafetyGate`): capability-probe, pin
 *    version, read-only/sandboxed argv, degrade-to-empty.
 *  - **Degrade-to-empty + report-skipped-never-silently.** Every candidate
 *    yields exactly one {@link ExternalAnalyzerToolStatus}; a failure never
 *    throws and never silently drops the candidate.
 */

/**
 * Deadline for one acquired-analyzer child (capability probe or the real
 * analyzer run). Wider than the fold's `TRACKED_CHILD_DEADLINE_MS`: a real
 * analyzer sweep over a large repository is suite-scale work, and a
 * false-positive kill silently degrades lead quality — while the probe is
 * sub-second and never feels the extra headroom. The miss classifies as
 * `ETIMEDOUT` and degrades to a reported tool failure, never a hang.
 */
const ANALYZER_CHILD_DEADLINE_MS = 10 * 60 * 1_000;

/**
 * Tool ids OWNED in-house and never acquired. Only git-history mining is OWNED — it
 * is a truly-agnostic signal with no ecosystem tool. Secret scanning is ACQUIRED
 * (gitleaks), not owned, so it is deliberately NOT listed here.
 */
export const OWNED_TOOL_IDS = new Set<string>([
  "git-history",
  "git-history-mining",
]);

/**
 * Ecosystem runners this engine knows how to drive. `npx`/`pipx`/`cargo`/`bundle` acquire
 * + run a pinned package ephemerally; `binary` runs a standalone release binary
 * resolved (and downloaded-if-absent) by the binary-acquisition seam.
 */
export type EcosystemRunner = "npx" | "pipx" | "cargo" | "bundle" | "binary";

/**
 * Safety properties of an external analyzer. `defaultRun` eligibility derives
 * from these: `config_execution !== "executable" && !network_egress && version_pinning === "pinned"`.
 */
export interface AnalyzerSafetyProfile {
  /** Whether the tool might execute repo code during config loading. */
  config_execution: "none" | "inert-data" | "executable";
  /** Whether the tool might make network requests outside the local repo. */
  network_egress: boolean;
  /** How strictly the tool version is pinned. */
  version_pinning: "pinned" | "toolchain-resolved" | "unpinned";
}

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
  /**
   * Pinned tool spec, e.g. "eslint@9.39.5" / "ruff==0.5.0". A candidate whose
   * `safetyProfile.version_pinning` is `"pinned"` must name an EXACT version, never a
   * range — pinned to a range is a promise the registry cannot keep, and the
   * candidates safety contract test refuses it.
   */
  spec: string;
  /**
   * Exact specs installed ALONGSIDE {@link spec} for one ephemeral run — for a tool
   * whose own peer range is looser than the versions it actually works against. The
   * npx runner then names the tool's executable explicitly, because supplying
   * packages (`-p`) supplies no command. Omit when the tool's own resolution is
   * sound: the peers-free argv is deliberately unchanged.
   */
  peers?: readonly string[];
  /**
   * The tool's executable name, when it differs from its package name (npx runner
   * only, and only meaningful alongside {@link peers}). Defaults to the package
   * name parsed off {@link spec}.
   */
  bin?: string;
  /** Safety profile indicating whether this tool is safe to run by default. */
  safetyProfile: AnalyzerSafetyProfile;
  /**
   * One human line: what this analyzer detects. Rendered into the Item B
   * consent offer so the operator decides from the tool's own words, never a
   * host improvisation. Optional only for test fixtures — every registered
   * candidate carries one (pinned by the candidates safety contract test).
   */
  purpose?: string;
  /**
   * Build the read-only argv for the tool given the resolved runner argv prefix
   * and repo root. MUST NOT request fixes/writes — acquisition is observe-only.
   */
  buildArgv(runnerPrefix: string[], root: string): string[];
  /**
   * Parse the tool's stdout into the generic item shape consumed by
   * `normalizeGenericExternalResults`. NEVER throws — but a degradation must be
   * REPORTED, not swallowed: return the {@link ExternalAnalyzerParseReport} form
   * carrying `parse_failed` / `dropped_rows` so the engine can classify the run,
   * because a bare `[]` is byte-identical to a genuinely clean scan.
   */
  parse(stdout: string): ExternalAnalyzerParseOutcome;
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

/**
 * The npm package name of a spec, i.e. everything before the version separator.
 * The separator is the LAST `@` past index 0, so a scoped name ("@acme/lint@1.2.3")
 * keeps its scope; a spec with no version is its own package name.
 */
function npmPackageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function runnerPrefix(candidate: ExternalAnalyzerCandidate): string[] {
  const { runner, spec, peers } = candidate;
  switch (runner) {
    // `-y` so the ephemeral fetch never blocks on a prompt; pinned spec.
    // With peers, the tool and its pinned peers are supplied as PACKAGES (`-p`)
    // and the executable is named separately — `-p` installs, it does not run.
    case "npx": return peers && peers.length > 0
      ? ["npx", "-y", "-p", spec, ...peers.flatMap((p) => ["-p", p]), candidate.bin ?? npmPackageName(spec)]
      : ["npx", "-y", spec];
    case "pipx": return ["pipx", "run", "--spec", spec];
    case "cargo": return ["cargo", spec];
    case "bundle": return ["bundle", "exec", spec];
    // For `binary` the resolved executable path is supplied via
    // options.resolvedBinaries and used directly — this is never called.
    case "binary": return [];
  }
}

/**
 * The async command-runner seam. Analyzer spawns run on
 * {@link runTrackedAsync} (the shared exec boundary's async twin) so a stalled
 * child cannot block the event loop and starve the liveness/file-lock
 * heartbeats; tests inject an async fake at this seam.
 */
export interface AcquisitionRunner {
  (argv: string[], cwd: string): Promise<RunTrackedResult>;
}

/**
 * A recorded, durable operator decision for one analyzer. DECLINE ONLY — a grant
 * binds one run and rides the per-run {@link AnalyzerConsentTokenGrant}, so it
 * has no durable form to be recorded in.
 */
export type AnalyzerConsentDecision = "declined";

/** The recorded decisions, keyed by candidate id, as loaded from the durable policy. */
export type AnalyzerConsentDecisions = Record<string, AnalyzerConsentDecision>;

/**
 * A consent token SCOPED to the analyzers the operator was actually offered. This is
 * THE form a caller issues: the grant names its tools, so a grant obtained by
 * offering one analyzer cannot silently admit an analyzer the operator never saw.
 * The former unscoped bare-string form is retired — a run-wide token is expressed
 * as a grant naming every candidate the run offered.
 */
export interface AnalyzerConsentTokenGrant {
  /** Opaque per-run value; never persisted (pinned by the strict AnalyzerPolicy schema). */
  readonly value: string;
  /** The candidate ids this grant authorizes, and only those. */
  readonly tools: readonly string[];
}

export interface AcquisitionEngineOptions {
  /**
   * Per-run, tool-SCOPED consent grant. REQUIRED to spawn any non-DEFAULT candidate
   * (and any candidate whose setting is ephemeral/permanent). It is the ONLY way a
   * grant is expressed — there is no durable granted decision. Absent ⇒ only the
   * DEFAULT set runs; everything else is reported `skipped` with a consent note.
   * A grant admits ONLY the candidates it names — and NEVER overrides a recorded
   * "declined".
   */
  consentToken?: AnalyzerConsentTokenGrant;
  /** Per-analyzer settings (auto|ephemeral|permanent|skip|repo). */
  analyzers?: Record<string, AnalyzerSetting>;
  /**
   * CALLER OBLIGATION (declared here, not left to prose): the durable analyzer
   * policy is loaded and BOTH `analyzers` and `analyzerConsent` are passed on EVERY
   * acquisition call; an unreadable policy blocks the step rather than degrading to
   * an empty one; and a consent token is never synthesized on the operator's behalf.
   * Omitting this map leaves a recorded decline UNREPRESENTABLE at the chokepoint —
   * the decision cannot be enforced because it never arrives.
   */
  analyzerConsent?: AnalyzerConsentDecisions;
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
 * The denial vocabulary. An operator refusal and a tool nobody has decided on are
 * DIFFERENT causes and must be distinguishable in the persisted status record — a
 * single conflated string cannot tell an operator that their own decline was the
 * reason. Every CONSENT-channel reason names "consent"; `setting_skip` deliberately
 * does not, because it comes from the settings channel (`analyzers.<id> = "skip"`)
 * and is not a consent decision at all.
 */
export const ANALYZER_DENIAL_REASONS = {
  /** `analyzers.<id> = "skip"` — the settings channel, not the consent record. */
  setting_skip: "setting=skip",
  /** A recorded, durable operator refusal. Terminal: no token overrides it. */
  consent_declined:
    "consent declined by the operator for this analyzer (recorded decision)",
  /** No decision recorded and no token presented — nobody has said yes OR no. */
  consent_not_decided:
    "consent not recorded for this analyzer (not yet decided; no consent token for this run)",
  /** A token was presented, but it was issued for a different analyzer. */
  consent_token_scope:
    "consent token was not issued for this analyzer (scoped consent covers other tools only)",
} as const;

/**
 * Does this consent grant authorize THIS candidate?
 *
 * A grant authorizes exactly the tools it names — a grant obtained by offering
 * tool A cannot admit tool B. There is deliberately no run-wide form: a caller
 * that was authorized for everything issues a grant naming everything it offered.
 */
function consentTokenAdmits(
  consentToken: AnalyzerConsentTokenGrant | undefined,
  candidateId: string,
): "admit" | "out_of_scope" | "absent" {
  if (consentToken === undefined || consentToken === null) return "absent";
  if (typeof consentToken.value !== "string" || consentToken.value.trim().length === 0) {
    return "absent";
  }
  if (!Array.isArray(consentToken.tools)) return "out_of_scope";
  return consentToken.tools.includes(candidateId) ? "admit" : "out_of_scope";
}

/**
 * Single subprocess-SPAWN admission chokepoint. Returns the reason a spawn is
 * NOT admitted, or `undefined` when admitted.
 *
 * ORDER IS THE CONTRACT. A recorded `"declined"` is consulted FIRST — before the
 * settings channel, before the DEFAULT-set short-circuit, and before any consent
 * token — so an operator refusal is a veto for EVERY candidate, including a
 * default-set member, and no token can override it. It also outranks
 * `setting=skip`: both refuse, but only one of them is the operator's own decision,
 * and the REASON is what tells them so. Only then: `skip`, then the DEFAULT set
 * runs unprompted, and finally a consent token admits the candidate it was
 * issued for. There is deliberately no durable-grant arm: consent that outlives
 * its run is consent an operator never gave.
 */
export function admitSpawn(
  candidate: ExternalAnalyzerCandidate,
  setting: AnalyzerSetting,
  consentToken: AnalyzerConsentTokenGrant | undefined,
  recordedDecision?: AnalyzerConsentDecision,
): string | undefined {
  // A recorded refusal is terminal and is read BEFORE anything else — including the
  // settings channel, which would otherwise mask the operator's own decision behind
  // a reason that names a config value instead of their decline.
  if (recordedDecision === "declined") return ANALYZER_DENIAL_REASONS.consent_declined;
  if (setting === "skip") return ANALYZER_DENIAL_REASONS.setting_skip;
  if (candidate.defaultRun) return undefined;
  const tokenVerdict = consentTokenAdmits(consentToken, candidate.id);
  if (tokenVerdict === "admit") return undefined;
  if (tokenVerdict === "out_of_scope") return ANALYZER_DENIAL_REASONS.consent_token_scope;
  return ANALYZER_DENIAL_REASONS.consent_not_decided;
}

/**
 * Local (non-analyzer) spawn admission for the deterministic executors that run
 * repo tooling in place — formatters, syntax resolvers. The decline-first rule
 * is ONE rule regardless of WHAT spawns: a recorded operator `declined` for a
 * tool id vetoes every spawn of that id, exactly as {@link admitSpawn} does for
 * acquired analyzers, and nothing overrides it. Everything else about a local
 * command (resolution order, fallbacks) stays its executor's own business; this
 * gate adds only the veto, so "the operator said no to this tool" can never
 * resolve into a spawn.
 *
 * Deliberately narrower than {@link admitSpawn}: a formatter is not an acquired
 * analyzer — there is no per-run consent offer and no DEFAULT-set notion, only
 * the operator's own refusal. The FULL argv is passed, not just `command`, so
 * the reduction sees a `process.execPath` invocation's script
 * (`node …/prettier.cjs` is `prettier`, never `node` — keying the executable
 * alone would let a recorded decline of `prettier` sail past the repo-local
 * `node_modules` arm). An arm whose real tool sits deeper in the argv than the
 * script (`python -m black`, `uvx black`, `pipx run black`) cannot be derived
 * — pass its id as `declaredToolId`; a declared id always wins over derivation.
 */
export function admitLocalSpawn(
  argv: readonly string[],
  recordedDecisions: AnalyzerConsentDecisions | undefined,
  declaredToolId?: string,
): string | undefined {
  const id = declaredToolId ?? localToolIdFor(argv);
  if (recordedDecisions?.[id] === "declined") {
    return ANALYZER_DENIAL_REASONS.consent_declined;
  }
  return undefined;
}

function lastPathSegment(pathLike: string): string {
  const segments = pathLike.split(/[\\/]/u);
  return segments[segments.length - 1] ?? pathLike;
}

/**
 * Strip the suffixes a tool id hides behind: the Windows shim extensions
 * (`.cmd`/`.bat`/`.exe`/`.com`) and the JS script extensions a `node <script>`
 * invocation runs through (`.js`/`.cjs`/`.mjs`). `prettier.cjs` — the actual
 * entrypoint inside the prettier package — has to reduce to `prettier`, or a
 * recorded decline of `prettier` never matches the arm that runs it.
 */
function stripLauncherSuffix(executableName: string): string {
  return executableName.replace(/\.(cmd|bat|exe|com|cjs|mjs|js)$/iu, "");
}

/**
 * Reduce a local spawn's ARGV to its registry key: the executable's basename
 * with any launcher suffix stripped. `C:\repo\node_modules\.bin\prettier.cmd`,
 * `/usr/bin/prettier`, and `prettier` all reduce to `prettier`. For a
 * `process.execPath` invocation (`node <script>`) the SCRIPT name is the key,
 * since that is the tool actually running. A runner-prefix arm whose real tool
 * is a later argv token (`python -m black`, `uvx black`, `pipx run black`)
 * deliberately does NOT reduce to that tool — the caller declares its id
 * instead ({@link admitLocalSpawn}), because argv archaeology cannot tell a
 * tool argument from an ordinary flag.
 */
export function localToolIdFor(argv: readonly string[]): string {
  const [first = "", second = ""] = argv;
  if (first === process.execPath && second.length > 0) {
    return stripLauncherSuffix(lastPathSegment(second));
  }
  return stripLauncherSuffix(lastPathSegment(first));
}

/**
 * The run-safety gate, written once: capability-probe the runner, then (if the
 * probe passes) the caller may spawn the pinned, read-only argv. Returns the
 * probe outcome so a missing runner degrades to an empty result + a status.
 */
export async function runSafetyGate(
  candidate: ExternalAnalyzerCandidate,
  run: AcquisitionRunner,
  root: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Pinned version is mandatory for reproducibility — a candidate without a
  // pinned tool spec is never executed (degrades to empty + status).
  if (!candidate.spec || candidate.spec.trim().length === 0) {
    return { ok: false, reason: `tool '${candidate.id}' has no pinned version spec` };
  }
  const probe = await run(runnerProbeArgv(candidate.runner), root);
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
export async function runExternalAnalyzer(
  candidate: ExternalAnalyzerCandidate,
  root: string,
  options: AcquisitionEngineOptions = {},
): Promise<AcquisitionOutcome> {
  if (OWNED_TOOL_IDS.has(candidate.id)) {
    // Defence in depth — registration already rejects these.
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        resolved: false,
        status: "skipped",
        error: "owned in-house (git-history/secret-scan); never acquired",
      },
    };
  }

  // The async shared runner (runTrackedAsync), never the synchronous twin: a
  // synchronous child would block this loop and starve every liveness /
  // file-lock heartbeat in the process for the length of one stalled probe.
  // The deadline is declared, not inherited: without one, runTrackedAsync arms
  // NO timer, and an analyzer that never exits hangs the awaiting fold.
  const run =
    options.run ??
    ((argv, cwd) =>
      runTrackedAsync(argv, { cwd, timeout: ANALYZER_CHILD_DEADLINE_MS }));
  const log = options.log ?? (() => {});
  const setting = settingFor(options.analyzers, candidate.id);

  if (!candidate.detect(root)) {
    return {
      results: emptyResults(candidate.id),
      status: { tool: candidate.id, resolved: false, status: "skipped", error: "ecosystem not detected" },
    };
  }

  // Single spawn-admission chokepoint — consent gating before anything spawns.
  const recordedDecision = options.analyzerConsent?.[candidate.id];
  const denied = admitSpawn(candidate, setting, options.consentToken, recordedDecision);
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
    const gate = await runSafetyGate(candidate, run, root);
    if (!gate.ok) {
      log("[f5] %s safety gate failed: %s", candidate.id, gate.reason);
      return {
        results: emptyResults(candidate.id),
        status: { tool: candidate.id, resolved: false, status: "not_resolved", error: gate.reason },
      };
    }
    prefix = runnerPrefix(candidate);
  }

  const argv = candidate.buildArgv(prefix, root);
  const command = argv.join(" ");
  let result: RunTrackedResult;
  try {
    result = await run(argv, root);
  } catch (error) {
    return {
      results: emptyResults(candidate.id),
      status: {
        tool: candidate.id,
        command,
        resolved: true,
        status: "spawn_error",
        error: error instanceof Error ? error.message : String(error),
        duration_ms: 0,
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
        duration_ms: result.duration_ms,
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

  const stderrText = typeof result.stderr === "string" ? result.stderr : "";
  const stderrSnippet =
    stderrText.trim().length > 0 ? { stderr_snippet: stderrText.slice(0, 500) } : {};

  let parsed: ReturnType<typeof readParseOutcome>;
  try {
    parsed = readParseOutcome(candidate.parse(parseInput));
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
        ...stderrSnippet,
        duration_ms: result.duration_ms,
      },
    };
  }
  const items: ExternalAnalyzerParsedItem[] = parsed.items;

  // readSource: content-anchored lead provenance (item C). Paths are normalized to
  // repo-relative FIRST (an absolute-path emitter would otherwise make `join(root,
  // path)` name nothing, silently dropping provenance); a read that still fails is
  // COUNTED onto the status, so a broken read seam is distinguishable from an item
  // that legitimately carries no anchor.
  let sourceReadFailures = 0;
  let normalizerDroppedItems = 0;
  const normalized = normalizeGenericExternalResults(candidate.id, items, {
    repoRoot: root,
    readSource: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return undefined;
      }
    },
    onDiagnostics: (diagnostics) => {
      sourceReadFailures = diagnostics.source_read_failures;
      normalizerDroppedItems = diagnostics.dropped_items;
    },
  });
  const edges = normalizeGenericExternalEdges(items);
  if (edges.length > 0) normalized.graph_edges = edges;

  // Rows the PARSER could not use plus items the NORMALIZER discarded (missing path
  // or summary) are the same question to a consumer — "how much did this run fail to
  // report?" — so they land on one field. Counting only the parser's half left a run
  // whose every item was dropped at normalization reading as a clean scan.
  const droppedRows = (parsed.dropped_rows ?? 0) + normalizerDroppedItems;
  const degradationFields = {
    exit_code: result.status,
    ...(droppedRows > 0 ? { dropped_rows: droppedRows } : {}),
    ...(sourceReadFailures > 0 ? { source_read_failures: sourceReadFailures } : {}),
    ...stderrSnippet,
    duration_ms: result.duration_ms,
  };

  // AFFIRMATION, never a success-shaped empty. Zero items is only "success" when the
  // run itself was clean: the tool exited 0, said nothing on stderr it did not also
  // say on stdout, parsed, and dropped nothing. Every other zero-item outcome names
  // its cause — the exit code and stderr are in hand right here, which is exactly
  // why leaving them unconsulted made a broken analyzer read as a clean repo.
  if (normalized.results.length === 0) {
    // A NULL exit status means the child never exited on its own — it was killed by a
    // signal (SIGKILL/OOM). `RunTrackedResult` carries no signal field, so null is the
    // only trace of it, and it is emphatically not "exited cleanly". Treating it as
    // clean also made the classification OS-divergent: win32 surfaces the same kill as
    // a non-zero status, so the identical event would have been failed there and
    // success on POSIX.
    const exitMissing = result.status === null || result.status === undefined;
    const exitedNonZero = exitMissing || result.status !== 0;
    const stderrOnly =
      !exitedNonZero && stderrText.trim().length > 0 && parseInput.trim().length === 0;
    if (exitedNonZero || stderrOnly) {
      return {
        results: emptyResults(candidate.id),
        status: {
          tool: candidate.id,
          command,
          resolved: true,
          status: "failed",
          error: exitMissing
            ? "analyzer terminated without an exit status (killed by a signal) and produced no parsable findings"
            : exitedNonZero
              ? `analyzer exited ${result.status} with no parsable findings`
              : "analyzer produced no output other than stderr",
          output_snippet: result.stdout.slice(0, 200),
          ...degradationFields,
        },
      };
    }
    if (parsed.parse_failed || droppedRows > 0) {
      return {
        results: emptyResults(candidate.id),
        status: {
          tool: candidate.id,
          command,
          resolved: true,
          status: "parse_error",
          error:
            parsed.note ??
            (parsed.parse_failed
              ? "analyzer output could not be parsed"
              : `analyzer output parsed with ${droppedRows} unusable row(s)`),
          output_snippet: parseInput.slice(0, 200),
          ...degradationFields,
        },
      };
    }
  }

  return {
    results: normalized,
    status: {
      tool: candidate.id,
      command,
      resolved: true,
      status: normalized.results.length > 0 ? "findings" : "success",
      ...(parsed.note !== undefined ? { error: parsed.note } : {}),
      ...degradationFields,
    },
  };
}

/**
 * Register external analyzer candidates, rejecting any whose id is OWNED in-house
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
    const recordedDecision = options.analyzerConsent?.[candidate.id];
    const denied = admitSpawn(candidate, setting, options.consentToken, recordedDecision);
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
      // A supply-chain event gets its OWN status member: "the release asset did not
      // match the pinned checksums" must never be flattened into the same record as
      // "this machine is offline", which is all a shared `not_resolved` could say.
      unresolvedStatuses.push({
        tool: candidate.id,
        resolved: false,
        status:
          resolution.reason === "checksum_mismatch" ? "checksum_mismatch" : "not_resolved",
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
export async function runAcquisitionEngine(
  candidates: ExternalAnalyzerCandidate[],
  root: string,
  options: AcquisitionEngineOptions = {},
): Promise<RunAllOutcome> {
  const registered = registerExternalAnalyzers(candidates);
  const results: ExternalAnalyzerResults[] = [];
  const statuses: ExternalAnalyzerToolStatus[] = [];
  for (const candidate of registered) {
    // Sequential by design: one analyzer at a time keeps the spawn set bounded
    // and the status order deterministic (registration order).
    const outcome = await runExternalAnalyzer(candidate, root, options);
    statuses.push(outcome.status);
    if (outcome.results.results.length > 0 || outcome.results.graph_edges?.length) {
      results.push(outcome.results);
    }
  }
  return { results, statuses };
}
