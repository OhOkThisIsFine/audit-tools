import {
  createFreshSessionProvider as createSharedFreshSessionProvider,
  resolveFreshSessionProviderName as resolveSharedFreshSessionProviderName,
} from "@audit-tools/shared";
import type {
  FreshSessionProvider,
  ResolvedProviderName,
  SessionConfig,
} from "@audit-tools/shared";
import { ClaudeCodeProvider } from "./claudeCodeProvider.js";
import { OpenCodeProvider } from "./opencodeProvider.js";

/**
 * Auto-resolution and provider wiring are single-sourced in `@audit-tools/shared`.
 * This module is a thin remediate-code-specific adapter: it injects
 * remediate-code's own `ClaudeCodeProvider`/`OpenCodeProvider` (which pipe the
 * prompt via stdin and default to skipping permission prompts) and attributes the
 * auto-fallback warning to `remediate-code`.
 */

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
    orchestratorName: "remediate-code",
    createClaudeCodeProvider: (config, opentoken) =>
      new ClaudeCodeProvider(config, undefined, opentoken),
    createOpenCodeProvider: (config, opentoken) =>
      new OpenCodeProvider(config, undefined, opentoken),
  });
}
