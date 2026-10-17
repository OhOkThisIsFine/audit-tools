// sites-pinned: tests/shared/allowlisted-exec.test.ts, tests/shared/allowlisted-exec-runner-internals.test.ts
/**
 * Allowlisted read-only command runner + a DEFAULT-DENY per-executable flag
 * allowlist — single source for both orchestrators (drift-plan E2; CRIT
 * ARC-a06a3945).
 *
 * Exported inspection-command library boundary. There are currently no in-tree
 * production callers. Admission rejects paths and flags outside declared policies;
 * execution resolves a trusted native identity outside the inspected worktree
 * and caller cwd. Git and ripgrep receive fixed configuration protections.
 * Other tools retain their existing argument policies; this is no general
 * sandbox or claim about Madge configuration trust.
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
 * wrapper-only control env stripped (`stripAuditToolsControlEnv`), a trusted
 * native executable identity, and bounded owned-process cleanup. It ENFORCES
 * `isAllowedAnchorCommand` on itself, unconditionally, before ever spawning
 * (invariants[2]) — a caller-side pre-check is only an OPTIONAL fast path,
 * never the sole guarantee: correctness must not rest on every call site
 * remembering to gate first.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { devNull } from "node:os";
import { stripAuditToolsControlEnv } from "./exec.js";
import { resolveExecutableFile } from "./resolveExecutable.js";
import { resolveWithinRoot } from "../io/pathContainment.js";
import { beginOwnedProcessTermination, spawnOwnedProcess, type OwnedProcessCleanup } from "./ownedProcessLifecycle.js";

/** Default per-anchor wall-clock budget; a slower command is killed and inconclusive. */
export const ALLOWLISTED_EXEC_TIMEOUT_MS = 60_000;

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
 * the explicit set of flags it may carry. These historical policies do not
 * establish configuration/subcommand safety for every analyzer: Madge config
 * modules and ast-grep positional subcommands/config discovery remain separate
 * review scopes. Deliberately ABSENT (so default-deny refuses them):
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
        "--null", "-m", "--max-count", "--max-depth", "--maxdepth", "--no-config",
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
        "--null", "-m", "--max-count", "--max-depth", "--maxdepth", "--no-config",
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
      // Dependency-reporting flags; config modules remain a separate trust surface. The
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
      // Known editing flags are absent. Positional subcommands and configuration/
      // native parser discovery remain separate review scopes.
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

type GitValue = (value: string) => boolean;
interface GitPolicy {
  flags: ReadonlyMap<string, GitValue | null>;
  /** Git optional-value long flags must use '=' to avoid consuming a path. */
  equalsOnly?: ReadonlySet<string>;
  paths: boolean;
  positionals: (values: string[], flags: ReadonlySet<string>) => boolean;
}
const nonempty: GitValue = value => value.length > 0 && !value.startsWith("-");
const count: GitValue = value => /^\d+$/.test(value);
const anyPositionals = (): boolean => true;
const gitFlags = (zero: string[], values: Array<[string, GitValue]> = []): ReadonlyMap<string, GitValue | null> =>
  new Map([...zero.map(flag => [flag, null] as const), ...values]);
const diffFlags = ["--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--patch", "-p", "--no-patch", "-s", "--raw", "--check", "--no-renames", "--no-ext-diff", "--no-textconv", "--exit-code", "--quiet", "-w", "--ignore-all-space", "--ignore-space-change", "--no-color"];
const logValues: Array<[string, GitValue]> = [["-n", count], ["--max-count", count], ["--skip", count], ["--since", nonempty], ["--until", nonempty], ["--author", nonempty], ["--grep", nonempty]];
/**
 * Small per-subcommand grammar, not Git's complete CLI. Exact flag names only;
 * null means zero operands, a predicate means one required operand. Required
 * short operands may be attached; long operands may use '='. Short clusters,
 * abbreviations and arbitrary pretty formats are omitted. Optional-value Git
 * flags require an explicit '=' value when included (equalsOnly).
 * '--' ends option parsing only for commands with path positionals.
 */
