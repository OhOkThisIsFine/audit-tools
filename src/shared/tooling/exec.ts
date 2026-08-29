import { spawn, spawnSync, type StdioOptions } from "node:child_process";

// Single synchronous command runner shared by both orchestrators. Before
// Phase 0 the remediator (`utils/commands.ts`) and the auditor
// (`orchestrator/localCommands.ts`) each carried their own copy of the
// Windows `.cmd`/`.bat` wrapping and quoting logic. `runTracked` is the one
// implementation: argv-only (never `shell: true`), and it reports the argv it
// actually executed for run-log tracing.

export interface RunTrackedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeout?: number;
  input?: string;
  maxBuffer?: number;
  windowsHide?: boolean;
  stdio?: StdioOptions;
  /** Override the platform; for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Options for the SYNC twin. `timeout` is REQUIRED, not optional: a
 * synchronous child blocks the event loop for its whole run, which starves
 * every `setInterval` heartbeat in the process — a held file lock's mtime beat
 * included — so an unbounded sync child lets another process classify a LIVE
 * lock stale and steal it (INV-SSF). The type makes the bound a declared
 * choice at every call site; a long out-of-hold run declares a long bound.
 * Note the bound is per spawn: sequential sync spawns inside one synchronous
 * stretch SUM against the 30s stale window, so fold-reachable work belongs on
 * {@link runTrackedAsync} regardless (`tests/shared/sync-spawn-fold-safety.test.ts`).
 */
export type RunTrackedSyncOptions = RunTrackedOptions & { timeout: number };

export interface RunTrackedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The argv actually spawned, after platform wrapping. */
  argv: string[];
  /** The cwd passed to runTracked, if any. undefined means the command inherited the process CWD. */
  cwd?: string;
  /** Elapsed wall-clock time in milliseconds for the spawned command. */
  duration_ms: number;
  error?: Error;
  /**
   * The signal that killed the child, or `null` when it exited on its own.
   *
   * Reported, never DISCRIMINATED on by callers that need to know WHY a child
   * died: a deadline miss, a `maxBuffer` overflow and an external `kill` all
   * set it. The `error.code` (`ETIMEDOUT` / `ENOBUFS`) is what separates those
   * three; `signal` is the residue that names an external kill once they are
   * ruled out.
   */
  signal?: string | null;
}

const SHELL_SHIM_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn"]);

/**
 * How long {@link runTrackedAsync} waits after SIGTERM before escalating to an
 * unignorable SIGKILL for a child it killed on its own deadline/overflow bound.
 * Long enough for an ordinary child to flush and exit, short enough that a
 * child which ignores SIGTERM cannot hang the awaiting caller.
 */
const KILL_ESCALATION_GRACE_MS = 2_000;

/**
 * Deadline for one fold-reachable tracked child. These spawns run inside the
 * artifact-tree lock's hold (or the remediation state lock's), always through
 * {@link runTrackedAsync} — the async twin keeps the event loop turning, so the
 * held lock's mtime heartbeat beats through the child's whole run and the
 * deadline may safely exceed the 30s stale-lock window. The bound exists so a
 * child that never exits cannot hang the fold: the miss is classified
 * `ETIMEDOUT` and SIGTERM escalates to SIGKILL, so the deadline is terminal.
 * Matches the artifact-tree waiter window (`ARTIFACT_TREE_LOCK_TIMEOUT_MS`).
 */
export const TRACKED_CHILD_DEADLINE_MS = 120_000;

