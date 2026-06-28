import type { DispatchDriverSelection } from "./scheduler.js";

/**
 * Render the ONE canonical host instruction for a chosen dispatch driver
 * strategy (universal-host-prompts-single-source: both orchestrators render the
 * same prose, never per-orchestrator-authored variants that can drift). The
 * mechanics — spawn a subagent per node, keep up to `slots` running, refill on
 * completion — are identical across strategies; only WHO runs the refill loop
 * differs, so the prose differs only in that one respect.
 *
 * `slotsLabel` is how the caller refers to the concurrency cap in its own prompt
 * (e.g. "`max_concurrent_agents`" or a literal number) so the line stays
 * consistent with the surrounding prompt's vocabulary.
 */
export function renderDispatchDriverInstruction(
  selection: DispatchDriverSelection,
  slotsLabel: string,
): string {
  switch (selection.strategy) {
    case "y_dispatcher":
      return [
        `**Driver — delegate the rolling loop.** This host fans out to parallel`,
        `subagents and the frontier is large enough to be worth it: spawn ONE`,
        `dedicated dispatcher subagent and hand it the rolling loop. The dispatcher`,
        `keeps up to ${slotsLabel} node-subagents running at once, refilling a slot`,
        `as each node completes, until the frontier is exhausted. This keeps your`,
        `own context clean — you do not track per-node completion yourself.`,
      ].join("\n");
    case "slot_pull":
      return [
        `**Driver — drive the loop yourself.** The frontier is small (or only one`,
        `slot is available), so a separate dispatcher subagent is not worth its`,
        `overhead. Run the rolling loop directly: keep up to ${slotsLabel}`,
        `node-subagents running at once and dispatch the next pending node as each`,
        `one completes.`,
      ].join("\n");
    case "in_process":
      return [
        `**Driver — in-process engine.** This provider's slots are pulled directly`,
        `by the in-process rolling engine; no host-spawned subagents are needed for`,
        `these nodes.`,
      ].join("\n");
  }
}