const GIT_POLICIES: ReadonlyMap<string, GitPolicy> = new Map<string, GitPolicy>([
  ["grep", { flags: gitFlags(["-n", "--line-number", "-i", "--ignore-case", "-I", "-l", "--files-with-matches", "-c", "--count", "-w", "--word-regexp", "-v", "--invert-match", "-E", "--extended-regexp", "-F", "--fixed-strings", "--cached", "--no-index", "--full-name", "--no-textconv"], [["-e", nonempty], ["-A", count], ["-B", count], ["-C", count]]), paths: true, positionals: (values, flags) => flags.has("-e") || values.length > 0 }],
  ["log", { flags: gitFlags([...diffFlags, "--oneline", "--decorate", "--no-decorate", "--all", "--reverse", "--first-parent", "--no-merges", "--merges", "--follow"], [...logValues, ["-U", count]]), paths: true, positionals: anyPositionals }],
  ["diff", { flags: gitFlags(diffFlags, [["-U", count], ["--unified", count]]), paths: true, positionals: anyPositionals }],
  ["show", { flags: gitFlags([...diffFlags, "--oneline"], [["-U", count], ["--unified", count]]), paths: true, positionals: anyPositionals }],
  ["ls-files", { flags: gitFlags(["-z", "--cached", "-c", "--deleted", "-d", "--modified", "-m", "--others", "-o", "--ignored", "-i", "--exclude-standard", "--stage", "-s", "--unmerged", "-u", "--full-name"]), paths: true, positionals: anyPositionals }],
  ["cat-file", { flags: gitFlags(["-p", "-t", "-s", "-e"]), paths: false, positionals: (values, flags) => values.length === 1 && flags.size === 1 }],
  ["blame", { flags: gitFlags(["--porcelain", "--line-porcelain", "--incremental", "-w", "--show-email", "-e", "--root", "--no-textconv"], [["-L", value => /^\d+(?:,\d+)?$/.test(value)]]), paths: true, positionals: values => values.length >= 1 && values.length <= 2 }],
  ["rev-parse", { flags: gitFlags(["--verify", "--short", "--abbrev-ref", "--symbolic-full-name", "--is-inside-work-tree", "--show-toplevel", "--show-prefix", "--git-dir", "--is-bare-repository"]), paths: false, positionals: values => values.length <= 1 }],
  ["status", { flags: gitFlags(["--short", "-s", "--branch", "-b", "--porcelain", "-z", "--no-renames"], [["--untracked-files", value => ["no", "normal", "all"].includes(value)]]), equalsOnly: new Set(["--untracked-files"]), paths: true, positionals: anyPositionals }],
]);

/** Read-only Git subcommands, derived from the grammar used for admission. */
export const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(GIT_POLICIES.keys());

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
function isAllowedNonGitCommand(args: string[], policy: ArgPolicy): boolean {
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

const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "--no-optional-locks", "--literal-pathspecs"]);
function gitSubcommandIndex(args: string[]): number {
  let index = 0;
  while (GIT_GLOBAL_FLAGS.has(args[index]!)) index++;
  return index;
}

