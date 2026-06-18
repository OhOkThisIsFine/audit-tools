/**
 * Allowlisted read-only command runner + a DEFAULT-DENY per-executable flag
 * allowlist — single source for both orchestrators (drift-plan E2; CRIT
 * ARC-a06a3945).
 *
 * The auditor's executable-anchor pass (S7 tier-2) runs *model-authored* commands
 * at ingest to confirm/refute behavior claims. That is a trust surface: the tool
 * spawns whatever the model wrote. The earlier guard checked only `command[0]`
 * (the executable) against an allowlist and waved every argument through, so
 * `rg --pre <cmd>` (preprocessor exec), `rg --search-zip`, `ast-grep --rewrite`
 * (file write), a non-read-only `git` option, etc. slipped past — arbitrary
 * code-exec / file-writes at ingest.
 *
 * This module replaces that denylist posture with a **default-deny allowlist of
 * arguments**: each allowed executable declares the exact set of flags it may
 * carry; ANY flag not on that set refuses the whole command. New dangerous flags
 * are therefore refused by construction (they are simply absent from the set),
 * not by remembering to denylist them. Positionals (search patterns / file
 * paths) are allowed — they name what to inspect, not code to run — with one
 * exception: `git`, whose first positional must be a read-only subcommand.
 *
 * SAFETY of the runner: commands run only via `runAllowlistedReadOnlyCommand`,
 * which spawns argv-only (never a shell), under a timeout, with the
 * host-signalling env stripped (`stripClaudeCodeEnv`), platform-resolved via the
 * shared `resolveExecArgv`, and SIGTERM→SIGKILL on timeout. The caller still
 * gates each command through `isAllowedAnchorCommand` before running it.
 */
import { spawn } from "node:child_process";
import { resolveExecArgv, stripClaudeCodeEnv } from "./exec.js";

/** Default per-anchor wall-clock budget; a slower command is killed and inconclusive. */
export const ALLOWLISTED_EXEC_TIMEOUT_MS = 60_000;

/** Grace before a timed-out child is escalated from SIGTERM to SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

/** Cap on captured combined output so a runaway command cannot exhaust memory. */
const MAX_CAPTURED_OUTPUT = 256 * 1024;

/**
 * Per-executable argument policy. `flags` is the explicit set of permitted flag
 * names (the token up to but excluding any `=value`); a flag not in the set
 * refuses the command. When `allowPositionals` is false, positional (non-flag)
 * args are also refused (used by git, whose positionals are subcommand-checked
 * separately). `windowsSlashFlags` permits Windows-style `/x` switches (findstr).
 */
interface ArgPolicy {
  flags: ReadonlySet<string>;
  allowPositionals: boolean;
  windowsSlashFlags?: boolean;
}

/**
 * The inspection-only executables a model-authored anchor may invoke, each with
 * the explicit set of flags it may carry. Every listed flag is read-only: it
 * cannot write a file, execute a sub-process/preprocessor, or decompress
 * arbitrary input. Deliberately ABSENT (so default-deny refuses them):
 *   - ripgrep:  --pre / --pre-glob (run a preprocessor), --search-zip / -z
 *               (decompress), --hostname-bin, -o is fine (only-matching) but
 *               --files-from style file reads are omitted out of caution.
 *   - ast-grep: --rewrite / -r, --update-all / -U, --interactive / -i (edit),
 *               --json's safe so it stays; `run`/`scan` subcommands are positional.
 *   - grep:     --output is not a real grep flag; -f (pattern file) omitted.
 *   - madge:    --image / -i, --dot, --svg (write output files).
 *   - git:      handled separately — only read-only subcommands, and
 *               --output/-o (writes a file) is refused.
 */
