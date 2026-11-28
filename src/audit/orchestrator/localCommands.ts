import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import {
  admitLocalSpawn,
  resolveExecArgv,
  runTrackedAsync,
  TRACKED_CHILD_DEADLINE_MS,
  type AnalyzerConsentDecisions,
} from "audit-tools/shared";

export interface LocalCommandCandidate {
  command: string;
  args: string[];
  display?: string;
  /**
   * Explicit registry key for admission, for an arm whose argv cannot yield
   * its real tool (`python -m black`, `uvx black`, `pipx run black`). Absent
   * ⇒ the key derives from the full argv ({@link localToolIdFor}).
   */
  toolId?: string;
}

export interface LocalCommandResult {
  candidate: LocalCommandCandidate;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The refusal reason when a recorded operator decline vetoed the candidate. */
  declinedReason?: string;
  error?: Error;
}

function toSpawnTuple(candidate: LocalCommandCandidate): {
  command: string;
  args: string[];
} {
  // Shared resolver applies the single Windows `.cmd`/`.bat` wrapping impl.
  // The candidate command is already PATH-resolved (absolute path or
  // process.execPath), so package-manager shim mapping is a no-op here.
  const resolved = resolveExecArgv([candidate.command, ...candidate.args]);
  return { command: resolved[0], args: resolved.slice(1) };
}

function isUsableFile(path: string, accessMode: number): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, accessMode);
    return true;
  } catch {
    return false;
  }
}

function* resolveCommandPaths(root: string, command: string): Generator<string> {
  if (command.trim().length === 0) {
    return;
  }

  if (
    command.includes("\\") ||
    command.includes("/") ||
    isAbsolute(command)
  ) {
    // Relative explicit paths are launched under the same cwd we probe.
    yield resolve(root, command);
    return;
  }

  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => ext.length > 0)
          .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`))
      : [""];

  // On Win32 without an extension: probe PATHEXT extensions first, then the
  // bare name (empty-string suffix). On Win32 with an extension, or non-Win32:
  // use only the bare name (extensions is already [''] on non-Win32).
  const effectiveExtensions =
    process.platform === "win32" && extname(command).length === 0
      ? [...extensions, ""]
      : [""];

  for (const dir of pathEntries) {
    for (const ext of effectiveExtensions) {
      yield resolve(dir, `${command}${ext}`);
    }
  }

  yield join(root, command);
}

function isUnusableLaunch(result: Awaited<ReturnType<typeof runTrackedAsync>>): boolean {
  if (!result.error || result.signal || (result.status !== null && result.status >= 0)) return false;
  const code = (result.error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ENOEXEC") return true;
  if (process.platform !== "win32") return false;
  // A Windows invalid image can throw synchronously as "spawn UNKNOWN";
  // the owned-Job helper preserves the message under its EOWNERSHIP code.
  return code === "UNKNOWN"
    || (code === "EOWNERSHIP" && /^spawn (?:ENOENT|ENOTDIR|EACCES|ENOEXEC|UNKNOWN)$/u.test(result.error.message));
}

// The single fold-child deadline lives at the shared exec boundary
// (`TRACKED_CHILD_DEADLINE_MS`): these spawns run inside the artifact-tree
// lock's hold, and a child that never exits must not be able to hang the fold.

/**
 * Run the first resolvable, ADMITTED candidate. Admission is the shared
 * decline-first veto ({@link admitLocalSpawn}): a recorded operator `declined`
 * for this tool id refuses the spawn OUTRIGHT — the remaining candidates are
 * still walked (a decline names ONE tool, not every formatter), so `prettier`
 * being declined does not silently route formatting to `black`. The returned
 * record carries `declinedReason` when a candidate was refused for that reason.
 *
 * Spawns go through the SHARED exec boundary (`runTrackedAsync`): argv-only,
 * the control-env scrub applied, windowsHide forced — never a direct
 * `node:child_process` call with the unscrubbed parent environment. The ASYNC
 * twin, not `runTracked`: these children run inside the artifact-tree lock's
 * hold, and a synchronous spawn blocks the event loop, which starves every
 * `setInterval` heartbeat in the process — the held lock's mtime beat included,
 * so a long child let another process classify a LIVE lock stale and steal it
 * mid-flight (the incident `runTrackedAsync`'s own doc records).
 */
export async function runFirstAvailableCommand(
  root: string,
  candidates: LocalCommandCandidate[],
  options: { analyzerConsent?: AnalyzerConsentDecisions } = {},
): Promise<LocalCommandResult | null> {
  let lastDecline: string | undefined;
  for (const candidate of candidates) {
    // Decline-first admission, BEFORE resolution and before anything spawns. A
    // recorded refusal is a veto for THIS tool wherever its executable resolves
    // from — including the repo-local `node <script>` arm (the script is the
    // key, never `node`). It runs ahead of resolution because whether the binary
    // happens to be INSTALLED says nothing about whether the operator refused
    // it: resolving first meant an absent tool reported `not_resolved` and the
    // recorded decline was never consulted, so one policy read two ways on two
    // machines.
    const denied = admitLocalSpawn(
      [candidate.command, ...candidate.args],
      options.analyzerConsent,
      candidate.toolId,
    );
    if (denied) {
      lastDecline = denied;
      continue;
    }

    for (const command of resolveCommandPaths(root, candidate.command)) {
      if (!isUsableFile(command, constants.X_OK)) continue;

      const resolved = { ...candidate, command };
      const spawnTarget = toSpawnTuple(resolved);
      const result = await runTrackedAsync(
        [spawnTarget.command, ...spawnTarget.args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: TRACKED_CHILD_DEADLINE_MS,
        },
      );

      // A file can disappear or fail to load after the probe. Only fall
      // through on a known launch error, not a tool exit or runner failure.
      if (isUnusableLaunch(result)) continue;
      return {
        candidate: {
          ...resolved,
          display:
            candidate.display ?? [candidate.command, ...candidate.args].join(" "),
        },
        exitCode: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error
          ? new Error(result.error.message, { cause: result.error })
          : undefined,
      };
    }
  }

  return lastDecline
    ? {
        candidate: {
          command: "",
          args: [],
          display: "(all candidates declined or unresolved)",
        },
        exitCode: null,
        stdout: "",
        stderr: "",
        declinedReason: lastDecline,
      }
    : null;
}

export function resolveNodeTool(
  root: string,
  relativePath: string,
  args: string[],
  display: string,
): LocalCommandCandidate[] {
  const localToolPath = join(root, relativePath);
  const candidates: LocalCommandCandidate[] = [];
  if (isUsableFile(localToolPath, constants.R_OK)) {
    candidates.push({
      command: process.execPath,
      args: [localToolPath, ...args],
      display,
    });
  }
  return candidates;
}
