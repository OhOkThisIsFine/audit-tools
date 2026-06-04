import { spawnSync } from "node:child_process";
import type { FreshSessionProvider } from "./types.js";
import type {
  ResolvedProviderName,
  SessionConfig,
  ClaudeCodeConfig,
  CodexConfig,
  OpenCodeConfig,
  OpenTokenConfig,
} from "../types/sessionConfig.js";
import { LocalSubprocessProvider } from "./localSubprocessProvider.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { VSCodeTaskProvider } from "./vscodeTaskProvider.js";
import { CodexProvider } from "./codexProvider.js";
import { AntigravityProvider } from "./antigravityProvider.js";

function hasEntries(values: string[] | undefined): boolean {
  return (values?.length ?? 0) > 0;
}

function hasConfiguredClaudeCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.claude_code?.command?.trim()) ||
    hasEntries(sessionConfig.claude_code?.extra_args) ||
    sessionConfig.claude_code?.dangerously_skip_permissions === true
  );
}

function hasConfiguredOpenCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.opencode?.command?.trim()) ||
    hasEntries(sessionConfig.opencode?.extra_args)
  );
}

function hasConfiguredCodex(config: CodexConfig | undefined): boolean {
  return Boolean(config?.command?.trim()) || hasEntries(config?.extra_args);
}

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], { stdio: "ignore" });
  return result.status === 0;
}

/**
 * Snapshot of the environment + session-config signals the auto-resolver reads.
 * Captured once so `chooseAutoProvider` is a pure function of these inputs.
 */
export interface AutoProviderContext {
  inVSCode: boolean;
  insideOpenCode: boolean;
  insideClaudeCode: boolean;
  insideCodex: boolean;
  inAntigravity: boolean;
  hasVSCodeTaskTemplate: boolean;
  hasAntigravityTemplate: boolean;
  hasSubprocessTemplate: boolean;
  hasClaudeCodeConfig: boolean;
  hasOpenCodeConfig: boolean;
  hasCodexConfig: boolean;
  claudeAvailable: boolean;
  opencodeAvailable: boolean;
  codexAvailable: boolean;
}

function getAutoProviderContext(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv,
  lookupCommand: (command: string) => boolean,
): AutoProviderContext {
  const insideClaudeCode = Boolean(env.CLAUDECODE);
  const claudeCommand = sessionConfig.claude_code?.command ?? "claude";
  const opencodeCommand = sessionConfig.opencode?.command ?? "opencode";
  const codexCommand = sessionConfig.codex?.command ?? "codex";
  // TODO(verify): the in-session env signal Codex sets inside its own session.
  // Assumed `CODEX` (mirroring CLAUDECODE / OPENCODE). Note the existing
  // CODEX_* vars in quota/hostLimits.ts denote Anthropic's "Codex Desktop"
  // originator, which is a distinct concept from the OpenAI Codex CLI added
  // here — confirm the real marker before relying on auto-detection.
  const insideCodex = Boolean(env.CODEX);
  return {
    inVSCode: (env.TERM_PROGRAM ?? "").toLowerCase() === "vscode",
    insideOpenCode: Boolean(env.OPENCODE),
    insideClaudeCode,
    insideCodex,
    // TODO(verify): Antigravity's in-IDE marker. Assumed an `ANTIGRAVITY` env
    // var or TERM_PROGRAM === "antigravity"; confirm the real signal the IDE
    // exposes to its integrated terminal.
    inAntigravity:
      Boolean(env.ANTIGRAVITY) ||
      (env.TERM_PROGRAM ?? "").toLowerCase() === "antigravity",
    hasVSCodeTaskTemplate: hasEntries(sessionConfig.vscode_task?.command_template),
    hasAntigravityTemplate: hasEntries(
      sessionConfig.antigravity?.command_template,
    ),
    hasSubprocessTemplate: hasEntries(
      sessionConfig.subprocess_template?.command_template,
    ),
    hasClaudeCodeConfig: hasConfiguredClaudeCode(sessionConfig),
    hasOpenCodeConfig: hasConfiguredOpenCode(sessionConfig),
    hasCodexConfig: hasConfiguredCodex(sessionConfig.codex),
    claudeAvailable: !insideClaudeCode && lookupCommand(claudeCommand),
    opencodeAvailable: lookupCommand(opencodeCommand),
    // Self-spawn guard mirrors claudeAvailable: a fresh `codex` subprocess
    // cannot be spawned from inside a codex session.
    codexAvailable: !insideCodex && lookupCommand(codexCommand),
  };
}