const ARG_POLICIES: ReadonlyMap<string, ArgPolicy> = new Map<string, ArgPolicy>([
  [
    "grep",
    {
      // Read-only search/format switches only.
      flags: new Set([
        "-r", "-R", "--recursive", "-n", "--line-number", "-i",
        "--ignore-case", "-l", "--files-with-matches", "-L",
        "--files-without-match", "-c", "--count", "-o", "--only-matching",
        "-e", "--regexp", "-E", "--extended-regexp", "-F", "--fixed-strings",
        "-w", "--word-regexp", "-x", "--line-regexp", "-v", "--invert-match",
        "-H", "--with-filename", "-h", "--no-filename", "-s", "--no-messages",
        "--include", "--exclude", "--exclude-dir", "-A", "--after-context",
        "-B", "--before-context", "-C", "--context", "--color", "--colour",
        "-a", "--text", "-I",
      ]),
      allowPositionals: true,
    },
  ],
  [
    "rg",
    {
      flags: new Set([
        "-i", "--ignore-case", "-S", "--smart-case", "-s", "--case-sensitive",
        "-n", "--line-number", "-N", "--no-line-number", "-l",
        "--files-with-matches", "--files-without-match", "-c", "--count",
        "--count-matches", "-o", "--only-matching", "-w", "--word-regexp",
        "-x", "--line-regexp", "-v", "--invert-match", "-F", "--fixed-strings",
        "-e", "--regexp", "-A", "--after-context", "-B", "--before-context",
        "-C", "--context", "-g", "--glob", "-t", "--type", "-T", "--type-not",
        "--hidden", "--no-ignore", "--color", "--colors", "-H", "--with-filename",
        "--no-filename", "--no-heading", "--heading", "-U", "--multiline",
        "--multiline-dotall", "-P", "--pcre2", "--json", "--vimgrep", "-0",
        "--null", "-m", "--max-count", "--max-depth", "--maxdepth",
      ]),
      allowPositionals: true,
    },
  ],
  [
    "ripgrep",
    {
      // alias spelling of rg — same read-only switch set.
      flags: new Set([
        "-i", "--ignore-case", "-S", "--smart-case", "-s", "--case-sensitive",
        "-n", "--line-number", "-N", "--no-line-number", "-l",
        "--files-with-matches", "--files-without-match", "-c", "--count",
        "--count-matches", "-o", "--only-matching", "-w", "--word-regexp",
        "-x", "--line-regexp", "-v", "--invert-match", "-F", "--fixed-strings",
        "-e", "--regexp", "-A", "--after-context", "-B", "--before-context",
        "-C", "--context", "-g", "--glob", "-t", "--type", "-T", "--type-not",
        "--hidden", "--no-ignore", "--color", "--colors", "-H", "--with-filename",
        "--no-filename", "--no-heading", "--heading", "-U", "--multiline",
        "--multiline-dotall", "-P", "--pcre2", "--json", "--vimgrep", "-0",
        "--null", "-m", "--max-count", "--max-depth", "--maxdepth",
      ]),
      allowPositionals: true,
    },
  ],
  [
    "findstr",
    {
      // Windows search tool: all switches are `/x`; no flag refuses, positionals
      // (pattern + path) allowed. /s recursive, /i ignore-case, etc. are read-only.
      flags: new Set(),
      allowPositionals: true,
      windowsSlashFlags: true,
    },
  ],
  [
    "madge",
    {
      // Read-only dependency analysis: circular detection, orphans, JSON. The
      // image/dot/svg output-writing flags are absent → refused.
      flags: new Set([
        "--circular", "-c", "--orphans", "--leaves", "--summary", "-s",
        "--json", "--warning", "--no-color", "--extensions", "--exclude",
        "--include-npm", "--depends", "--ts-config", "--webpack-config",
      ]),
      allowPositionals: true,
    },
  ],
  [
    "ast-grep",
    {
      // Structural search only. --rewrite/-r/--update-all/-U/--interactive/-i
      // (all of which edit files) are absent → refused. `run`/`scan` are positional.
      flags: new Set([
        "-p", "--pattern", "-l", "--lang", "--language", "--json", "--globs",
        "-A", "--after", "-B", "--before", "-C", "--context", "--heading",
        "--color", "--no-color", "-h", "--help",
      ]),
      allowPositionals: true,
    },
  ],
  [
    "sg",
    {
      // alias spelling of ast-grep — same read-only flag set.
      flags: new Set([
        "-p", "--pattern", "-l", "--lang", "--language", "--json", "--globs",
        "-A", "--after", "-B", "--before", "-C", "--context", "--heading",
        "--color", "--no-color", "-h", "--help",
      ]),
      allowPositionals: true,
    },
  ],
]);

/** Read-only git subcommands an anchor may run (no checkout/reset/clean/push/…). */
export const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "grep",
  "log",
  "diff",
  "show",
  "ls-files",
  "cat-file",
  "blame",
  "rev-parse",
  "status",
]);

/**
 * git flags that write a file or otherwise escape read-only inspection, refused
 * even on a read-only subcommand. `-o`/`--output` write to a file; `-c`,
 * `--exec-path`, `--config-env` reconfigure git arbitrarily (incl. running
 * pagers/externals). Anything in this set, anywhere in the argv, refuses.
 */
const GIT_REFUSED_OPTIONS: ReadonlySet<string> = new Set([
  "-o",
  "--output",
  "-c",
  "--exec-path",
  "--config-env",
  "--upload-pack",
  "--receive-pack",
]);

/**
 * The set of executables the runner will auto-run, for callers that want to
 * display the allowlist. Derived from the per-executable policies plus git.
 */
export const ANCHOR_ALLOWLIST: ReadonlySet<string> = new Set([
  ...ARG_POLICIES.keys(),
  "git",
]);

/** Bare executable name: strip any directory and a Windows .cmd/.bat/.exe suffix. */
export function executableBaseName(token: string): string {
  return token
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.(cmd|bat|exe)$/i, "")
    .toLowerCase();
}

