import {
  buildOrchestratorProviderBindings,
  createFreshSessionProvider as createSharedFreshSessionProvider,
  createOpenCodeProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
} from "audit-tools/shared";
import type {
  FreshSessionProvider,
  OrchestratorDescriptor,
  ResolvedProviderName,
  SessionConfig,
} from "audit-tools/shared";

/**
 * Auto-resolution, the provider classes, AND the per-orchestrator binding
 * machinery are single-sourced in `audit-tools/shared`; this module declares
 * remediate-code's descriptor — the ONE home for everything that legitimately
 * differs from audit-code — and draws its bound factories from it. The
 * autonomous remediator skips permission prompts by default (it applies changes
 * unattended and cannot pause mid-run); an explicit
 * `dangerously_skip_permissions: false` in the config still opts out.
 */
export const REMEDIATE_CODE_DESCRIPTOR: OrchestratorDescriptor = {
  orchestratorName: "remediate-code",
  sessionConfigPath: ".audit-tools/remediation/session-config.json",
  slashCommand: "/remediate-code",
  skipPermissionsDefault: true,
  envPrefix: "REMEDIATE_CODE",
};

const bindings = buildOrchestratorProviderBindings(REMEDIATE_CODE_DESCRIPTOR);

export const createClaudeCodeProvider = bindings.createClaudeCodeProvider;
// opencode has no per-orchestrator delta; the shared factory is re-exported to
// keep one import surface for all provider factories.
export { createOpenCodeProvider };

export function resolveFreshSessionProviderName(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: (command: string) => boolean;
  } = {},
): ResolvedProviderName {
  return resolveSharedFreshSessionProviderName(name, sessionConfig, options);
}

export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
): FreshSessionProvider {
  return createSharedFreshSessionProvider(name, sessionConfig, {
    orchestratorName: REMEDIATE_CODE_DESCRIPTOR.orchestratorName,
    createClaudeCodeProvider: bindings.createClaudeCodeProvider,
    createClaudeWorkerProvider: bindings.createClaudeWorkerProvider,
    createOpenCodeProvider: (config) => createOpenCodeProvider(config),
    createAgyProvider: bindings.createAgyProvider,
  });
}