// --- cmd.exe quoting helpers ---
//
// There are two distinct contexts in which a token must be quoted for cmd.exe,
// and the correct quoting strategy differs between them:
//
//   • `quoteForCmd`          — for `wrapForWindowsBatch`: each argv token is
//     embedded into the single-string argument passed to `cmd.exe /d /s /c`.
//     This doc used to claim cmd.exe's own *argv parser* alone processed the
//     resulting quoted string, so quote-doubling (`"` → `""`) was "enough".
//     That claim was the exact premise behind CVE-2024-27980 (Node.js
//     improper neutralization of argv when spawning a `.bat`/`.cmd` on
//     Windows): CreateProcess can't launch a batch file directly, so Windows
//     routes it through `cmd.exe`, and cmd.exe scans the *entire* `/c` line
//     for its own metacharacters (`& | < > ^`) as a command-line
//     interpreter — a scan that runs *before* any argv-parser and is NOT
//     blocked by a token's surrounding double quotes. So both layers apply:
//     quote-doubling for the eventual argv split the child sees, *and*
//     caret-escaping the metacharacters so cmd.exe's own line scan can't
//     reinterpret them as `&&`/`|`/redirection/etc. `%` is a separate,
//     effectively unsolved case — see the function doc.
//     Use this when constructing the argv array for `wrapForWindowsBatch`.
//
//   • `quoteForShellInterpreterCmd` — for the opencode launcher
//     (`resolveOpenCodeSpawnCommand`): tokens are embedded into a full
//     command-line *string* that `cmd.exe /c` interprets as a shell command.
//     In this context the cmd.exe *command interpreter* sees metacharacters
//     (`^&|<>%"`) before any argv parser, so caret-escaping them is the correct
//     strategy.  Use this when building the inline string argument for any
//     `cmd.exe /c "<full-command-string>"`. Verified while hardening
//     `quoteForCmd` above: this helper already wraps-then-caret-escapes
//     `" ^ & | < > %` together (including `%`), which is the standard
//     shell-interpreter-string mitigation — it is a different threat model
//     from `quoteForCmd`'s argv-emulation path (the caller here already wants
//     full shell semantics for the rendered string), so it needed no change.
//
// Do NOT mix them up: `quoteForShellInterpreterCmd` is not a substitute for
// `quoteForCmd` in the batch-wrapping path, and vice versa.

// cmd.exe metacharacters that its own line-scan (not the eventual child's
// argv parser) recognizes even inside a double-quoted region, for the
// `quoteForCmd` / `wrapForWindowsBatch` argv-emulation context. `%` is
// deliberately excluded — see `quoteForCmd`'s doc for why it is rejected
// instead of escaped.
const CMD_ARGV_METACHARS = /[&|<>^]/u;

/**
 * Quote a single argv token for embedding into the `cmd.exe /d /s /c "..."`
 * command line used by `wrapForWindowsBatch`.
 *
 * Two layers of neutralization apply — both are required; this is the
 * CVE-2024-27980 lesson (see the block comment above):
 *
 *  1. **argv-parser layer**: wrap the token in double-quotes and double any
 *     embedded `"` — this is what makes the eventual `.cmd`/`.bat` process
 *     see the intended single argv value (doubled double-quotes are a
 *     literal `"` under that parser's rules).
 *  2. **cmd.exe line-scan layer**: caret-escape `& | < > ^` wherever they
 *     appear (even inside the double-quoted region from step 1) — cmd.exe
 *     applies its own metacharacter scan to the *entire* `/d /s /c` line
 *     before the argv-parser layer ever runs, and quotes do not block that
 *     scan (the root cause of CVE-2024-27980).
 *
 * `%` cannot be neutralized this way: cmd.exe's percent-expansion of
 * `%VAR%` runs at yet another stage that caret-escaping does not reliably
 * suppress across cmd.exe's quirky invocation-shape-dependent rules (a
 * documented residual gap in Node core's own upstream fix for the same CVE
 * class). Rather than emit an escape that looks safe but can still be
 * defeated, this throws a clear error for any argument containing `%`
 * destined for a `.cmd`/`.bat` shim — callers must avoid routing a raw `%`
 * through this path (e.g. resolve/expand it before calling, or avoid the
 * shim).
 *
 * **Do not use this for shell-interpreter command strings.**  For that context
 * (where the entire command is a shell string interpreted by cmd.exe before any
 * argv parser runs), use `quoteForShellInterpreterCmd` instead.
 */
export function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (arg.includes("%")) {
    throw new Error(
      `quoteForCmd: refusing to quote an argument containing "%" for a ` +
        `.cmd/.bat shim invocation through cmd.exe — cmd.exe's ` +
        `percent-expansion cannot be reliably neutralized by caret-escaping ` +
        `(see CVE-2024-27980 and its documented residual gap). Argument: ` +
        `${JSON.stringify(arg)}`,
    );
  }
  const needsQuoting = /[\s"]/u.test(arg);
  const needsMetaEscape = CMD_ARGV_METACHARS.test(arg);
  if (!needsQuoting && !needsMetaEscape) return arg;
  const quoted = needsQuoting ? `"${arg.replace(/"/g, '""')}"` : arg;
  return needsMetaEscape ? quoted.replace(/([&|<>^])/g, "^$1") : quoted;
}