function chooseAutoProvider(context: AutoProviderContext): ResolvedProviderName {
  // Running inside an opencode session: use it directly.
  if (context.insideOpenCode) return "opencode";
  // Running inside a codex session: use it directly (codexAvailable is forced
  // false by the self-spawn guard, so the config/tie-break rungs below would
  // not reach it — but a host already inside codex can drive it in-session).
  if (context.insideCodex) return "codex";
  // Note: when inside a Claude Code session (CLAUDECODE set) `claudeAvailable`
  // is forced false, so we never resolve to claude-code — a fresh `claude`
  // subprocess cannot be spawned from within one. Such runs fall through to
  // local-subprocess (manual dispatch), matching ClaudeCodeProvider's guard.
  if (context.inVSCode && context.hasVSCodeTaskTemplate) return "vscode-task";
  // Antigravity is IDE-bound and needs an operator-configured template, exactly
  // like vscode-task. Only resolve to it when both the IDE marker and a template
  // are present.
  if (context.inAntigravity && context.hasAntigravityTemplate) {
    return "antigravity";
  }
  if (context.hasSubprocessTemplate) return "subprocess-template";
  if (context.hasClaudeCodeConfig && context.claudeAvailable) {
    return "claude-code";
  }
  if (context.hasOpenCodeConfig && context.opencodeAvailable) {
    return "opencode";
  }
  if (context.hasCodexConfig && context.codexAvailable) {
    return "codex";
  }
  if (context.claudeAvailable && !context.opencodeAvailable) {
    return "claude-code";
  }
  if (context.opencodeAvailable && !context.claudeAvailable) {
    return "opencode";
  }
  // Codex is only auto-selected as a last resort when no claude/opencode is
  // available, to avoid surprising existing setups that rely on those.
  if (
    context.codexAvailable &&
    !context.claudeAvailable &&
    !context.opencodeAvailable
  ) {
    return "codex";
  }
  return "local-subprocess";
}

/**
 * Resolve a concrete provider name. Only the explicit `"auto"` sentinel triggers
 * environment auto-detection; any other requested name (or `sessionConfig.provider`)
 * passes through verbatim, and an entirely unspecified provider defaults to
 * `"local-subprocess"`. Callers that want auto-detection on an unspecified
 * provider should pass `"auto"` (see `createFreshSessionProvider`).
 */
export function resolveFreshSessionProviderName(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  options: {
    env?: NodeJS.ProcessEnv;
    commandExists?: (command: string) => boolean;
  } = {},
): ResolvedProviderName {
  const requestedProvider =
    name ?? sessionConfig.provider ?? "local-subprocess";
  if (requestedProvider !== "auto") {
    return requestedProvider as ResolvedProviderName;
  }

  const env = options.env ?? process.env;
  const lookupCommand = options.commandExists ?? commandExists;
  return chooseAutoProvider(
    getAutoProviderContext(sessionConfig, env, lookupCommand),
  );
}

/**
 * Per-orchestrator hooks for the two providers that legitimately differ between
 * audit-code and remediate-code (prompt delivery, skip-permissions default, and
 * the session-config path referenced in error messages). The shared factory owns
 * all wiring except the construction of these two, which each orchestrator injects
 * so its own `ClaudeCodeProvider` / `OpenCodeProvider` semantics are preserved.
 */
