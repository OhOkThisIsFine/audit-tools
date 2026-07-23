import { resolve, sep } from "node:path";
import { AUDIT_TOOLS_DIRNAME, WORKTREES_DIRNAME } from "./auditToolsPaths.js";

/**
 * Node-worktree context guard (backlog "shared-state clobber from node context",
 * observed live 2026-07-22): a dispatched worker whose CWD is inside a
 * tool-created worktree (`<root>/.audit-tools/worktrees/<name>` — remediate's
 * per-node implement worktrees, audit's disposable review snapshots) ran a
 * driver lifecycle CLI (`remediate-code next-step` / `merge-implement-results`)
 * against the REAL shared run state: `resolveRepoRoot`'s climb-out-of-
 * `.audit-tools` anchoring resolved the worker's drifted cwd to the real repo
 * root, so the stray invocation rewrote `rolling-session.json` mid-run and
 * falsely blocked an in-flight node. Prompt-level "don't do that" is host
 * discretion; this module is the mechanical refusal.
 *
 * Enforcement model — deny by default, allow a tight worker-safe set:
 *   • Each CLI refuses EVERY subcommand invoked with a node-worktree cwd except
 *     an explicit worker-safe allowlist (result-scoped commands a dispatched
 *     worker legitimately runs from its checkout: audit's `worker-run`,
 *     `submit-packet`, `validate-result(s)`, `validate`; remediate's
 *     validators). A NEW command is therefore refused-from-worker-context until
 *     someone consciously classifies it — fail-closed, never silently exposed.
 *   • The session/state WRITERS additionally assert the process cwd
 *     (`assertNotNodeWorktreeCwd`) as defense-in-depth, so an invocation shape
 *     that bypasses the CLI guard (explicit `--artifacts-dir` from a worktree
 *     cwd, an embedding that never enters the CLI) still cannot clobber.
 *
 * Deliberately NOT chosen (recorded so the decision isn't re-derived):
 *   • Owner-token discrimination — driver and worker are processes on one
 *     filesystem; any token the driver can read from disk the worker can read
 *     too, and a CLI-flag token would be a manual flag the host must remember
 *     (a bug signal by house rule). CWD is the honest mechanical discriminator.
 *   • Forced state-dir redirection for workers — workers are spawned by the
 *     HOST harness (not the tool), so the tool cannot force their env.
 */

/**
 * When `p` lies inside a tool-created worktree, return that worktree's root
 * (`…/.audit-tools/worktrees/<name>`); otherwise null. Matches the OUTERMOST
 * `.audit-tools/worktrees/<name>` segment run (consistent with
 * `climbOutOfAuditTools`). Purely path-shape-based — no filesystem access — so
 * the check is cheap and cannot mis-answer on a half-deleted worktree.
 */
export function nodeWorktreeAncestor(p: string): string | null {
  const segments = resolve(p).split(sep);
  for (let i = 1; i + 2 < segments.length + 1; i++) {
    // Case-insensitive segment compare (review hardening): win32 paths are
    // case-preserving but case-insensitive, so a re-cased cwd must still be
    // detected. Refusing more is safe — a posix dir literally spelled
    // `.AUDIT-TOOLS/WORKTREES/<x>` being treated as a worktree is a non-case.
    if (
      segments[i].toLowerCase() === AUDIT_TOOLS_DIRNAME &&
      segments[i + 1].toLowerCase() === WORKTREES_DIRNAME &&
      typeof segments[i + 2] === "string" &&
      segments[i + 2].length > 0
    ) {
      return segments.slice(0, i + 3).join(sep);
    }
  }
  return null;
}

function refusalMessage(what: string, worktree: string): string {
  return (
    `refusing to run ${what} from inside a tool-created node worktree (${worktree}). ` +
    `This working directory is a dispatched worker's isolated checkout; driver lifecycle ` +
    `commands invoked here resolve to — and mutate — the SHARED run state the driving ` +
    `session owns (the live-run clobber this guard exists to prevent). If you are a ` +
    `dispatched worker: never run remediate-code/audit-code lifecycle CLIs — make your ` +
    `assigned edits and write your declared result file instead. If you are the ` +
    `driver/operator: re-run from the repository root that owns .audit-tools/.`
  );
}

/**
 * Env var through which a cwd-changing wrapper propagates the CALLER's real
 * working directory to the backend it spawns. The packaged audit-code wrapper
 * spawns `dist/audit/index.js` with `cwd` set to the PACKAGE root, so the
 * backend's own `process.cwd()` carries no worktree evidence — the wrapper
 * stamps this var from its own cwd instead (the caller's true location). The
 * literal is re-spelled in `wrapper/audit-code-wrapper-lib.mjs` (plain node,
 * cannot import this module pre-build); `tests/shared/node-worktree-guard.test.mjs`
 * pins the two spellings equal. Scrubbed from every provider spawn
 * (`stripClaudeCodeEnv`) so a dispatched worker never inherits the driver's
 * stamped value and reads it as its own.
 */
export const AUDIT_TOOLS_CALLER_CWD_ENV = "AUDIT_TOOLS_CALLER_CWD";

/**
 * The cwd candidates a guard checks: the wrapper-propagated caller cwd (when
 * present) AND the process's own cwd. Checking both is strictly safer than
 * either alone — a refusal fires when ANY candidate sits in a node worktree.
 */
function cwdCandidates(explicitCwd?: string): string[] {
  if (explicitCwd !== undefined) return [explicitCwd];
  const fromEnv = process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
  return fromEnv ? [fromEnv, process.cwd()] : [process.cwd()];
}

/**
 * Refuse a CLI subcommand invoked from a node-worktree context unless it is in
 * the CLI's worker-safe allowlist. Call once at the CLI's command-dispatch
 * chokepoint so every subcommand — including future ones — is covered without a
 * per-command call site. Checks the caller cwd (wrapper-propagated + own) and,
 * when supplied, the RAW `--root` value — both BEFORE `resolveRepoRoot`, whose
 * climb-out-of-`.audit-tools` anchoring erases exactly the evidence this guard
 * keys on. Throws (loud, actionable); the CLI exits non-zero.
 */
export function assertCliCommandAllowedFromCwd(opts: {
  cliName: string;
  commandName: string;
  workerSafeCommands: ReadonlySet<string>;
  /** Raw `--root` flag value as supplied, pre-anchoring (optional). */
  rawRoot?: string;
  /** Test seam: overrides both cwd candidates when provided. */
  cwd?: string;
}): void {
  if (opts.workerSafeCommands.has(opts.commandName)) return;
  const probes = [...cwdCandidates(opts.cwd)];
  if (opts.rawRoot !== undefined) probes.push(opts.rawRoot);
  for (const probe of probes) {
    const worktree = nodeWorktreeAncestor(probe);
    if (worktree !== null) {
      throw new Error(refusalMessage(`\`${opts.cliName} ${opts.commandName}\``, worktree));
    }
  }
}

/**
 * Writer-side defense-in-depth: assert the current process is not running from
 * inside a node worktree before mutating shared session/state files. Covers
 * invocation shapes the CLI-level guard never sees (explicit `--artifacts-dir`
 * targeting, embedded library use).
 */
export function assertNotNodeWorktreeCwd(context: string, cwd?: string): void {
  for (const probe of cwdCandidates(cwd)) {
    const worktree = nodeWorktreeAncestor(probe);
    if (worktree !== null) {
      throw new Error(refusalMessage(context, worktree));
    }
  }
}
