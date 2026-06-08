import { spawnSync, type StdioOptions } from "node:child_process";

// Single synchronous command runner shared by both orchestrators. Before
// Phase 0 the remediator (`utils/commands.ts`) and the auditor
// (`orchestrator/localCommands.ts`) each carried their own copy of the
// Windows `.cmd`/`.bat` wrapping and quoting logic. `runTracked` is the one
// implementation: argv-only (never `shell: true`), with optional `opentoken`
// wrapping, and it reports the argv it actually executed for run-log tracing.

export interface RunTrackedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeout?: number;
  input?: string;
  maxBuffer?: number;
  windowsHide?: boolean;
  stdio?: StdioOptions;
  /**
   * Wrap the command as `<opentoken> wrap <argv>`. Pass the opentoken binary
   * name or path. When unset, no wrapping is applied.
   */
  opentoken?: string;
  /** Override the platform; for tests. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface RunTrackedResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The argv actually spawned, after platform/opentoken wrapping. */
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
//     In this context cmd.exe's own *argv parser* processes the resulting
//     quoted string, so doubling double-quotes (`"` → `""`) is correct.
//     Use this when constructing the argv array for `wrapForWindowsBatch`.
//
//   • `quoteForOpenTokenCmd` — for `wrapForOpenToken`: tokens are embedded
//     into a full command-line *string* that `cmd.exe /c` interprets as a
//     shell command (e.g. `opentoken wrap <argv…>`).  In this context the
//     cmd.exe *command interpreter* sees metacharacters (`^&|<>%"`) before
//     any argv parser, so caret-escaping them is the correct strategy.
//     Use this when building the inline string argument for `wrapForOpenToken`
//     or any other `cmd.exe /c "<full-command-string>"` invocation.
//
// Do NOT mix them up: `quoteForOpenTokenCmd` is not a substitute for
// `quoteForCmd` in the batch-wrapping path, and vice versa.

/**
 * Quote a single argv token for embedding into the `cmd.exe /d /s /c "..."`
 * command line used by `wrapForWindowsBatch`.
 *
 * In this context cmd.exe's own argv parser processes the resulting quoted
 * string, which treats doubled double-quotes as a literal `"` — so the
 * correct strategy is to wrap the token in double-quotes and replace every
 * internal `"` with `""`.
 *
 * **Do not use this for the opentoken wrap path.**  For that context (where
 * the entire command is a shell string interpreted by cmd.exe before any argv
 * parser runs), use `quoteForOpenTokenCmd` instead.
 */
export function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
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

export function quotePromptCommandArg(value: string): string {
  return /[\s"]/u.test(value)
    ? `"${value.replace(/"/g, '\\"')}"`
    : value;
}

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
 * that `cmd.exe /c` will interpret as a shell command — i.e. the
 * `opentoken wrap <argv…>` invocation assembled in `wrapForOpenToken`.
 *
 * In this context the cmd.exe *command interpreter* sees metacharacters
 * (`^&|<>%"`) before any argv parser, so the correct strategy is to
 * caret-escape those characters (e.g. `"` → `^"`, `&` → `^&`).  Safe
 * single-token characters pass through unquoted.
 *
 * Canonical owner of this charset — both `spawnLoggedCommand` and the
 * opencode launcher import it instead of carrying their own copy.
 *
 * **Do not use this as a substitute for `quoteForCmd` in the standard
 * batch-wrapping path (`wrapForWindowsBatch`).** That path expects argv-parser
 * quoting (doubled double-quotes), not shell-interpreter caret-escaping.
 */
export function quoteForOpenTokenCmd(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) return value;
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

/**
 * Wrap `[command, ...args]` as an `<opentoken> wrap …` invocation. On Windows
 * the wrap goes through `cmd.exe /d /s /c` with each token quoted via
 * `quoteForOpenTokenCmd`; on every other platform opentoken is spawned argv-only.
 * Single source of truth for the opentoken wrapping both orchestrators use.
 */
export function wrapForOpenToken(
  command: string,
  args: string[],
  opentoken: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    const inner = [command, ...args].map(quoteForOpenTokenCmd).join(" ");
    return { command: shell, args: ["/d", "/s", "/c", `${opentoken} wrap ${inner}`] };
  }
  return { command: opentoken, args: ["wrap", command, ...args] };
}

/**
 * Resolve a logical argv into the concrete `[command, ...args]` that should be
 * spawned on this platform, applying package-manager shim mapping, optional
 * opentoken wrapping, and Windows batch wrapping. Exposed for callers that
 * spawn asynchronously and only need the resolved argv.
 */
export function resolveExecArgv(
  argv: string[],
  options: { opentoken?: string; platform?: NodeJS.Platform } = {},
): string[] {
  if (argv.length === 0) return [];
  const platform = options.platform ?? process.platform;
  const command = platformCommand(argv[0], platform);
  const args = argv.slice(1);
  if (options.opentoken) {
    const wrapped = wrapForOpenToken(command, args, options.opentoken, platform);
    return [wrapped.command, ...wrapped.args];
  }
  const wrapped = wrapForWindowsBatch(command, args, platform);
  return [wrapped.command, ...wrapped.args];
}

function toText(value: string | Buffer | null | undefined): string {
  if (value == null) return "";
  return typeof value === "string" ? value : value.toString();
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
    opentoken: options.opentoken,
    platform: options.platform,
  });
  const start = Date.now();
  const result = spawnSync(resolved[0], resolved.slice(1), {
    cwd: options.cwd,
    env: options.env,
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
