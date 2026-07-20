import type {
  FreshSessionProvider,
  OutputConstraintCapability,
} from "./types.js";
import { commandExists, isSelfSpawnBlocked } from "./providerPathGuard.js";
import type {
  ResolvedProviderName,
  SessionConfig,
  ClaudeCodeConfig,
  ClaudeWorkerConfig,
  CodexConfig,
  OpenCodeConfig,
  AgyConfig,
} from "../types/sessionConfig.js";
import { WorkerCommandProvider } from "./workerCommandProvider.js";
import { SubprocessTemplateProvider } from "./subprocessTemplateProvider.js";
import { CodexProvider } from "./codexProvider.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { RunLogger } from "../observability/runLog.js";

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

export function hasConfiguredOpenCode(sessionConfig: SessionConfig): boolean {
  return (
    Boolean(sessionConfig.opencode?.command?.trim()) ||
    hasEntries(sessionConfig.opencode?.extra_args)
  );
}

function hasConfiguredCodex(config: CodexConfig | undefined): boolean {
  return Boolean(config?.command?.trim()) || hasEntries(config?.extra_args);
}

function hasConfiguredAgy(config: AgyConfig | undefined): boolean {
  return Boolean(config?.command?.trim()) || hasEntries(config?.extra_args);
}

/**
 * openai-compatible is configured when both an endpoint and a model are set. The
 * API key is resolved (and degrades) at launch — env presence is intentionally
 * not probed here, mirroring how the agentic providers don't read credentials
 * during resolution.
 *
 * NOT contradicted by `providers/auditorSources.ts`, which DOES probe env presence:
 * that asks a different question. This function asks "is this backend CONFIGURED?"
 * during launch-time resolution; `verifySourceReach` asks "can this process PROVE it
 * reaches this declared lane?" before admitting it to the dispatch pool. A configured-
 * but-unreachable backend still degrades at launch exactly as documented here.
 */
export function hasConfiguredOpenAiCompatible(
  config: SessionConfig["openai_compatible"],
): boolean {
  return Boolean(config?.base_url?.trim()) && Boolean(config?.model?.trim());
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
  insideAgy: boolean;
  inAntigravity: boolean;
  hasVSCodeTaskTemplate: boolean;
  hasAntigravityTemplate: boolean;
  hasSubprocessTemplate: boolean;
  hasClaudeCodeConfig: boolean;
  hasOpenCodeConfig: boolean;
  hasCodexConfig: boolean;
  hasAgyConfig: boolean;
  hasOpenAiCompatibleConfig: boolean;
  claudeAvailable: boolean;
  opencodeAvailable: boolean;
  codexAvailable: boolean;
  agyAvailable: boolean;
}

function getAutoProviderContext(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv,
  lookupCommand: (command: string) => boolean,
): AutoProviderContext {
  // Self-spawn signals come from the single-sourced guard so the auto-resolver
  // and Gate-0 discovery agree byte-for-byte on what "inside an active session"
  // means (the `CLAUDECODE` / `CODEX` in-session env convention).
  // Note: `CODEX_*` vars in quota/hostLimits.ts denote Anthropic's "Codex
  // Desktop" originator — a distinct concept from the OpenAI Codex CLI.
  // These signals are the behavioral contract; regression-tested in
  // packages/shared/tests/codex-antigravity-providers.test.mjs.
  const insideClaudeCode = isSelfSpawnBlocked("claude-code", env);
  const claudeCommand = sessionConfig.claude_code?.command ?? "claude";
  const opencodeCommand = sessionConfig.opencode?.command ?? "opencode";
  const codexCommand = sessionConfig.codex?.command ?? "codex";
  const insideCodex = isSelfSpawnBlocked("codex", env);
  const insideAgy = isSelfSpawnBlocked("agy", env);
  const agyCommand = sessionConfig.agy?.command ?? "agy";
  return {
    inVSCode: (env.TERM_PROGRAM ?? "").toLowerCase() === "vscode",
    insideOpenCode: Boolean(env.OPENCODE),
    insideClaudeCode,
    insideCodex,
    insideAgy,
    // In-IDE marker for Antigravity: either an `ANTIGRAVITY` env var or
    // `TERM_PROGRAM === "antigravity"`, mirroring the VSCode / TERM_PROGRAM
    // pattern. Both paths require an operator-configured command_template to
    // activate (template-absent falls through to the next priority rung).
    // This signal is the behavioral contract; it is regression-tested in
    // packages/shared/tests/codex-antigravity-providers.test.mjs.
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
    hasAgyConfig: hasConfiguredAgy(sessionConfig.agy),
    hasOpenAiCompatibleConfig: hasConfiguredOpenAiCompatible(
      sessionConfig.openai_compatible,
    ),
    claudeAvailable: !insideClaudeCode && lookupCommand(claudeCommand),
    opencodeAvailable: lookupCommand(opencodeCommand),
    // Self-spawn guard mirrors claudeAvailable: a fresh `codex` subprocess
    // cannot be spawned from inside a codex session.
    codexAvailable: !insideCodex && lookupCommand(codexCommand),
    // Gated for July 18, 2026 sunset cleanup: fallback check for gemini CLI executable on PATH
    agyAvailable:
      !insideAgy &&
      (lookupCommand(agyCommand) ||
        (sessionConfig.agy?.command === undefined && lookupCommand("gemini"))),
  };
}

