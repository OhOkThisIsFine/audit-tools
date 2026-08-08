/**
 * The shared prep head both rolling dispatchers run before a worker launch.
 *
 * `rollingAuditDispatch` (audit's draw) and `providerNodeDispatch` (remediate's
 * draw) are one dispatch algorithm over two different INPUTS, not two algorithms.
 * Everything up to "which worker contract am I writing" is identical: resolve the
 * provider the SCHEDULER picked for this slot (not a fixed configured one, so
 * cross-pool spill actually routes to a peer pool's backend), build the config
 * from that pool's source when the pool is source-backed, and name the three
 * sidecars the launch needs.
 *
 * What legitimately stays per-mode is only:
 *   (a) INPUT — the worker task itself (`audit-code-worker/v1alpha1` vs
 *       `remediation-worker/v1alpha1` carry different fields), and
 *   (b) the terminal/result-routing adapter — which root the worker runs against
 *       (audit's disposable review snapshot vs remediate's per-node worktree) and
 *       how the outcome is labelled.
 * Both are supplied by the caller; neither is a knob on this module.
 */

import { dirname, join } from "node:path";
import { artifactNameForId } from "../io/artifactName.js";
import { withSourceConfig } from "../quota/apiPool.js";
import type { SessionConfig, DispatchableSource } from "../types/sessionConfig.js";
import type { FreshSessionProvider } from "../providers/types.js";
import type { ProviderSlot } from "./rollingDispatch.js";

/** Builds a provider for a resolved name + config. Each orchestrator binds its own. */
export type FreshSessionProviderFactory = (
  name: string | undefined,
  sessionConfig: SessionConfig,
) => FreshSessionProvider;

export interface ProviderDispatchPrepParams {
  /**
   * Test/caller override for the provider factory. When absent, `fallback` is
   * used — which is each orchestrator's own descriptor-bound
   * `createFreshSessionProvider`.
   */
  createProvider?: FreshSessionProviderFactory;
  /** Per-pool source config, so two sources of one provider launch distinctly. */
  sourceByPoolId?: Map<string, DispatchableSource>;
  sessionConfig: SessionConfig | null | undefined;
}

/**
 * Resolve the provider for one slot.
 *
 * The provider comes from the slot the scheduler chose, falling back to the
 * configured provider when the slot names none. `withSourceConfig` folds the
 * pool's own `{endpoint, model, parameters}` in first, so a source-backed pool
 * launches its own backend rather than the global one.
 */
export function resolveDispatchProvider(
  params: ProviderDispatchPrepParams,
  slot: ProviderSlot | null | undefined,
  fallback: FreshSessionProviderFactory,
): FreshSessionProvider {
  const resolveProvider = params.createProvider ?? fallback;
  const source = params.sourceByPoolId?.get(slot?.poolId ?? "");
  const cfg = withSourceConfig(params.sessionConfig ?? {}, source);
  return resolveProvider(slot?.providerName || cfg.provider, cfg);
}

/**
 * The three sidecar paths a launch needs, beside the worker's result file.
 *
 * `id` is model-authored on both draws — audit packet ids embed `:`, remediation
 * block ids are minted from an LLM-authored DAG node id — so the name goes
 * through `artifactNameForId` rather than being interpolated raw. A raw `:`
 * throws on NTFS, and a raw `/` does something worse: it silently mkdir -p's a
 * subtree and hides the sidecar one level down, on every platform.
 */
export function dispatchSidecarNames(
  id: string,
): { task: string; stdout: string; stderr: string } {
  return {
    task: artifactNameForId(id, "task.json"),
    stdout: artifactNameForId(id, "stdout.txt"),
    stderr: artifactNameForId(id, "stderr.txt"),
  };
}

/** {@link dispatchSidecarNames}, resolved against the directory they live in. */
function dispatchSidecarPaths(
  dir: string,
  id: string,
): { taskPath: string; stdoutPath: string; stderrPath: string } {
  const names = dispatchSidecarNames(id);
  return {
    taskPath: join(dir, names.task),
    stdoutPath: join(dir, names.stdout),
    stderrPath: join(dir, names.stderr),
  };
}

/** The sidecar paths for a worker whose result file is `resultPath`. */
export function dispatchSidecarPathsForResult(
  resultPath: string,
  id: string,
): { taskPath: string; stdoutPath: string; stderrPath: string } {
  return dispatchSidecarPaths(dirname(resultPath), id);
}
