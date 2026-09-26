// sites-pinned: tests/shared/performanceProfiler.test.ts
import {
  resolveExecArgv,
  runTracked,
  runTrackedAsync,
  resolveSpawnDeadline,
  TRACKED_CHILD_DEADLINE_MS,
  type RunTrackedOptions,
  type RunTrackedSyncOptions,
  type SpawnDeadline,
  type SpawnDeadlineMiss,
} from "../tooling/exec.js";

/**
 * Performance profiling — one module, two draws.
 *
 * The audit orchestrator and remediate orchestrator both spawn subprocesses
 * through the shared exec boundary (`runTrackedAsync` / `runTracked`).
 * This module provides a unified profiling layer that:
 *  - Attributes every slow command to a concrete child (argv, cwd, duration, exit, log)
 *  - Measures synchronous blocking phases (event-loop stalls and fold-safety bounds)
 *  - Detects repeated command work (same argv executed multiple times)
 *  - Produces a structured profile ledger alongside the existing run log
 *
 * It REUSES the existing bounded-child deadline infrastructure:
 *  - `TRACKED_CHILD_DEADLINE_MS` — the fold child deadline (120s)
 *  - `resolveSpawnDeadline` — absolute-deadline propagation
 *  - `SpawnDeadlineMiss` — what was observed at deadline fire
 *  - `describeDeadlineMiss` — argv + elapsed + fate for diagnostics
 *
 * The profile is ALWAYS ON (no opt-in) — a regression is visible without
 * anyone remembering to enable it.
 */

export interface ProfiledSpawn {
  /** The argv actually spawned, after platform wrapping. */
  argv: string[];
  /** The cwd the command ran in. */
  cwd?: string;
  /** Elapsed wall-clock time in milliseconds. */
  duration_ms: number;
  /** Exit code, or null if the child never exited on its own. */
  exit_code: number | null;
  /** Signal that killed the child, if any. */
  signal?: string | null;
  /** Whether this spawn was attributed to a deadline miss. */
  deadline_miss?: SpawnDeadlineMiss;
  /** How many times this exact argv has been seen in this profiling session. */
  occurrence_count: number;
  /** ISO timestamp when the spawn started. */
  started_at: string;
  /** ISO timestamp when the spawn finished. */
  finished_at: string;
  /** Captured stdout from the child process. */
  stdout?: string;
  /** Captured stderr from the child process. */
  stderr?: string;
  /** Error from child execution or spawn, if any. */
  error?: Error & { code?: string };
}

export interface SynchronousPhase {
  /** Label for this synchronous stretch (e.g., "typecheck-bundle", "artifact-write"). */
  label: string;
  /** Start time (high-resolution ms since process start). */
  start_hr: number;
  /** End time (high-resolution ms since process start). */
  end_hr: number;
  /** Duration in milliseconds. */
  duration_ms: number;
  /** Whether this phase exceeded the synchronous-spawn fold-safety bound (30s). */
  exceeds_fold_safety_bound: boolean;
}

export interface RepeatedCommandGroup {
  /** The argv that was repeated. */
  argv: string[];
  /** How many times it was executed. */
  count: number;
  /** Total duration across all occurrences. */
  total_duration_ms: number;
  /** Individual occurrences. */
  occurrences: ProfiledSpawn[];
}

export interface PerformanceProfile {
  /** Unique session identifier. */
  session_id: string;
  /** When profiling started. */
  started_at: string;
  /** When profiling ended. */
  finished_at?: string;
  /** All profiled spawns in chronological order. */
  spawns: ProfiledSpawn[];
  /** Synchronous blocking phases detected. */
  synchronous_phases: SynchronousPhase[];
  /** Repeated command groups (2+ occurrences of same argv). */
  repeated_commands: RepeatedCommandGroup[];
  /** Summary statistics. */
  summary: {
    total_spawns: number;
    total_spawn_duration_ms: number;
    total_synchronous_duration_ms: number;
    slowest_spawn?: ProfiledSpawn;
    most_repeated_argv?: string[];
    deadline_misses: number;
  };
}

/** In-memory session state. Not persisted — use writeProfileLedger for durability. */
let currentSession: PerformanceProfile | null = null;
let synchronousPhaseStack: Array<{ label: string; start_hr: number }> = [];
let argvCounts = new Map<string, number>();
let firstSpawnByArgv = new Map<string, ProfiledSpawn>();
let sessionCounter = 0;

/** Generate a stable argv key for deduplication. */
function argvKey(argv: readonly string[]): string {
  return argv.join("\0");
}