interface ProviderPriorityRule {
  /**
   * `claude-worker` is excluded AT THE TYPE: it is the source-pool-only proxied
   * worker class, launched exclusively FROM a `claude-worker` DispatchableSource
   * via `withSourceConfig` — auto-resolution must never be able to pick it, so a
   * rule naming it is unrepresentable rather than a review obligation.
   */
  name: Exclude<ResolvedProviderName, "claude-worker">;
  comment: string;
  predicate: (ctx: AutoProviderContext) => boolean;
}

/**
 * Ranked priority table for auto-provider resolution. Each entry specifies a
 * provider name, a human-readable rationale, and a predicate over the context
 * snapshot. `chooseAutoProvider` returns the first matching entry's name.
 * To add a new provider, insert one rule object at the correct rank.
 */
const PROVIDER_PRIORITY_RULES: ProviderPriorityRule[] = [
  {
    name: "opencode",
    comment: "Running inside an opencode session: use it directly.",
    predicate: (ctx) => ctx.insideOpenCode,
  },
  {
    name: "codex",
    comment:
      "Running inside a codex session: use it directly (codexAvailable is forced " +
      "false by the self-spawn guard, so the config/tie-break rungs below would " +
      "not reach it — but a host already inside codex can drive it in-session).",
    predicate: (ctx) => ctx.insideCodex,
  },
  {
    name: "agy",
    comment:
      "Running inside an agy session: use it directly (agyAvailable is forced " +
      "false by the self-spawn guard, but a host already inside agy can drive it in-session).",
    predicate: (ctx) => ctx.insideAgy,
  },
  {
    name: "vscode-task",
    comment:
      "Note: when inside a Claude Code session (CLAUDECODE set) `claudeAvailable` " +
      "is forced false, so we never resolve to claude-code — a fresh `claude` " +
      "subprocess cannot be spawned from within one. Such runs fall through to " +
      "worker-command (manual dispatch), matching ClaudeCodeProvider's guard.",
    predicate: (ctx) => ctx.inVSCode && ctx.hasVSCodeTaskTemplate,
  },
  {
    name: "antigravity",
    comment:
      "Antigravity is IDE-bound and needs an operator-configured template, exactly " +
      "like vscode-task. Only resolve to it when both the IDE marker and a template " +
      "are present.",
    predicate: (ctx) => ctx.inAntigravity && ctx.hasAntigravityTemplate,
  },
  {
    name: "subprocess-template",
    comment: "Explicit subprocess template configured: use it.",
    predicate: (ctx) => ctx.hasSubprocessTemplate,
  },
  {
    name: "claude-code",
    comment: "Config-gated: operator explicitly configured claude-code and it is available.",
    predicate: (ctx) => ctx.hasClaudeCodeConfig && ctx.claudeAvailable,
  },
  {
    name: "opencode",
    comment: "Config-gated: operator explicitly configured opencode and it is available.",
    predicate: (ctx) => ctx.hasOpenCodeConfig && ctx.opencodeAvailable,
  },
  {
    name: "codex",
    comment: "Config-gated: operator explicitly configured codex and it is available.",
    predicate: (ctx) => ctx.hasCodexConfig && ctx.codexAvailable,
  },
  {
    name: "agy",
    comment: "Config-gated: operator explicitly configured agy and it is available.",
    predicate: (ctx) => ctx.hasAgyConfig && ctx.agyAvailable,
  },
  {
    name: "claude-code",
    comment:
      "Tie-break: claude is available — prefer claude-code. (No `!opencodeAvailable` " +
      "guard: opencode no longer competes at the bare-availability rung, so claude " +
      "wins whenever present rather than yielding to an unconfigured opencode.)",
    predicate: (ctx) => ctx.claudeAvailable,
  },
  {
    name: "agy",
    comment: "Tie-break: agy/gemini is available — prefer agy.",
    predicate: (ctx) => ctx.agyAvailable,
  },
  // NOTE: there is deliberately NO bare-availability opencode tie-break. A
  // PATH-detected `opencode` is OPT-IN only — it is auto-selected solely via the
  // config-gated rung above (hasOpenCodeConfig && opencodeAvailable). Without
  // claude and without configured-opencode, resolution falls through to
  // worker-command rather than launching opencode unprompted (PB-1).
  {
    name: "openai-compatible",
    comment:
      "Configured background pool: an OpenAI-compatible endpoint (base_url + model) is an API, " +
      "not a CLI, so there is no PATH probe. Ranked below the available agentic CLIs (which " +
      "produce stronger edits when truly present) but ABOVE the codex last-resort, so an " +
      "explicitly-configured endpoint is preferred over a fallback codex pick — notably inside a " +
      "CLAUDECODE session, where claude can't self-spawn and this becomes the automatic worker.",
    predicate: (ctx) => ctx.hasOpenAiCompatibleConfig,
  },
  {
    name: "codex",
    comment:
      "Last resort: codex is only auto-selected when no claude/opencode is available, " +
      "to avoid surprising existing setups that rely on those.",
    predicate: (ctx) =>
      ctx.codexAvailable && !ctx.claudeAvailable && !ctx.opencodeAvailable,
  },
];