/**
 * Quote a single argv token for embedding inside a shell command line that is
 * rendered as one string: `cmd.exe`
 * double-quote doubling on Windows, POSIX single-quote escaping elsewhere.
 * Shared by command-rendering consumers in both orchestrators.
 */
export function shellQuote(
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return quoteForCmd(arg);
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function isPromptPathToken(value: string): boolean {
  return (
    /^[A-Za-z]:\\/u.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/u.test(value) ||
    /^\.{1,2}\\/u.test(value) ||
    (value.includes("\\") && /(?:^|\\)[^\\]+\.[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value))
  );
}

export function toPromptPathToken(value: string): string {
  return isPromptPathToken(value) ? value.replace(/\\/g, "/") : value;
}

// Tokens matching this charset need no quoting in any of the three dialects
// `renderPromptCommand` targets (posix sh, PowerShell, cmd.exe). Anything
// outside it — spaces, quotes, and shell metacharacters such as `& | < > ^ %
// ; $ ( ) { } * ? ! ~` — is quoted rather than special-cased per dialect: a
// host-facing rendered command string has no single "current shell" to tailor
// escaping to, so the conservative allowlist-then-quote approach is the one
// that can't silently miss a metacharacter for whichever reader executes it.
const PROMPT_COMMAND_SAFE_CHARS = /^[A-Za-z0-9_\-./:\\=@,+]*$/u;

/**
 * Quote a single argv token for a *rendered command line* that this tool
 * hands a host agent to run verbatim — the host may paste it into posix sh,
 * PowerShell, or cmd.exe, and this function does not know which. Double
 * quotes protect a token containing a space or shell metacharacter in all
 * three dialects, provided embedded double quotes are escaped, so: quote
 * whenever any character falls outside `PROMPT_COMMAND_SAFE_CHARS`, escaping
 * embedded `"` as `\"`.
 *
 * Target: safe to paste into posix sh, PowerShell, and cmd.
 */
export function quotePromptCommandArg(value: string): string {
  return PROMPT_COMMAND_SAFE_CHARS.test(value)
    ? value
    : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Render an argv array into a single command-line string safe to paste into
 * posix sh, PowerShell, or cmd.exe — for step prompts and `allowed_commands`
 * a host agent is told to run verbatim, never for actually spawning a
 * process (that path is `runTracked`/`resolveExecArgv`, argv-only).
 * Normalizes path-like Windows tokens to forward slashes first
 * (`toPromptPathToken`) since `\` is an escape character in some of those
 * dialects, then quotes each token per `quotePromptCommandArg`.
 */
export function renderPromptCommand(argv: readonly string[]): string {
  return argv.map((item) => quotePromptCommandArg(toPromptPathToken(item))).join(" ");
}

export function coerceJsonObjectArg<T extends Record<string, unknown>>(
  value: T | string | undefined,
  label: string,
): T {
  if (value === undefined) return {} as T;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TypeError(`${label} must be an object or JSON object string: ${message}`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must be an object or JSON object string.`);
  }
  return parsed as T;
}

/**
 * On Windows, package-manager shims (`npm`/`npx`/`pnpm`/`yarn`) are `.cmd`
 * batch files that `spawn` cannot launch without a shell. Map them to their
 * `.cmd` form so the batch-wrapping path below applies. Anything already
 * carrying an executable extension is returned unchanged.
 */
export function platformCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return command;
  if (/\.(?:cmd|bat|com|exe)$/iu.test(command)) return command;
  if (SHELL_SHIM_COMMANDS.has(command)) return `${command}.cmd`;
  return command;
}

function isWindowsBatch(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/iu.test(command);
}