/** Start a new profiling session. */
export function startProfileSession(): PerformanceProfile {
  const sessionId = `perf-${Date.now()}-${(sessionCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  currentSession = {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    spawns: [],
    synchronous_phases: [],
    repeated_commands: [],
    summary: {
      total_spawns: 0,
      total_spawn_duration_ms: 0,
      total_synchronous_duration_ms: 0,
      deadline_misses: 0,
    },
  };
  synchronousPhaseStack = [];
  argvCounts = new Map();
  firstSpawnByArgv = new Map();
  return currentSession;
}

/** Get the current session, creating one if needed. */
export function getCurrentSession(): PerformanceProfile {
  if (!currentSession) return startProfileSession();
  return currentSession;
}

/** Mark the start of a synchronous phase (event-loop blocking stretch). */
export function markSynchronousPhaseStart(label: string, startHr?: number): void {
  getCurrentSession();
  synchronousPhaseStack.push({ label, start_hr: startHr ?? performance.now() });
}

/** Mark the end of a synchronous phase. */
export function markSynchronousPhaseEnd(label: string): SynchronousPhase | null {
  const session = getCurrentSession();
  let idx = -1;
  for (let i = synchronousPhaseStack.length - 1; i >= 0; i--) {
    if (synchronousPhaseStack[i].label === label) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  const phase = synchronousPhaseStack[idx];
  synchronousPhaseStack.splice(idx, 1);
  const end_hr = performance.now();
  const duration_ms = end_hr - phase.start_hr;
  const syncPhase: SynchronousPhase = {
    label: phase.label,
    start_hr: phase.start_hr,
    end_hr,
    duration_ms,
    exceeds_fold_safety_bound: duration_ms > 30_000, // 30s stale-lock window
  };
  session.synchronous_phases.push(syncPhase);
  session.summary.total_synchronous_duration_ms += duration_ms;
  return syncPhase;
}

/** Profile a synchronous phase with automatic start/end handling. */
export function profileSynchronousPhase<T>(
  label: string,
  fn: () => T,
): { result: T; phase: SynchronousPhase } {
  markSynchronousPhaseStart(label);
  try {
    const result = fn();
    const phase = markSynchronousPhaseEnd(label)!;
    return { result, phase };
  } catch (err) {
    markSynchronousPhaseEnd(label);
    throw err;
  }
}

/**
 * Profile a spawn through the shared async exec boundary.
 *
 * This is the MAIN profiling entry point. It wraps `runTrackedAsync` and
 * automatically records the spawn with attribution, occurrence counting,
 * and deadline-miss detection.
 */
export async function profileSpawn(
  argv: string[],
  options: RunTrackedOptions = {},
  deadline?: SpawnDeadline,
): Promise<ProfiledSpawn> {
  const session = getCurrentSession();
  const resolvedArgv = resolveExecArgv(argv, { platform: options.platform });
  const key = argvKey(resolvedArgv);
  const occurrenceCount = (argvCounts.get(key) ?? 0) + 1;
  argvCounts.set(key, occurrenceCount);

  const started_at = new Date().toISOString();
  const startHr = performance.now();

  const timeout = resolveSpawnDeadline(deadline, options.timeout, TRACKED_CHILD_DEADLINE_MS);
  const result = await runTrackedAsync(resolvedArgv, {
    ...options,
    timeout,
  });

  const endHr = performance.now();
  const duration_ms = endHr - startHr;
  const finished_at = new Date().toISOString();

  // Check for deadline miss
  let deadlineMiss: SpawnDeadlineMiss | undefined;
  const error = result.error as (Error & { code?: string }) | undefined;
  if (error?.code === "ETIMEDOUT") {
    session.summary.deadline_misses++;
    const msg = error.message ?? "";
    const match = msg.match(/after (\d+)ms/);
    deadlineMiss = {
      elapsed_ms: match ? parseInt(match[1]!, 10) : duration_ms,
      child_exited: msg.includes("child had already exited when the deadline fired"),
      survived_grace: msg.includes("SIGKILL"),
    };
  }

  const profiled: ProfiledSpawn = {
    argv: resolvedArgv,
    cwd: options.cwd,
    duration_ms,
    exit_code: result.status,
    signal: result.signal ?? null,
    deadline_miss: deadlineMiss,
    occurrence_count: occurrenceCount,
    started_at,
    finished_at,
    stdout: result.stdout,
    stderr: result.stderr,
    error,
  };

  session.spawns.push(profiled);
  session.summary.total_spawns++;
  session.summary.total_spawn_duration_ms += duration_ms;

  // Update slowest
  if (
    !session.summary.slowest_spawn ||
    profiled.duration_ms > session.summary.slowest_spawn.duration_ms
  ) {
    session.summary.slowest_spawn = profiled;
  }

  // Track first spawn for repeated commands group
  if (!firstSpawnByArgv.has(key)) {
    firstSpawnByArgv.set(key, profiled);
  }

  // Update most repeated and repeated commands group
  if (occurrenceCount >= 2) {
    const repeated = session.repeated_commands.find((g) => argvKey(g.argv) === key);
    if (repeated) {
      repeated.count = occurrenceCount;
      repeated.total_duration_ms += duration_ms;
      repeated.occurrences.push(profiled);
    } else {
      const priorOccurrences = session.spawns.filter(
        (s) => s !== profiled && argvKey(s.argv) === key,
      );
      const priorDuration = priorOccurrences.reduce((sum, s) => sum + s.duration_ms, 0);
      session.repeated_commands.push({
        argv: resolvedArgv,
        count: occurrenceCount,
        total_duration_ms: priorDuration + duration_ms,
        occurrences: [...priorOccurrences, profiled],
      });
    }
    const currentMostRepeated = session.summary.most_repeated_argv;
    if (!currentMostRepeated || occurrenceCount > (argvCounts.get(argvKey(currentMostRepeated)) ?? 0)) {
      session.summary.most_repeated_argv = resolvedArgv;
    }
  }

  return profiled;
}

/**
 * Profile a SYNCHRONOUS spawn through the shared sync exec boundary.
 *
 * Use sparingly — synchronous spawns block the event loop and starve lock
 * heartbeats. The INV-SSF test (`sync-spawn-fold-safety.test.ts`) forbids
 * them in fold-reachable modules.
 */
export function profileSpawnSync(
  argv: string[],
  options: RunTrackedSyncOptions,
): ProfiledSpawn {
  const session = getCurrentSession();
  const resolvedArgv = resolveExecArgv(argv, { platform: options.platform });
  const key = argvKey(resolvedArgv);
  const occurrenceCount = (argvCounts.get(key) ?? 0) + 1;
  argvCounts.set(key, occurrenceCount);

  const started_at = new Date().toISOString();
  const startHr = performance.now();

  const result = runTracked(resolvedArgv, options);

  const endHr = performance.now();
  const duration_ms = endHr - startHr;
  const finished_at = new Date().toISOString();

  let deadlineMiss: SpawnDeadlineMiss | undefined;
  const error = result.error as (Error & { code?: string }) | undefined;
  if (error?.code === "ETIMEDOUT") {
    session.summary.deadline_misses++;
    const msg = error.message ?? "";
    const match = msg.match(/after (\d+)ms/);
    deadlineMiss = {
      elapsed_ms: match ? parseInt(match[1]!, 10) : duration_ms,
      child_exited: msg.includes("child had already exited when the deadline fired"),
      survived_grace: msg.includes("SIGKILL"),
    };
  }

  const profiled: ProfiledSpawn = {
    argv: resolvedArgv,
    cwd: options.cwd,
    duration_ms,
    exit_code: result.status,
    signal: result.signal ?? null,
    deadline_miss: deadlineMiss,
    occurrence_count: occurrenceCount,
    started_at,
    finished_at,
    stdout: result.stdout,
    stderr: result.stderr,
    error,
  };

  session.spawns.push(profiled);
  session.summary.total_spawns++;
  session.summary.total_spawn_duration_ms += duration_ms;

  // Track first spawn for repeated commands group
  if (!firstSpawnByArgv.has(key)) {
    firstSpawnByArgv.set(key, profiled);
  }

  if (
    !session.summary.slowest_spawn ||
    profiled.duration_ms > session.summary.slowest_spawn.duration_ms
  ) {
    session.summary.slowest_spawn = profiled;
  }

  if (occurrenceCount >= 2) {
    const repeated = session.repeated_commands.find((g) => argvKey(g.argv) === key);
    if (repeated) {
      repeated.count = occurrenceCount;
      repeated.total_duration_ms += duration_ms;
      repeated.occurrences.push(profiled);
    } else {
      const priorOccurrences = session.spawns.filter(
        (s) => s !== profiled && argvKey(s.argv) === key,
      );
      const priorDuration = priorOccurrences.reduce((sum, s) => sum + s.duration_ms, 0);
      session.repeated_commands.push({
        argv: resolvedArgv,
        count: occurrenceCount,
        total_duration_ms: priorDuration + duration_ms,
        occurrences: [...priorOccurrences, profiled],
      });
    }
    const currentMostRepeated = session.summary.most_repeated_argv;
    if (!currentMostRepeated || occurrenceCount > (argvCounts.get(argvKey(currentMostRepeated)) ?? 0)) {
      session.summary.most_repeated_argv = resolvedArgv;
    }
  }

  return profiled;
}

/** End the current session and return the complete profile. */
export function endProfileSession(): PerformanceProfile | null {
  if (!currentSession) return null;
  const session = currentSession;
  session.finished_at = new Date().toISOString();
  currentSession = null;
  synchronousPhaseStack = [];
  argvCounts = new Map();
  firstSpawnByArgv = new Map();
  return session;
}

/**
 * Write the profile to a structured ledger under `.audit-tools-profile/`.
 *
 * Produces:
 *  - `<name>-latest.json` — full snapshot
 *  - `<name>-history.ndjson` — append-only history
 *
 * The ledger directory is gitignored (`.audit-tools-profile/`).
 */
export async function writeProfileLedger(
  profileName: string,
  profile: PerformanceProfile,
  meta: Record<string, unknown> = {},
  options: { profileDir?: string; root?: string } = {},
): Promise<Record<string, unknown>> {
  const { mkdirSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = options.root ?? resolve(here, "../../..");
  const profileDir = options.profileDir ?? resolve(repoRoot, ".audit-tools-profile");

  const record: Record<string, unknown> = {
    profile: profileName,
    profile_name: profileName,
    ...profile,
    ...meta,
  };

  try {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(resolve(profileDir, `${profileName}-latest.json`), JSON.stringify(record, null, 2));
    appendFileSync(resolve(profileDir, `${profileName}-history.ndjson`), `${JSON.stringify(record)}\n`);
  } catch {
    // Profiling is advisory — a ledger write failure must never fail a run.
  }

  return record;
}

/**
 * Convenience: profile a command through npm (the common case in this repo).
 *
 * Honors Windows semantics: on Windows, npm is a batch shim (npm.cmd) which
 * resolves through wrapForWindowsBatch to cmd.exe.
 */
export async function profileNpmCommand(
  args: string[] | string,
  options: RunTrackedOptions & { deadline?: SpawnDeadline } = {},
): Promise<ProfiledSpawn> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = Array.isArray(args) ? args : ["run", "--silent", args];
  return profileSpawn([npm, ...npmArgs], options, options.deadline);
}

/**
 * Convenience: profile a node command.
 */
export async function profileNodeCommand(
  script: string,
  args: string[] = [],
  options: RunTrackedOptions & { deadline?: SpawnDeadline } = {},
): Promise<ProfiledSpawn> {
  return profileSpawn([process.execPath, script, ...args], options, options.deadline);
}

/**
 * Get a human-readable summary of the profile.
 */
export function formatProfileSummary(profile: PerformanceProfile): string {
  const lines = [
    `Performance Profile: ${profile.session_id}`,
    `  Started: ${profile.started_at}`,
    `  Finished: ${profile.finished_at ?? "in progress"}`,
    `  Total spawns: ${profile.summary.total_spawns}`,
    `  Total spawn duration: ${(profile.summary.total_spawn_duration_ms / 1000).toFixed(1)}s`,
    `  Total synchronous duration: ${(profile.summary.total_synchronous_duration_ms / 1000).toFixed(1)}s`,
    `  Deadline misses: ${profile.summary.deadline_misses}`,
  ];

  if (profile.summary.slowest_spawn) {
    lines.push(
      `  Slowest spawn: ${profile.summary.slowest_spawn.argv.join(" ")} (${(profile.summary.slowest_spawn.duration_ms / 1000).toFixed(1)}s)`,
    );
  }

  if (profile.repeated_commands.length > 0) {
    lines.push(`  Repeated commands:`);
    for (const group of profile.repeated_commands) {
      lines.push(
        `    ${group.count}x ${group.argv.join(" ")} — ${(group.total_duration_ms / 1000).toFixed(1)}s total`,
      );
    }
  }

  if (profile.synchronous_phases.length > 0) {
    lines.push(`  Synchronous phases:`);
    for (const phase of profile.synchronous_phases) {
      const flag = phase.exceeds_fold_safety_bound ? " ⚠ EXCEEDS 30s FOLD-SAFETY BOUND" : "";
      lines.push(
        `    ${phase.label}: ${(phase.duration_ms / 1000).toFixed(1)}s${flag}`,
      );
    }
  }

  return lines.join("\n");
}

/** Reset the global session state (for tests). */
export function _resetProfileState(): void {
  currentSession = null;
  synchronousPhaseStack = [];
  argvCounts = new Map();
  firstSpawnByArgv = new Map();
}