function chooseAutoProvider(context: AutoProviderContext): ResolvedProviderName {
  for (const rule of PROVIDER_PRIORITY_RULES) {
    if (rule.predicate(context)) return rule.name;
  }
  return "worker-command";
}

/**
 * Resolve a concrete provider name. Only the explicit `"auto"` sentinel triggers
 * environment auto-detection; any other requested name (or `sessionConfig.provider`)
 * passes through verbatim, and an entirely unspecified provider defaults to
 * `"worker-command"`. Callers that want auto-detection on an unspecified
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
    name ?? sessionConfig.provider ?? "worker-command";
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
 * Discover a backend's output-constraint capability ONCE (F3 ↔ F4 seam). This is
 * PROVIDER-AGNOSTIC: it switches only on the resolved provider *kind* and on
 * operator-supplied config signals — it NEVER inspects, branches on, or hardcodes
 * a model id, context window, or tier→model map (an explicit project invariant).
 *
 * The agentic-CLI backends (claude-code / codex / opencode / antigravity /
 * vscode-task / subprocess-template / worker-command) take only a rendered
 * prompt; we have no API-level forced-tool-call or schema-constrained decoding
 * over them, so their structural guarantee is `none` and the emit path degrades to
 * the O3 emit-validate-repair seam. The `openai-compatible` backend is the only one
 * that exposes a structural signal, in two strengths:
 *   - when `guided_json` is on (the nullish default) it can constrain decoding to
 *     the worker's per-field JSON Schema (`response_format: json_schema` /
 *     `guided_json`) whenever the dispatch site supplies one → `json_schema_constrained`;
 *   - when `guided_json` is explicitly off but `response_format_json` is on it can
 *     still constrain to a bare JSON object → `structured_output`.
 * The strongest form the endpoint refuses degrades at request time (the provider
 * steps down the response_format ladder on a 400/422), so this descriptor names the
 * strongest form the operator has ENABLED, not a per-request outcome.
 */
