import { buildOrchestratorProviderModule } from "audit-tools/shared";
import type { OrchestratorDescriptor } from "audit-tools/shared";

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

const providerModule = buildOrchestratorProviderModule(AUDIT_CODE_DESCRIPTOR);

export const ACTIVE_CLAUDE_CODE_SESSION_MESSAGE =
  providerModule.activeClaudeCodeSessionMessage;
export const createClaudeCodeProvider = providerModule.createClaudeCodeProvider;
export const createOpenCodeProvider = providerModule.createOpenCodeProvider;
export const resolveFreshSessionProviderName =
  providerModule.resolveFreshSessionProviderName;
export const createFreshSessionProvider =
  providerModule.createFreshSessionProvider;
