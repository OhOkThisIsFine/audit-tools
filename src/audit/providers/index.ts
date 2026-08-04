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
 * audit-code's descriptor — the ONE home for everything that legitimately
 * differs from remediate-code — and draws its bound factories from it. The
 * auditor keeps the safe skip-permissions default (off unless explicitly
 * configured).
 */
export const AUDIT_CODE_DESCRIPTOR: OrchestratorDescriptor = {
  orchestratorName: "audit-code",
  sessionConfigPath: ".audit-tools/audit/session-config.json",
  slashCommand: "/audit-code",
  skipPermissionsDefault: false,
  envPrefix: "AUDIT_CODE",
};

const bindings = buildOrchestratorProviderBindings(AUDIT_CODE_DESCRIPTOR);

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  bindings.activeClaudeCodeSessionMessage;
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
    orchestratorName: AUDIT_CODE_DESCRIPTOR.orchestratorName,
    createClaudeCodeProvider: bindings.createClaudeCodeProvider,
    createClaudeWorkerProvider: bindings.createClaudeWorkerProvider,
    createOpenCodeProvider: (config) => createOpenCodeProvider(config),
    createAgyProvider: bindings.createAgyProvider,
  });
}
