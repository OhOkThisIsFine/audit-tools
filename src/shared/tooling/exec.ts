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
}

const SHELL_SHIM_COMMANDS = new Set(["npm", "npx", "pnpm", "yarn"]);

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
 * rendered as one string (e.g. a subprocess-template entry): `cmd.exe`
 * double-quote doubling on Windows, POSIX single-quote escaping elsewhere.
 * Shared by the subprocess-template provider in both orchestrators.
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
 * Strip `CLAUDECODE` and any key matching `/^CLAUDE_CODE/` from an env object.
 * Always operates on an explicit copy so the original is never mutated.
 * When `base` is undefined, falls back to `process.env`.
 */
export function stripClaudeCodeEnv(
  base?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const src = base ?? process.env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "CLAUDECODE" || /^CLAUDE_CODE/u.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Run a command synchronously. argv[0] is the command, the rest are args. */
export function runTracked(
  argv: string[],
  options: RunTrackedOptions = {},
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
    env: stripClaudeCodeEnv(options.env),
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
  };
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