export function discoverOutputConstraintCapability(
  providerName: ResolvedProviderName,
  sessionConfig: SessionConfig = {},
): OutputConstraintCapability {
  if (providerName === "openai-compatible") {
    const cfg = sessionConfig.openai_compatible;
    const jsonObject = cfg?.response_format_json;
    const guidedJson = cfg?.guided_json;
    // Nullish ⟹ on by default (mirrors the provider's own request behavior).
    if (guidedJson !== false) {
      return {
        mode: "json_schema_constrained",
        reason:
          "openai-compatible endpoint accepts a per-field JSON Schema (response_format json_schema / guided_json) constraining decoding to the worker's schema when supplied.",
      };
    }
    if (jsonObject !== false) {
      return {
        mode: "structured_output",
        reason:
          "openai-compatible endpoint emits response_format json_object (structured output, no per-field schema enforcement).",
      };
    }
    return {
      mode: "none",
      reason:
        "openai-compatible endpoint has guided_json and response_format_json disabled; no structural output constraint — degrade to emit-validate-repair.",
    };
  }
  return {
    mode: "none",
    reason: `provider '${providerName}' takes a rendered prompt only (no API-level output constraint); emit path degrades to the emit-validate-repair seam.`,
  };
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
  ) => FreshSessionProvider;
  /**
   * The proxied isolated Claude-harness worker (commit 3b). Injected like
   * claude-code so each orchestrator carries only its skip-permissions default;
   * the class body is single-sourced in shared (`ClaudeWorkerProvider`).
   */
  createClaudeWorkerProvider: (
    config: ClaudeWorkerConfig | undefined,
  ) => FreshSessionProvider;
  createOpenCodeProvider: (
    config: OpenCodeConfig | undefined,
  ) => FreshSessionProvider;
  createAgyProvider: (
    config: AgyConfig | undefined,
  ) => FreshSessionProvider;
  /**
   * Optional structured run logger. When provided, auto-resolution decisions are
   * emitted as a structured `provider_launch` event in addition to the human-readable
   * stderr line. This enables machine-parseable, run-correlated observability of
   * provider auto-selection decisions (FND-OBS-12e8582b).
   */
  runLogger?: RunLogger;
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
  // auto-detect rather than silently falling back to worker-command.
  const effectiveName = name ?? sessionConfig.provider ?? "auto";
  const providerName = resolveFreshSessionProviderName(
    effectiveName,
    sessionConfig,
  );
  // Log the auto-resolution decision (only when auto-detection actually ran;
  // an explicitly named provider is the caller's choice and needs no signal).
  // worker-command means no capable agent provider was detected, so it
  // carries the manual-dispatch fallback reason; any other resolution names the
  // detected provider. Structured one-line stderr (FINDING-012 convention),
  // attributed to the orchestrator that invoked the shared factory.
  // When a RunLogger is provided, a structured provider_launch event is also
  // emitted for machine-parseable, run-correlated observability (FND-OBS-12e8582b).
  if (effectiveName === "auto") {
    const fallbackReason =
      providerName === "worker-command"
        ? "no capable agent provider detected; agent tasks require manual dispatch — configure claude-code, opencode, or subprocess-template in session-config.json to automate them"
        : "none";
    process.stderr.write(
      `[shared] providers: ${deps.orchestratorName} auto-resolved provider ` +
        `'${providerName}' (fallback: ${fallbackReason})\n`,
    );
    deps.runLogger?.event({
      kind: "provider_launch",
      provider: providerName,
      phase: "provider_auto_resolution",
      note:
        fallbackReason === "none"
          ? `auto-resolved to ${providerName}`
          : `auto-resolved to ${providerName}; fallback: ${fallbackReason}`,
    });
  }

  const provider = constructProvider(providerName, sessionConfig, deps);
  // F3: discover the output-constraint capability ONCE, here at construction, and
  // stamp it on the provider contract so the dispatch/emit site only ever READS it
  // (never recomputes). Provider-agnostic — see discoverOutputConstraintCapability.
  provider.outputConstraint = discoverOutputConstraintCapability(
    providerName,
    sessionConfig,
  );
  return provider;
}

/** Instantiate the concrete provider class for a resolved provider name. */
function constructProvider(
  providerName: ResolvedProviderName,
  sessionConfig: SessionConfig,
  deps: FreshSessionProviderDeps,
): FreshSessionProvider {
  switch (providerName) {
    case "worker-command":
      return new WorkerCommandProvider();
    case "claude-worker":
      // The proxied isolated Claude-harness worker (commit 3b). The config block is
      // composed at launch by `sourceProviderConfig` from the claude-worker source
      // itself; construction throws loudly when endpoint/service/model are
      // missing (isolation is the class's constructor invariant, not a guard).
      return deps.createClaudeWorkerProvider(sessionConfig.claude_worker);
    case "subprocess-template":
      if (!sessionConfig.subprocess_template?.command_template?.length) {
        throw new Error(
          "subprocess-template provider requires session-config.json with subprocess_template.command_template.",
        );
      }
      return new SubprocessTemplateProvider(
        sessionConfig.subprocess_template,
      );
    case "claude-code":
      return deps.createClaudeCodeProvider(sessionConfig.claude_code);
    case "codex":
      // Codex needs no required config — the command defaults to "codex".
      return new CodexProvider(sessionConfig.codex);
    case "openai-compatible":
      // OpenAI-compatible endpoint (NIM/vLLM/…). No required config at
      // construction; base_url/model/key are validated (and degrade) at launch.
      return new OpenAiCompatibleProvider(sessionConfig.openai_compatible);
    case "opencode":
      return deps.createOpenCodeProvider(sessionConfig.opencode);
    case "agy":
      return deps.createAgyProvider(sessionConfig.agy);
    case "vscode-task":
      if (!sessionConfig.vscode_task?.command_template?.length) {
        throw new Error(
          "vscode-task provider requires session-config.json with vscode_task.command_template.",
        );
      }
      return new SubprocessTemplateProvider(
        sessionConfig.vscode_task,
        "vscode-task",
      );
    case "antigravity":
      if (!sessionConfig.antigravity?.command_template?.length) {
        throw new Error(
          "antigravity provider requires session-config.json with antigravity.command_template — Antigravity is an agentic IDE, not a headless CLI, so it must be driven via a configured command/task template.",
        );
      }
      return new SubprocessTemplateProvider(
        sessionConfig.antigravity,
        "antigravity",
      );
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}
