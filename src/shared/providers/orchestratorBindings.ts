import type {
  AgyConfig,
  ClaudeCodeConfig,
  ClaudeWorkerConfig,
  ResolvedProviderName,
  SessionConfig,
} from "../types/sessionConfig.js";
import type { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import type { FreshSessionProvider } from "./types.js";
import { ClaudeCodeProvider, buildActiveClaudeCodeSessionMessage } from "./claudeCodeProvider.js";
import { ClaudeWorkerProvider } from "./claudeWorkerProvider.js";
import { AgyProvider, buildActiveAgySessionMessage } from "./agyProvider.js";
import { OpenCodeProvider, createOpenCodeProvider } from "./opencodeProvider.js";
import {
  createFreshSessionProvider as createSharedFreshSessionProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
} from "./providerFactory.js";

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

/**
 * Everything an orchestrator's `providers/index.ts` exposes, derived from its
 * descriptor alone.
 */
export interface OrchestratorProviderModule {
  activeClaudeCodeSessionMessage: string;
  createClaudeCodeProvider: OrchestratorProviderBindings["createClaudeCodeProvider"];
  createOpenCodeProvider: (
    config?: Parameters<typeof createOpenCodeProvider>[0],
    launchCommand?: typeof spawnLoggedCommand,
  ) => OpenCodeProvider;
  resolveFreshSessionProviderName: (
    name: string | undefined,
    sessionConfig?: SessionConfig,
    options?: {
      env?: NodeJS.ProcessEnv;
      commandExists?: (command: string) => boolean;
    },
  ) => ResolvedProviderName;
  createFreshSessionProvider: (
    name: string | undefined,
    sessionConfig?: SessionConfig,
  ) => FreshSessionProvider;
}

/**
 * Build an orchestrator's entire provider module from its descriptor.
 *
 * Both orchestrators' `providers/index.ts` were byte-identical apart from the
 * descriptor they referenced — the same bindings call, the same pass-through
 * resolver, the same factory body wiring the same four bound factories. Those
 * files' own docblocks named the descriptor as "the ONE home for everything that
 * legitimately differs", which is precisely why the boilerplate AROUND it should
 * not have been written twice: the descriptor is the per-mode axis, so the
 * module derived from it belongs here, once.
 *
 * The auto-resolution surface is deliberately NARROWER than the shared
 * resolver's: `uiMode` is not forwarded. Both orchestrators already narrowed it
 * identically, and preserving that keeps this a pure de-duplication rather than a
 * silent widening of what each orchestrator can ask for.
 */
export function buildOrchestratorProviderModule(
  descriptor: OrchestratorDescriptor,
): OrchestratorProviderModule {
  const bindings = buildOrchestratorProviderBindings(descriptor);
  return {
    activeClaudeCodeSessionMessage: bindings.activeClaudeCodeSessionMessage,
    createClaudeCodeProvider: bindings.createClaudeCodeProvider,
    // opencode has no per-orchestrator delta; the shared factory is re-exposed
    // so all provider factories keep one import surface.
    createOpenCodeProvider,
    resolveFreshSessionProviderName: (name, sessionConfig = {}, options = {}) =>
      resolveSharedFreshSessionProviderName(name, sessionConfig, options),
    createFreshSessionProvider: (name, sessionConfig = {}) =>
      createSharedFreshSessionProvider(name, sessionConfig, {
        orchestratorName: descriptor.orchestratorName,
        createClaudeCodeProvider: bindings.createClaudeCodeProvider,
        createClaudeWorkerProvider: bindings.createClaudeWorkerProvider,
        createOpenCodeProvider: (config) => createOpenCodeProvider(config),
        createAgyProvider: bindings.createAgyProvider,
      }),
  };
}