function wrapForWindowsBatch(
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (!isWindowsBatch(command, platform)) return { command, args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

/**
 * Quote a single argv token for embedding in a full command-line *string*
 * that `cmd.exe /c` will interpret as a shell command.
 *
 * **Context:** this is the *shell-interpreter* quoting context — the entire
 * command is one string seen by `cmd.exe` before any argv parser runs.  In
 * this context metacharacters (`^&|<>%"`) must be caret-escaped.  Safe
 * single-token characters pass through unquoted.
 *
 * **Do not confuse with `quoteForCmd`**, which is the *argv-parser* context
 * used by `wrapForWindowsBatch`.  The difference:
 *
 * - `quoteForCmd` (argv-parser): wraps in double-quotes and doubles internal
 *   `"` → `""`.  Used in `cmd.exe /d /s /c "prog arg"` where cmd.exe's own
 *   argv parser processes the quoted string.
 *
 * - `quoteForShellInterpreterCmd` (shell-interpreter): caret-escapes
 *   metacharacters.  Used when building an inline shell command string passed
 *   to `cmd.exe /c`, e.g. the opencode launcher's `cmd.exe /c "<command…>"`.
 *
 * Canonical owner of this charset — the opencode launcher
 * (`resolveOpenCodeSpawnCommand`) imports it instead of carrying its own copy.
 */
export function quoteForShellInterpreterCmd(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

/**
 * Resolve a logical argv into the concrete `[command, ...args]` that should be
 * spawned on this platform, applying package-manager shim mapping and Windows
 * batch wrapping. Exposed for callers that spawn asynchronously and only need
 * the resolved argv.
 */
export function resolveExecArgv(
  argv: string[],
  options: { platform?: NodeJS.Platform } = {},
): string[] {
  if (argv.length === 0) return [];
  const platform = options.platform ?? process.platform;
  const command = platformCommand(argv[0], platform);
  const args = argv.slice(1);
  const wrapped = wrapForWindowsBatch(command, args, platform);
  return [wrapped.command, ...wrapped.args];
}

function toText(value: string | Buffer | null | undefined): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.toString();
}

/**
 * Strip audit-tools' wrapper-only control variables from a child environment.
 * Always operates on an explicit copy so the original is never mutated. When
 * `base` is undefined, falls back to `process.env`.
 */
export function stripAuditToolsControlEnv(
  base?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const src = base ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    // The wrapper-propagated caller-cwd stamp (node-worktree guard) is scoped
    // to one wrapper→CLI hop. A child inheriting the caller's stamp would read
    // the parent's location as its own and bypass the guard.
    if (k === "AUDIT_TOOLS_CALLER_CWD") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Run a command synchronously. argv[0] is the command, the rest are args.
 * The deadline is required — see {@link RunTrackedSyncOptions}.
 */
export function runTracked(
  argv: string[],
  options: RunTrackedSyncOptions,
): RunTrackedResult {
  if (argv.length === 0) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      argv: [],
      cwd: options.cwd,
      duration_ms: 0,
      error: new Error("runTracked requires a non-empty argv"),
    };
  }
  const resolved = resolveExecArgv(argv, {
    platform: options.platform,
  });
  const start = Date.now();
  const result = spawnSync(resolved[0], resolved.slice(1), {
    cwd: options.cwd,
    env: stripAuditToolsControlEnv(options.env),
    encoding: options.encoding ?? "utf8",
    timeout: options.timeout,
    input: options.input,
    maxBuffer: options.maxBuffer,
    windowsHide: options.windowsHide ?? true,
    stdio: options.stdio,
    shell: false,
  });
  return {
    status: result.status,
    stdout: toText(result.stdout),
    stderr: toText(result.stderr),
    argv: resolved,
    cwd: options.cwd,
    duration_ms: Date.now() - start,
    error: result.error,
    signal: result.signal ?? null,
  };
}

/**
 * Async twin of {@link runTracked}: same argv resolution, control-env scrub, and
 * result shape, driven by {@link spawnHidden} instead of `spawnSync`. Analyzer
 * acquisition runs HERE rather than on the synchronous runner because a
 * synchronous child blocks the event loop for the whole spawn — which starves
 * every `setInterval` liveness heartbeat in the process (the advance
 * heartbeat, and each held file lock's mtime heartbeat), so one stalled
 * `npx --version` probe classified a LIVE lock stale and stole it mid-flight.
 * Awaited by the acquisition engine, the binary resolver, and every closing /
 * required-test spawn; never mixed with {@link runTracked} in one call path.
 *
 * DEADLINE AND OVERFLOW ARE CLASSIFIED, not left as a bare signal. `spawnSync`
 * reports an over-deadline child as `ETIMEDOUT` and an over-`maxBuffer` child
 * as `ENOBUFS`, and callers discriminate on those codes precisely because
 * `signal` conflates them with an external `kill`. Node's own `timeout` option
 * on the async path would surface both as an ordinary SIGTERM close and throw
 * that distinction away, so this runner enforces BOTH bounds itself and stamps
 * the same two codes — one classification serves both twins, and the bounds
 * themselves are measured the same way (`maxBuffer` PER STREAM, as `spawnSync`
 * measures it) so the two twins cannot disagree about which children overflow.
 */
export async function runTrackedAsync(
  argv: string[],
  options: RunTrackedOptions = {},
): Promise<RunTrackedResult> {
  if (argv.length === 0) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      argv: [],
      cwd: options.cwd,
      duration_ms: 0,
      error: new Error("runTrackedAsync requires a non-empty argv"),
    };
  }
  const resolved = resolveExecArgv(argv, {
    platform: options.platform,
  });
  const start = Date.now();
  return await new Promise<RunTrackedResult>((resolve) => {
    const child = spawnHidden(resolved[0], resolved.slice(1), {
      cwd: options.cwd,
      env: stripAuditToolsControlEnv(options.env),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // Bytes SEEN on each pipe, which is not the same as bytes kept: the counters
    // keep rising after MAX_CAPTURE stops appending. See `capture`.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    // Which bound killed the child, when one did. Read on `close` to stamp the
    // matching `spawnSync` error code.
    let killedBy: "timeout" | "overflow" | null = null;
    // Bounded: a hostile/oversized emitter cannot grow the heap without limit.
    // An explicit `maxBuffer` is the caller's stricter bound and is REPORTED as
    // an overflow; the 10MiB default is the silent backstop. A caller that
    // DECLARES a larger `maxBuffer` raises the capture bound with it — the
    // sync twin returns everything under the declared bound, and a 10MiB
    // capture ceiling under a 256MiB declaration would silently truncate a
    // legitimate large output (a big repo's `git ls-files -z`) with exit 0,
    // which corrupts the caller where a refusal would have degraded cleanly.
    const MAX_CAPTURE = Math.max(10 * 1024 * 1024, options.maxBuffer ?? 0);
    const overflowLimit = options.maxBuffer;

    let killTimer: NodeJS.Timeout | null = null;
    /**
     * Terminate the child for a bound this runner owns, and make the
     * termination ACTUALLY terminal.
     *
     * `child.kill()` sends SIGTERM, which is a request: a child that installs a
     * handler and ignores it never emits `close`, so the promise would never
     * settle and the deadline this runner advertises would be a deadline in
     * name only (`spawnSync`'s `timeout` had no such hole — it kills from the
     * runtime). So the SIGTERM is followed by an unignorable SIGKILL after a
     * short grace period. The timer is `unref`d so a settled call never holds
     * the event loop open.
     */
    const killForBound = (): void => {
      child.kill();
      if (killTimer) return;
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_ESCALATION_GRACE_MS);
      killTimer.unref?.();
    };

    const timer =
      options.timeout !== undefined && options.timeout > 0
        ? setTimeout(() => {
            killedBy = "timeout";
            killForBound();
          }, options.timeout)
        : null;
    const finish = (result: RunTrackedResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    /**
     * Accumulate one chunk and enforce the overflow bound.
     *
     * The bound is checked PER STREAM and against bytes SEEN, not against what
     * was kept — both deliberate:
     *
     *  - per stream, because `spawnSync`'s `maxBuffer`, which the sync twin
     *    {@link runTracked} still enforces, is per stream. A combined bound
     *    would classify a child emitting 5MiB on each pipe under an 8MiB limit
     *    as an overflow that the sync twin admits verbatim, and this module's
     *    claim that one classification serves both twins would be false.
     *  - against bytes seen, because the MAX_CAPTURE backstop stops APPENDING
     *    (at 10MiB when no `maxBuffer` was declared; a declared `maxBuffer`
     *    raises the capture bound with it). Counting kept characters instead
     *    would under-count once appending stops — the output would silently
     *    truncate where the contract says it refuses.
     */
    const capture = (
      chunk: Buffer,
      append: (text: string) => void,
      seen: () => number,
      kept: () => number,
    ): void => {
      if (kept() < MAX_CAPTURE) {
        append(chunk.toString(options.encoding ?? "utf8"));
      }
      if (
        overflowLimit !== undefined &&
        seen() > overflowLimit &&
        killedBy === null
      ) {
        killedBy = "overflow";
        killForBound();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      capture(
        chunk,
        (text) => {
          stdout += text;
        },
        () => stdoutBytes,
        () => stdout.length,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      capture(
        chunk,
        (text) => {
          stderr += text;
        },
        () => stderrBytes,
        () => stderr.length,
      );
    });
    // stdin is CLOSED (optionally after `input`), never left open: a command
    // that reads stdin would otherwise block forever on a pipe nothing writes,
    // turning an ordinary test invocation into a hang.
    //
    // The stream error is SWALLOWED, deliberately: a child that exits before
    // (or while) `input` is written — `git check-ignore --stdin` in a non-repo
    // exits 128 without reading — raises EPIPE on the stdin stream, and an
    // unhandled stream 'error' event crashes the whole process (observed as a
    // worker-killing `write EPIPE` cascade on Linux CI; Windows pipe buffering
    // masks it). The child's own exit code / spawn error on the `close` path
    // is the real outcome and reports the failure.
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();

    child.on("error", (error) => {
      finish({
        status: null,
        stdout,
        stderr,
        argv: resolved,
        cwd: options.cwd,
        duration_ms: Date.now() - start,
        error,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      let error: Error | undefined;
      if (killedBy !== null) {
        const bound: NodeJS.ErrnoException = new Error(
          killedBy === "timeout"
            ? `child exceeded the ${String(options.timeout)}ms deadline`
            : `child exceeded the ${String(overflowLimit)}-byte output bound`,
        );
        bound.code = killedBy === "timeout" ? "ETIMEDOUT" : "ENOBUFS";
        error = bound;
      } else if (signal !== null && signal !== undefined) {
        error = new Error(`child terminated by signal ${signal}`);
      }
      finish({
        status: code,
        stdout,
        stderr,
        argv: resolved,
        cwd: options.cwd,
        duration_ms: Date.now() - start,
        ...(error ? { error } : {}),
        signal: signal ?? null,
      });
    });
  });
}

/**
 * `child_process.spawnSync` with `windowsHide` forced on. A windowless parent
 * (node launched by an IDE/agent) spawning a console child (git, sqlite3, …) pops
 * a console window on win32 unless suppressed — the many direct git spawns across
 * the remediate git-worktree machinery would otherwise each flash one. Thin
 * passthrough otherwise; callers keep their exact args/options and, via the
 * `typeof spawnSync` cast, its full encoding-based overloads (so `.stdout` stays
 * `string` under `{ encoding: "utf8" }`). `windowsHide` is forced last so it
 * always wins (no caller wants a visible window).
 */
export const spawnSyncHidden = ((
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof spawnSync>[2],
) =>
  spawnSync(command, args as string[], {
    ...(options ?? {}),
    windowsHide: true,
  })) as typeof spawnSync;

/**
 * Async twin of {@link spawnSyncHidden}: `child_process.spawn` with `windowsHide`
 * forced on. Same rationale — a windowless parent (node under an IDE/agent)
 * spawning a console child pops a console window on win32 unless suppressed. Thin
 * passthrough otherwise; callers keep their exact args/options and, via the
 * `typeof spawn` cast, its full overload set. `windowsHide` is forced last so it
 * always wins (no caller wants a visible window).
 */
export const spawnHidden = ((
  command: string,
  args?: readonly string[],
  options?: Parameters<typeof spawn>[2],
) =>
  spawn(command, args as string[], {
    ...(options ?? {}),
    windowsHide: true,
  })) as typeof spawn;