export interface FreshSessionProviderDeps {
  /** Human-readable orchestrator name, interpolated into the fallback warning. */
  orchestratorName: string;
  createClaudeCodeProvider: (
    config: ClaudeCodeConfig | undefined,
    opentoken: OpenTokenConfig,
  ) => FreshSessionProvider;
  createOpenCodeProvider: (
    config: OpenCodeConfig | undefined,
    opentoken: OpenTokenConfig,
  ) => FreshSessionProvider;
}

/**
 * Instantiate the resolved provider. When neither `name` nor
 * `sessionConfig.provider` is set, auto-detection is requested on the caller's
 * behalf (the conversation-first default). The claude-code and opencode providers
 * are built via the injected `deps` so each orchestrator keeps its own behavior;
 * every other provider lives in shared and is instantiated here directly. The
 * auto-fallback warning is attributed to `deps.orchestratorName`.
 */
export function createFreshSessionProvider(
  name: string | undefined,
  sessionConfig: SessionConfig = {},
  deps: FreshSessionProviderDeps,
): FreshSessionProvider {
  // Conversation-first callers pass nothing; treat that as a request to
  // auto-detect rather than silently falling back to local-subprocess.
  const effectiveName = name ?? sessionConfig.provider ?? "auto";
  const providerName = resolveFreshSessionProviderName(
    effectiveName,
    sessionConfig,
  );
  const opentoken = sessionConfig.opentoken ?? {};
  // Log the auto-resolution decision (only when auto-detection actually ran;
  // an explicitly named provider is the caller's choice and needs no signal).
  // local-subprocess means no capable agent provider was detected, so it
  // carries the manual-dispatch fallback reason; any other resolution names the
  // detected provider. Structured one-line stderr (FINDING-012 convention),
  // attributed to the orchestrator that invoked the shared factory.
  if (effectiveName === "auto") {
    const fallbackReason =
      providerName === "local-subprocess"
        ? "no capable agent provider detected; agent tasks require manual dispatch — configure claude-code, opencode, or subprocess-template in session-config.json to automate them"
        : "none";
    process.stderr.write(
      `[shared] providers: ${deps.orchestratorName} auto-resolved provider ` +
        `'${providerName}' (fallback: ${fallbackReason})\n`,
    );
  }

  switch (providerName) {
    case "local-subprocess":
      return new LocalSubprocessProvider();
    case "subprocess-template":
      if (!sessionConfig.subprocess_template?.command_template?.length) {
        throw new Error(
          "subprocess-template provider requires session-config.json with subprocess_template.command_template.",
        );
      }
      return new SubprocessTemplateProvider(
        sessionConfig.subprocess_template,
        undefined,
        undefined,
        opentoken,
      );
    case "claude-code":
      return deps.createClaudeCodeProvider(sessionConfig.claude_code, opentoken);
    case "codex":
      // Codex needs no required config — the command defaults to "codex".
      return new CodexProvider(sessionConfig.codex, undefined, opentoken);
    case "opencode":
      return deps.createOpenCodeProvider(sessionConfig.opencode, opentoken);
    case "vscode-task":
      if (!sessionConfig.vscode_task?.command_template?.length) {
        throw new Error(
          "vscode-task provider requires session-config.json with vscode_task.command_template.",
        );
      }
      return new VSCodeTaskProvider(sessionConfig.vscode_task, undefined, opentoken);
    case "antigravity":
      if (!sessionConfig.antigravity?.command_template?.length) {
        throw new Error(
          "antigravity provider requires session-config.json with antigravity.command_template — Antigravity is an agentic IDE, not a headless CLI, so it must be driven via a configured command/task template.",
        );
      }
      return new AntigravityProvider(
        sessionConfig.antigravity,
        undefined,
        opentoken,
      );
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
