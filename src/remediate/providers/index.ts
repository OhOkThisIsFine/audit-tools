import { buildOrchestratorProviderModule } from "audit-tools/shared";
import type { OrchestratorDescriptor } from "audit-tools/shared";

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

const providerModule = buildOrchestratorProviderModule(
  REMEDIATE_CODE_DESCRIPTOR,
);

export const createClaudeCodeProvider = providerModule.createClaudeCodeProvider;
export const createOpenCodeProvider = providerModule.createOpenCodeProvider;
export const resolveFreshSessionProviderName =
  providerModule.resolveFreshSessionProviderName;
export const createFreshSessionProvider =
  providerModule.createFreshSessionProvider;