/** Default-deny Git grammar; positionals after '--' are never reparsed. */
function isAllowedGitCommand(args: string[]): boolean {
  const sub = gitSubcommandIndex(args);
  const policy = GIT_POLICIES.get(args[sub]!);
  if (!policy) return false;
  const positionals: string[] = [];
  const flags = new Set<string>();
  let pathsOnly = false;
  for (let index = sub + 1; index < args.length; index++) {
    const arg = args[index]!;
    if (pathsOnly || !arg.startsWith("-")) { positionals.push(arg); continue; }
    if (arg === "--") {
      if (!policy.paths) return false;
      pathsOnly = true;
      continue;
    }
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    let name = equals < 0 ? arg : arg.slice(0, equals);
    let value: string | undefined = equals < 0 ? undefined : arg.slice(equals + 1);
    if (!policy.flags.has(name) && /^-[^-].+/.test(arg)) {
      name = arg.slice(0, 2);
      value = arg.slice(2);
    }
    if (!policy.flags.has(name)) return false;
    if (policy.equalsOnly?.has(name) && equals < 0) return false;
    const validate = policy.flags.get(name)!;
    if (validate === null) { if (value !== undefined) return false; }
    else {
      value ??= args[++index];
      if (value === undefined || !validate(value)) return false;
    }
    flags.add(name);
  }
  return policy.positionals(positionals, flags);
}

/**
 * The single authority for what the tool will auto-run on the model's behalf:
 * `command[0]` must be an allowlisted inspection-only executable, AND every
 * argument must satisfy that executable's default-deny argument policy (git:
 * subcommand-specific grammar). Anything else → false.
 *
 * CRIT ARC-a06a3945: argument validation is the point — an allowed executable
 * carrying a code-exec/file-write flag (`rg --pre`, `ast-grep --rewrite`,
 * `git log -o file`, …) is REFUSED, not run.
 */
export function isAllowedAnchorCommand(command: string[]): boolean {
  const exe = command[0];
  if (typeof exe !== "string" || !/^[a-zA-Z0-9.-]+$/.test(exe)) return false;
  for (const arg of command) {
    if (typeof arg !== "string" || /[\x00-\x1f\x7f]/.test(arg)) return false;
  }
  const base = executableBaseName(exe);
  const args = command.slice(1);
  if (base === "git") return isAllowedGitCommand(args);
  const policy = ARG_POLICIES.get(base);
  if (!policy) return false;
  return isAllowedNonGitCommand(args, policy);
}

/** Discover the enclosing worktree without executing repository config. */
function inspectionRoot(cwd: string): string {
  let path = realpathSync(cwd);
  const initial = path;
  let bareRoot: string | undefined;
  for (;;) {
    if (existsSync(join(path, ".git"))) return path;
    // Metadata inside a normal worktree also resembles a bare repository.
    // Keep searching for the enclosing worktree before using this fallback.
    if (existsSync(join(path, "HEAD")) && existsSync(join(path, "objects")) && existsSync(join(path, "refs"))) bareRoot ??= path;
    const parent = dirname(path);
    if (parent === path) return bareRoot ?? initial;
    path = parent;
  }
}

/**
 * Inspection-specific installation trust: absolute physical PATH directories and
 * final executable targets outside the inspected worktree and caller cwd only.
 * The general resolver retains its normal relative/empty PATH semantics.
 * Windows uses native EXE/COM only, never PATHEXT, CMD/BAT or ComSpec fallback.
 * Host-managed installations outside those roots are trusted, not sandboxed;
 * this does not protect against concurrent executable replacement.
 */
