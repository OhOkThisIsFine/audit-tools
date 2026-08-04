import type { AgyConfig, ClaudeCodeConfig, ClaudeWorkerConfig } from "../types/sessionConfig.js";
import type { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import { ClaudeCodeProvider, buildActiveClaudeCodeSessionMessage } from "./claudeCodeProvider.js";
import { ClaudeWorkerProvider } from "./claudeWorkerProvider.js";
import { AgyProvider, buildActiveAgySessionMessage } from "./agyProvider.js";

/**
 * The per-orchestrator delta, declared ONCE per side (drift-plan E4 completed:
 * the provider class bodies live in shared; this descriptor is the single home
 * for everything that legitimately differs between the two draws). Provider
 * factories, nested-session guard messages, and the quota env-prefix all derive
 * from it — a new per-mode delta is a FIELD here, never a copied module.
 */
export interface OrchestratorDescriptor {
  /** "audit-code" | "remediate-code" — attribution for warnings/logs. */
  orchestratorName: string;
  /** Session-config path quoted in the nested-session guard messages. */
  sessionConfigPath: string;
  /** Slash command quoted in the nested-session guard messages. */
  slashCommand: string;
  /**
   * Whether providers skip permission prompts unless explicitly configured
   * otherwise (the autonomous remediator: true; the auditor: false).
   */
  skipPermissionsDefault: boolean;
  /** Env-var prefix for host-limit detection (e.g. "AUDIT_CODE"). */
  envPrefix: string;
}

/** The provider factory set an orchestrator injects into shared auto-resolution. */
export interface OrchestratorProviderBindings {
  activeClaudeCodeSessionMessage: string;
  activeAgySessionMessage: string;
  createClaudeCodeProvider: (
    config?: ClaudeCodeConfig,
    launchCommand?: typeof spawnLoggedCommand,
  ) => ClaudeCodeProvider;
  createClaudeWorkerProvider: (
    config?: ClaudeWorkerConfig,
    launchCommand?: typeof spawnLoggedCommand,
  ) => ClaudeWorkerProvider;
  createAgyProvider: (
    config?: AgyConfig,
    launchCommand?: typeof spawnLoggedCommand,
  ) => AgyProvider;
}

/**
 * Bind the shared provider classes to one orchestrator's descriptor. The
 * factories carry the orchestrator's ONLY deltas (skip-permissions default and
 * the guard message); everything else is the shared class verbatim.
 */
export function buildOrchestratorProviderBindings(
  descriptor: OrchestratorDescriptor,
): OrchestratorProviderBindings {
  const messageParams = {
    sessionConfigPath: descriptor.sessionConfigPath,
    slashCommand: descriptor.slashCommand,
  };
  const activeClaudeCodeSessionMessage =
    buildActiveClaudeCodeSessionMessage(messageParams);
  const activeAgySessionMessage = buildActiveAgySessionMessage(messageParams);
  return {
    activeClaudeCodeSessionMessage,
    activeAgySessionMessage,
    createClaudeCodeProvider: (config = {}, launchCommand) =>
      new ClaudeCodeProvider(
        config,
        {
          skipPermissionsDefault: descriptor.skipPermissionsDefault,
          activeSessionMessage: activeClaudeCodeSessionMessage,
        },
        launchCommand,
      ),
    createClaudeWorkerProvider: (config = {}, launchCommand) =>
      new ClaudeWorkerProvider(
        config,
        { skipPermissionsDefault: descriptor.skipPermissionsDefault },
        launchCommand,
      ),
    createAgyProvider: (config = {}, launchCommand) =>
      new AgyProvider(
        config,
        {
          skipPermissionsDefault: descriptor.skipPermissionsDefault,
          activeSessionMessage: activeAgySessionMessage,
        },
        launchCommand,
      ),
  };
}