/** A token is a flag when it begins with `-` (POSIX) or, for findstr, `/`. */
function isFlagToken(token: string, windowsSlashFlags: boolean): boolean {
  if (token.startsWith("-")) return true;
  if (windowsSlashFlags && token.startsWith("/")) return true;
  return false;
}

/**
 * The flag name of a token, dropping any `=value`. A clustered short flag with
 * an attached value (e.g. ripgrep `-tjs`) is intentionally NOT decomposed: under
 * default-deny it simply won't match the allow set and the command is refused
 * (skipped, falling back to tier-1) rather than parsed heuristically — the
 * canonical separated form (`-t js`) is allowed, so this loses no real coverage
 * while keeping the matcher unambiguous.
 */
function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Validate a non-git command against its per-executable argument policy. Every
 * flag must be on the policy's allow set (default-deny); positionals are allowed
 * unless the policy forbids them. Returns true only when EVERY token is allowed.
 */
function isAllowedNonGitCommand(base: string, args: string[], policy: ArgPolicy): boolean {
  const windowsSlash = policy.windowsSlashFlags === true;
  for (const arg of args) {
    if (typeof arg !== "string") return false;
    if (isFlagToken(arg, windowsSlash)) {
      // A Windows `/x` switch on findstr is always read-only — accept the family
      // without enumerating every switch.
      if (windowsSlash && arg.startsWith("/")) continue;
      if (!policy.flags.has(flagName(arg))) return false;
    } else if (!policy.allowPositionals) {
      return false;
    }
  }
  return true;
}

/**
 * Validate a git command: the first positional must be a read-only subcommand,
 * and no token (before OR after the subcommand) may be a write/reconfigure
 * option from {@link GIT_REFUSED_OPTIONS}. A `-c key=val` style reconfiguration
 * before the subcommand is refused, as is an `--output=file` on `git log`.
 */
function isAllowedGitCommand(args: string[]): boolean {
  let subcommand: string | undefined;
  for (const arg of args) {
    if (typeof arg !== "string") return false;
    if (GIT_REFUSED_OPTIONS.has(flagName(arg))) return false;
    if (subcommand === undefined && !arg.startsWith("-")) {
      subcommand = arg.trim().toLowerCase();
    }
  }
  if (subcommand === undefined) return false;
  return GIT_READONLY_SUBCOMMANDS.has(subcommand);
}

/**
 * The single authority for what the tool will auto-run on the model's behalf:
 * `command[0]` must be an allowlisted inspection-only executable, AND every
 * argument must satisfy that executable's default-deny argument policy (git:
 * read-only subcommand + no write/reconfigure option). Anything else → false.
 *
 * CRIT ARC-a06a3945: argument validation is the point — an allowed executable
 * carrying a code-exec/file-write flag (`rg --pre`, `ast-grep --rewrite`,
 * `git log -o file`, …) is REFUSED, not run.
 */
export function isAllowedAnchorCommand(command: string[]): boolean {
  const exe = command[0];
  if (typeof exe !== "string" || exe.trim() === "") return false;
  const base = executableBaseName(exe);
  const args = command.slice(1);
  if (base === "git") return isAllowedGitCommand(args);
  const policy = ARG_POLICIES.get(base);
  if (!policy) return false;
  return isAllowedNonGitCommand(base, args, policy);
}

/** Outcome of actually running an allowlisted command (injectable for tests). */
export interface AllowlistedExecOutcome {
  exit_code: number | null;
  timed_out: boolean;
  spawn_error?: string;
  /** Full combined stdout+stderr (bounded), used to evaluate output matches. */
  output: string;
}

export type AllowlistedExecRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<AllowlistedExecOutcome>;

/**
 * Spawn an allowlisted read-only command argv-only (never a shell), capturing
 * combined stdout+stderr (bounded). Strips the host-signalling env
 * (`stripClaudeCodeEnv`), resolves the platform-correct argv via the shared
 * `resolveExecArgv`, and kills a command that exceeds `timeoutMs`
 * (SIGTERM→SIGKILL). The single runner both orchestrators use for the grounding
 * anchor pass.
 *
 * NOTE: this does NOT re-check the allowlist — callers MUST gate the command
 * through {@link isAllowedAnchorCommand} first. It is named/scoped so a future
 * caller cannot reasonably read it as a general-purpose runner.
 */
export const runAllowlistedReadOnlyCommand: AllowlistedExecRunner = (
  command,
  cwd,
  timeoutMs,
) =>
  new Promise((resolvePromise) => {
    const [resolvedCommand, ...resolvedArgs] = resolveExecArgv(command);
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd,
      env: stripClaudeCodeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk: unknown) => {
      if (output.length < MAX_CAPTURED_OUTPUT) output += String(chunk);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
      hardKill.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exit_code: null,
        timed_out: timedOut,
        spawn_error: error.message,
        output,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ exit_code: code, timed_out: timedOut, output });
    });
  });