function inspectionExecutable(base: string, cwd: string): { file: string; env: NodeJS.ProcessEnv } {
  const roots = [inspectionRoot(cwd), realpathSync(process.cwd())];
  const env = stripAuditToolsControlEnv();
  const pathKey = Object.keys(env).find(key => process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH");
  const directories: string[] = [];
  for (let entry of (pathKey ? env[pathKey] ?? "" : "").split(delimiter)) {
    if (process.platform === "win32" && entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    if (!isAbsolute(entry) || roots.some(root => resolveWithinRoot(root, resolve(entry)) !== null)) continue;
    try {
      const physical = realpathSync(entry);
      if (statSync(physical).isDirectory() && !roots.some(root => resolveWithinRoot(root, physical) !== null)) directories.push(physical);
    } catch { /* Missing PATH entries cannot establish trusted identity. */ }
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") delete env[key];
  }
  env.PATH = directories.join(delimiter);
  if (process.platform === "win32") env.PATHEXT = ".EXE;.COM";
  const file = resolveExecutableFile(base, {
    cwd, env,
    executableFile: candidate => {
      try {
        if (!statSync(candidate).isFile()) return null;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        const physical = realpathSync(candidate);
        if (process.platform === "win32" && !/\.(exe|com)$/i.test(physical)) return null;
        return roots.some(root => resolveWithinRoot(root, physical) !== null) ? null : physical;
      } catch { return null; }
    },
  });
  if (!file) throw new Error("No trusted native inspection executable found for " + base);
  return { file, env };
}

/**
 * Git >=2.45 is required by the fixed --no-lazy-fetch global flag: older Git
 * rejects that flag before repository setup/subcommand execution. This also
 * excludes old Git's interpretation of core.fsmonitor=false as a hook path.
 * https://github.com/git/git/blob/v2.45.1/git.c (handle_options)
 * https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor
 */
function inspectionGit(args: string[], env: NodeJS.ProcessEnv): string[] {
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : devNull,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull,
    GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
  });
  const index = gitSubcommandIndex(args);
  const sub = args[index]!;
  const fixed = ["--no-lazy-fetch", "--no-pager", "--no-optional-locks", "--literal-pathspecs"];
  for (const config of [
    "core.fsmonitor=false", "core.pager=cat", "log.showSignature=false",
    "format.pretty=format:%h %s", "submodule.recurse=false",
    "diff.submodule=short", "status.submoduleSummary=false",
  ]) fixed.push("-c", config);
  const protections = ["log", "show", "diff"].includes(sub) ? ["--no-ext-diff", "--no-textconv"] : [];
  if (["diff", "status"].includes(sub)) protections.push("--ignore-submodules=all");
  if (["grep", "blame"].includes(sub)) protections.push("--no-textconv");
  return [...fixed, sub, ...protections, ...args.slice(index + 1)];
}

/** Outcome of actually running an allowlisted command (injectable for tests). */
export interface AllowlistedExecOutcome {
  exit_code: number | null;
  timed_out: boolean;
  spawn_error?: string;
  /** Full combined stdout+stderr (bounded), used to evaluate output matches. */
  output: string;
  /**
   * True when `output` was cut short by `MAX_CAPTURED_OUTPUT` — the command
   * produced more combined stdout+stderr than this outcome contains. A caller
   * must treat `output` as an incomplete prefix, never as proof that missing
   * text is absent: "the capture was cut off" is a distinct state from "the
   * command genuinely produced/omitted X" and must not be read as the latter.
   * Absent (not `false`) on every outcome whose `output` is the full capture.
   */
  truncated?: boolean;
  /**
   * True when the internal allowlist gate refused `command` BEFORE any spawn
   * was attempted (`isAllowedAnchorCommand` returned false) — a structured
   * refusal, never a spawn, never a throw. Distinct from `spawn_error` (which
   * means trusted resolution or launching failed): a refusal
   * never touches the child_process API at all. Absent (not `false`) on every
   * outcome that reached a real spawn attempt.
   */
  refused?: boolean;
  /** Bounded-failure cleanup observations; an unverified cleanup is never success. */
  cleanup?: OwnedProcessCleanup;
}

export type AllowlistedExecRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<AllowlistedExecOutcome>;

/**
 * Spawn an allowlisted read-only command argv-only (never a shell), capturing
 * combined stdout+stderr (bounded). Strips the host-signalling env
 * (`stripAuditToolsControlEnv`), resolves a trusted native executable outside
 * the inspected worktree and caller cwd, and kills commands exceeding `timeoutMs`
 * with bounded owned-process cleanup. This library entry point is shared by
 * callers of the exported inspection API.
 *
 * INTERNAL GATE (invariants[2]): enforces {@link isAllowedAnchorCommand} on
 * itself, unconditionally, before ever spawning — `isAllowedAnchorCommand` is
 * pure, total, and non-throwing, so this check is cheap and correctness no
 * longer depends on every call site remembering to gate first. A refused
 * command resolves a structured refusal (`refused: true`); it is NEVER spawned
 * and this function NEVER throws for a refusal. A caller-side
 * `isAllowedAnchorCommand` pre-check before invoking this function is a
 * redundant, OPTIONAL fast path: double-gating is observationally identical
 * to single-gating, since the check is idempotent.
 *
 * Its reach is the model-authored anchor/targeted command class ONLY — it does
 * NOT reach `runtimeCommand.ts`'s project-test spawn (a discovered, non-model-
 * authored vector the default-deny anchor premise excludes by construction;
 * see `projectTestAdmission.ts` for that surface's own admission gate).
 */
