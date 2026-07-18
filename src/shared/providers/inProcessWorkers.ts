/**
 * The single-sourced in-process worker classification (unified-routing step H3).
 *
 * Replaces THREE drifted per-draw allowlists (audit hybrid `IN_PROCESS_AUDIT_PROVIDERS`,
 * audit headless `IN_PROCESS_DISPATCH_PROVIDERS`, remediate `IN_PROCESS_DISPATCH_PROVIDERS`)
 * whose memberships had silently diverged — a new worker kind had to be hand-added to
 * each, and `claude-worker` was added to neither at first (the 2026-07-16 dogfood:
 * a whole lane confirmable-but-undrivable). One shared base set + two DISTINCT,
 * named predicates; per-draw policy is an explicit argument, never a fork.
 *
 * Two predicates, deliberately different:
 * - {@link isInProcessWorkerProvider} — can this POOL be driven in-process as a
 *   per-item worker? (The hybrid split's classifier.) `claude-worker` IS one (a
 *   proxied `claude -p` worker); the command-shaped backends
 *   (`subprocess-template` / `worker-command`) are workers only for a draw whose
 *   items carry per-item worker commands — remediate implement nodes do, audit's
 *   read-only review packets do not (`commandWorkers` policy flag).
 * - {@link isHeadlessPrimaryProvider} — can this provider be the PRIMARY
 *   self-driving backend of a headless run? Same base MINUS `claude-worker`:
 *   architecturally a dispatch-worker class only (providerFactory excludes it from
 *   auto-resolution; `assertHostProviderName` rejects it as `self.provider`), so it
 *   can never drive a run — only serve packets.
 */

/** Backends drivable in-process as per-item workers, in any draw. */
const IN_PROCESS_WORKER_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
  "agy",
  "claude-worker",
]);

/**
 * Command-shaped worker backends: drivable only where each work item carries its
 * own worker command (remediate implement nodes; never audit review packets).
 */
const COMMAND_WORKER_PROVIDERS: ReadonlySet<string> = new Set([
  "subprocess-template",
  "worker-command",
]);

/**
 * Whether a pool's provider is drivable in-process as a per-item worker.
 * `commandWorkers: true` (remediate implement) additionally admits the
 * command-shaped backends.
 */
export function isInProcessWorkerProvider(
  provider: string | undefined,
  options?: { commandWorkers?: boolean },
): boolean {
  if (provider === undefined) return false;
  if (IN_PROCESS_WORKER_PROVIDERS.has(provider)) return true;
  return options?.commandWorkers === true && COMMAND_WORKER_PROVIDERS.has(provider);
}

/**
 * Whether a provider can be the PRIMARY self-driving backend of a headless run —
 * the distinctly-named primary-provider predicate (never confuse with the pool
 * predicate above): `claude-worker` is a worker class only, excluded here.
 * `commandWorkers` mirrors the per-draw policy (remediate historically allows a
 * command-shaped primary; audit does not).
 */
export function isHeadlessPrimaryProvider(
  provider: string | undefined,
  options?: { commandWorkers?: boolean },
): boolean {
  if (provider === undefined || provider === "claude-worker") return false;
  return isInProcessWorkerProvider(provider, options);
}