export const runAllowlistedReadOnlyCommand: AllowlistedExecRunner = (
  command,
  cwd,
  timeoutMs,
) => {
  if (!isAllowedAnchorCommand(command)) {
    return Promise.resolve({
      exit_code: null,
      timed_out: false,
      output: "",
      refused: true,
    });
  }
  return new Promise((resolvePromise) => {
    let owned: ReturnType<typeof spawnOwnedProcess>;
    try {
      const base = executableBaseName(command[0]!);
      const { file, env } = inspectionExecutable(base, cwd);
      let args = command.slice(1);
      if (base === "git") args = inspectionGit(args, env);
      else if (base === "rg" || base === "ripgrep") {
        // Fixed before pattern/path operands, even if a caller uses '--'.
        // https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#configuration-file
        for (const key of Object.keys(env)) if (key.toUpperCase() === "RIPGREP_CONFIG_PATH") delete env[key];
        args = ["--no-config", ...args];
      }
      owned = spawnOwnedProcess([file, ...args], { cwd, env, deadlineAt: Date.now() + Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 1) });
    } catch (error) {
      resolvePromise({ exit_code: null, timed_out: false, output: "", spawn_error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const child = owned.child;
    // This runner has always supplied EOF to the admitted read-only command.
    child.stdin.on("error", () => {});
    child.stdin.end();
    let output = "";
    // A chunk that arrives once the cap is already reached is genuinely
    // DROPPED (never appended) — that is the only condition that makes the
    // capture an incomplete prefix, so it is the only condition that sets the
    // signal. A single chunk that pushes `output` past the cap in one shot is
    // still recorded in full (unchanged cap-application behavior); nothing was
    // lost in that case, so `truncated` correctly stays unset.
    let truncated = false;
    let settled = false;
    let stdioIncomplete = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    child.stdout.on("end", () => { stdoutEnded = true; });
    child.stderr.on("end", () => { stderrEnded = true; });
    const capture = (chunk: unknown) => {
      if (settled) return;
      if (output.length < MAX_CAPTURED_OUTPUT) {
        output += String(chunk);
      } else {
        truncated = true;
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let timedOut = false;
    let cancelTermination: (() => void) | undefined;
    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      const cleanup = timedOut ? owned.cleanup(stdioIncomplete) : undefined;
      owned.release();
      resolvePromise({ exit_code: code, timed_out: timedOut, output, ...(spawnError ? { spawn_error: spawnError } : {}), ...(truncated ? { truncated: true } : {}), ...(cleanup ? { cleanup } : {}) });
    };
    const beginTimeout = (): void => {
      if (settled || timedOut) return;
      timedOut = true;
      cancelTermination = beginOwnedProcessTermination(owned, () => {}, () => {
        stdioIncomplete = !stdoutEnded || !stderrEnded;
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        finish(owned.rootStatus());
      });
      if (settled) cancelTermination();
    };
    const timer = setTimeout(beginTimeout, timeoutMs);
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") beginTimeout();
      else if (!timedOut) finish(null, error.message);
    });
    child.on("close", (code) => {
      if (timedOut && !owned.cleanup(false).cleanup_verified) return;
      finish(owned.rootExited() ? owned.rootStatus() : code);
    });
  });
};
