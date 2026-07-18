/**
 * Canonical SessionConfig validation — the single source of truth for BOTH
 * orchestrators (audit + remediate). Field-shape checks emit `error`-severity
 * issues (the config cannot be used safely as-is); the
 * `dangerously_skip_permissions` surface is a `warning` (a legitimate but
 * security-sensitive operator choice that must never be silently honored —
 * INV-shared-core-08).
 *
 * Rule (Auditor-agnostic robustness): both orchestrators MUST reject a malformed
 * `session-config.json` at load rather than degrade silently to a floor. The
 * shared {@link readValidatedRepoSessionIntent} helper is the load-boundary chokepoint
 * that guarantees this without either orchestrator having to remember to call the
 * validator itself.
 */

import { readOptionalJsonFile } from "../io/json.js";
import {
  ANALYZER_SETTINGS,
  DISPATCHABLE_SOURCE_PROVIDERS,
  DISPATCH_INVENTORY_FIELDS,
  PROVIDER_NAMES,
  SESSION_UI_MODES,
  WORKER_KINDS,
  type AnalyzerSetting,
  type ProviderName,
  type RepoSessionIntent,
  type SessionConfig,
  type SessionUiMode,
} from "../types/sessionConfig.js";
import {
  formatValidationIssues,
  isRecord,
  pushValidationIssue,
  type ValidationIssue,
} from "./basic.js";

const VALID_PROVIDERS = new Set<ProviderName>(PROVIDER_NAMES);
const VALID_UI_MODES = new Set<SessionUiMode>(SESSION_UI_MODES);
const VALID_ANALYZER_SETTINGS = new Set<AnalyzerSetting>(ANALYZER_SETTINGS);
const VALID_DISPATCHABLE_SOURCE_PROVIDERS = new Set<string>(
  DISPATCHABLE_SOURCE_PROVIDERS,
);

/**
 * Every `QuotaModelLimits` field is a positive-integer count (token windows,
 * per-minute rate limits, in-flight cap) that feeds admission sizing / rate
 * limiting directly — an out-of-range value silently over- or under-admits (a
 * too-large `context_tokens` over-sizes packets → the exact overrun C1 guards
 * against). Reject it at config load rather than let it reach the scheduler.
 */
// Token windows and per-minute rate limits must be strictly positive integers.
// `max_concurrent` is separate: the runtime treats 0 as the documented
// "unlimited" sentinel (`positiveIntCapOrNull` maps 0 → null), so it allows a
// non-negative integer.
const QUOTA_POSITIVE_INT_FIELDS = [
  "context_tokens",
  "output_tokens",
  "requests_per_minute",
  "input_tokens_per_minute",
  "output_tokens_per_minute",
] as const;

function validateQuotaModelLimits(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, "quota must be a JSON object.");
    return;
  }
  const badFields = new Set<string>();
  for (const key of QUOTA_POSITIVE_INT_FIELDS) {
    const entry = value[key];
    if (
      entry !== undefined &&
      (typeof entry !== "number" || !Number.isInteger(entry) || entry <= 0)
    ) {
      pushIssue(
        issues,
        `${path}.${key}`,
        `${key} must be a positive integer when provided.`,
      );
      badFields.add(key);
    }
  }
  const maxConcurrent = value.max_concurrent;
  if (
    maxConcurrent !== undefined &&
    (typeof maxConcurrent !== "number" ||
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 0)
  ) {
    pushIssue(
      issues,
      `${path}.max_concurrent`,
      "max_concurrent must be a non-negative integer when provided (0 = unlimited).",
    );
  }
  // Cross-field: a reserved output that meets or exceeds the context leaves no
  // room for input. Skip when either field already failed its per-field check
  // (the per-field error is the actionable one; a second message here is noise).
  const context = value.context_tokens;
  const output = value.output_tokens;
  if (
    typeof context === "number" &&
    typeof output === "number" &&
    Number.isFinite(context) &&
    Number.isFinite(output) &&
    !badFields.has("context_tokens") &&
    !badFields.has("output_tokens") &&
    output >= context
  ) {
    pushIssue(
      issues,
      `${path}.output_tokens`,
      "output_tokens must be less than context_tokens (no room for input otherwise).",
    );
  }
}

/**
 * The `DispatchableSource` fields that must be strings when present — every one is
 * read by the ambient-reach probe (`providers/auditorSources.ts`) and/or the launch
 * path, so a non-string here coerces to nonsense downstream rather than failing.
 */
const DISPATCHABLE_SOURCE_STRING_FIELDS = [
  "id",
  "endpoint",
  "model",
  "api_key_env",
  "api_key",
  "credentials_path",
  "account",
  "backend_provider",
] as const;

const VALID_WORKER_KINDS = new Set<string>(WORKER_KINDS);

/**
 * Validate `sessionConfig.sources[]` — the explicit dispatchable-source pool
 * list. Shape-guards each entry's provider, its string fields, and (the C1 concern)
 * its `quota`, which is now the single source of truth for a source pool's admission
 * budget.
 */
function validateDispatchableSources(
  value: unknown,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    pushIssue(
      issues,
      "sources",
      "sources must be an array of dispatchable source objects.",
    );
    return;
  }
  value.forEach((source, index) => {
    const path = `sources[${index}]`;
    if (!isRecord(source)) {
      pushIssue(issues, path, "each source must be a JSON object.");
      return;
    }
    const provider = source.provider;
    if (
      typeof provider !== "string" ||
      !VALID_DISPATCHABLE_SOURCE_PROVIDERS.has(provider)
    ) {
      pushIssue(
        issues,
        `${path}.provider`,
        `provider must be one of: ${Array.from(VALID_DISPATCHABLE_SOURCE_PROVIDERS).join(", ")}.`,
      );
    }
    // The string fields the ambient-reach probe and the launch path both READ. Left
    // unchecked, `{"api_key_env": {"a":1}}` passed here and `env[{...}]` coerced to
    // "[object Object]" downstream. Guarded at this ONE shared site so both boundaries
    // (disk-load and the `--auditor` parse boundary) gain it.
    for (const field of DISPATCHABLE_SOURCE_STRING_FIELDS) {
      const value = source[field];
      if (value !== undefined && typeof value !== "string") {
        pushIssue(issues, `${path}.${field}`, `${field} must be a string.`);
      }
    }
    // `backend_provider` is a quota-ledger KEY segment (`backend_provider[#account]/model`);
    // an empty string would silently mint a nameless pool identity.
    if (
      typeof source.backend_provider === "string" &&
      source.backend_provider.trim().length === 0
    ) {
      pushIssue(
        issues,
        `${path}.backend_provider`,
        "backend_provider must be a non-empty string when provided.",
      );
    }
    if (
      source.worker_kind !== undefined &&
      (typeof source.worker_kind !== "string" ||
        !VALID_WORKER_KINDS.has(source.worker_kind))
    ) {
      pushIssue(
        issues,
        `${path}.worker_kind`,
        `worker_kind must be one of: ${WORKER_KINDS.join(", ")}.`,
      );
    }
    // A claude-worker source IS the proxied spawn: without the proxy url there is
    // nothing to front the isolated `claude -p` (endpoint is a constructor invariant
    // in 3b), and without a model there is no namespace route to compose.
    if (provider === "claude-worker") {
      for (const field of ["endpoint", "model"] as const) {
        const entry = source[field];
        if (typeof entry !== "string" || entry.trim().length === 0) {
          pushIssue(
            issues,
            `${path}.${field}`,
            `${field} is required for a claude-worker source (${
              field === "endpoint" ? "the repair-proxy url" : "the backend-native model id"
            }).`,
          );
        }
      }
    }
    if (source.parameters !== undefined && !isRecord(source.parameters)) {
      pushIssue(issues, `${path}.parameters`, "parameters must be a JSON object.");
    }
    if (source.quota !== undefined) {
      validateQuotaModelLimits(source.quota, `${path}.quota`, issues);
    }
  });
}

function pushIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  pushValidationIssue(issues, path, message);
}

function validateStringArray(
  value: unknown,
  path: string,
  label: string,
  issues: ValidationIssue[],
  options: { allowEmptyArray?: boolean } = {},
): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, `${label} must be an array of strings.`);
    return;
  }

  if (!options.allowEmptyArray && value.length === 0) {
    pushIssue(issues, path, `${label} must not be empty.`);
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      pushIssue(
        issues,
        `${path}[${index}]`,
        `${label} entries must be non-empty strings.`,
      );
    }
  }
}

function validateEnvOverlay(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, "env must be an object of string values.");
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      pushIssue(
        issues,
        `${path}.${key}`,
        "Environment override values must be strings.",
      );
    }
  }
}

function validateTemplateProviderSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      pushIssue(
        issues,
        path,
        "Provider requires this config section with a non-empty command_template.",
      );
    }
    return;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Provider config must be a JSON object.");
    return;
  }

  if (value.command_template === undefined) {
    if (required) {
      pushIssue(
        issues,
        `${path}.command_template`,
        "command_template is required for this provider.",
      );
    }
  } else {
    validateStringArray(
      value.command_template,
      `${path}.command_template`,
      "command_template",
      issues,
    );
  }

  if (value.env !== undefined) {
    validateEnvOverlay(value.env, `${path}.env`, issues);
  }
}

function validateAgentProviderSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }

  if (!isRecord(value)) {
    pushIssue(issues, path, "Provider config must be a JSON object.");
    return;
  }

  if (value.command !== undefined) {
    if (typeof value.command !== "string" || value.command.trim().length === 0) {
      pushIssue(
        issues,
        `${path}.command`,
        "command must be a non-empty string when provided.",
      );
    } else if (!isSupportedConfiguredCommand(value.command)) {
      pushIssue(
        issues,
        `${path}.command`,
        "command must be a bare executable name or direct executable path. Put CLI flags in extra_args.",
      );
    }
  }

  if (value.extra_args !== undefined) {
    validateStringArray(
      value.extra_args,
      `${path}.extra_args`,
      "extra_args",
      issues,
      { allowEmptyArray: true },
    );
  }

  if (path === "claude_code" && value.dangerously_skip_permissions !== undefined) {
    if (typeof value.dangerously_skip_permissions !== "boolean") {
      pushIssue(
        issues,
        `${path}.dangerously_skip_permissions`,
        "dangerously_skip_permissions must be a boolean when provided.",
      );
    } else if (value.dangerously_skip_permissions === true) {
      // INV-shared-core-08: never silently honor a host-permission bypass —
      // surface it as a warning (a legitimate but security-sensitive choice), not
      // an error that blocks the config from loading.
      pushValidationIssue(
        issues,
        `${path}.dangerously_skip_permissions`,
        "dangerously_skip_permissions is set to true — this bypasses host permission controls and should only be used in fully trusted, isolated environments. Verify this is intentional.",
        "warning",
      );
    }
  }
}

/**
 * Validate the `openai_compatible` provider section. Unlike the agentic CLI
 * sections, this one has no `command`/PATH semantics — it is an HTTP endpoint, so
 * we type-check the URL/model/key/tuning fields and, when this provider is the
 * selected one, require the endpoint + model (the API key is resolved from the
 * environment at launch, so its presence is not validated here).
 */
function validateOpenAiCompatibleSection(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      pushIssue(
        issues,
        path,
        "Provider requires this config section with base_url and model.",
      );
    }
    return;
  }
  if (!isRecord(value)) {
    pushIssue(issues, path, "Provider config must be a JSON object.");
    return;
  }
  for (const key of ["base_url", "model", "api_key_env", "api_key"] as const) {
    const entry = value[key];
    if (
      entry !== undefined &&
      (typeof entry !== "string" || entry.trim().length === 0)
    ) {
      pushIssue(
        issues,
        `${path}.${key}`,
        `${key} must be a non-empty string when provided.`,
      );
    }
  }
  if (required) {
    for (const key of ["base_url", "model"] as const) {
      if (value[key] === undefined) {
        pushIssue(
          issues,
          `${path}.${key}`,
          `${key} is required for the openai-compatible provider.`,
        );
      }
    }
  }
  if (value.headers !== undefined) {
    validateEnvOverlay(value.headers, `${path}.headers`, issues);
  }
  for (const key of [
    "temperature",
    "max_output_tokens",
    "referenced_files_max",
    "referenced_file_byte_cap",
    "referenced_files_total_byte_cap",
  ] as const) {
    const entry = value[key];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
      pushIssue(
        issues,
        `${path}.${key}`,
        `${key} must be a finite number when provided.`,
      );
    }
  }
  for (const key of ["response_format_json", "include_referenced_files"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      pushIssue(
        issues,
        `${path}.${key}`,
        `${key} must be a boolean when provided.`,
      );
    }
  }
  if (value.quota !== undefined) {
    validateQuotaModelLimits(value.quota, `${path}.quota`, issues);
  }
}

function startsWithPathPrefix(command: string): boolean {
  return (
    command.startsWith(".") ||
    command.startsWith("/") ||
    command.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(command)
  );
}

function containsForbiddenCommandSyntax(command: string): boolean {
  return /[\r\n"'`|&;<>]/.test(command);
}

/**
 * A configured provider `command` must be either a bare executable name or a
 * direct executable path — never a compound string with flags/metacharacters
 * (those go in `extra_args`). Shared so the field validator and the audit
 * env-probe agree on what a valid command looks like.
 */
export function isBareExecutableName(command: string): boolean {
  return (
    command.length > 0 &&
    !/\s/.test(command) &&
    !containsForbiddenCommandSyntax(command) &&
    !/[\\/]/.test(command) &&
    !/^[A-Za-z]:/.test(command)
  );
}

export function isDirectExecutablePath(command: string): boolean {
  return (
    command.length > 0 &&
    !containsForbiddenCommandSyntax(command) &&
    startsWithPathPrefix(command)
  );
}

export function isSupportedConfiguredCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed !== command) {
    return false;
  }
  return isBareExecutableName(trimmed) || isDirectExecutablePath(trimmed);
}

function validateRoutingTiers(
  value: unknown,
  issues: ValidationIssue[],
): void {
  if (!isRecord(value)) {
    pushIssue(
      issues,
      "dispatch.routing_tiers",
      "dispatch.routing_tiers must be a JSON object.",
    );
    return;
  }
  for (const key of ["deep_at", "standard_at"] as const) {
    const cut = value[key];
    if (
      cut !== undefined &&
      (typeof cut !== "number" || !Number.isFinite(cut) || cut < 0 || cut > 1)
    ) {
      pushIssue(
        issues,
        `dispatch.routing_tiers.${key}`,
        `dispatch.routing_tiers.${key} must be a number in [0, 1] when provided.`,
      );
    }
  }
  if (
    typeof value.deep_at === "number" &&
    typeof value.standard_at === "number" &&
    value.deep_at < value.standard_at
  ) {
    pushIssue(
      issues,
      "dispatch.routing_tiers",
      "dispatch.routing_tiers.deep_at must be >= standard_at.",
    );
  }
}

/**
 * Validate a SessionConfig's field shapes and surface security-sensitive
 * settings. Returns a (possibly empty) list of {@link ValidationIssue}s; `error`
 * severity means the config cannot be used safely, `warning` means the caller
 * should surface the concern before proceeding (see {@link readValidatedRepoSessionIntent}).
 */
export function validateSessionConfig(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value === undefined) {
    return issues;
  }

  if (!isRecord(value)) {
    pushIssue(issues, "session_config", "Session config must be a JSON object.");
    return issues;
  }

  const provider = value.provider;
  if (provider !== undefined) {
    if (typeof provider !== "string") {
      pushIssue(issues, "provider", "provider must be a string.");
    } else if (!VALID_PROVIDERS.has(provider as ProviderName)) {
      pushIssue(
        issues,
        "provider",
        `Unsupported provider "${provider}". Expected one of: ${Array.from(VALID_PROVIDERS).join(", ")}.`,
      );
    } else if (provider === "claude-worker") {
      // H3 (review finding): claude-worker is a dispatch-WORKER class only — it can
      // serve packets from a source pool but can never be the run's primary/self
      // provider. Before this guard a hand-written `provider: "claude-worker"` slipped
      // past load and silently mis-keyed the host fan-out to a worker-class identity
      // (the headless predicate rightly refuses it, so nothing would self-drive
      // either). Loud at the boundary, per enforce-in-tooling.
      pushIssue(
        issues,
        "provider",
        `"claude-worker" is a dispatch-worker class only and cannot be the session's primary provider — ` +
          `declare it as a source pool (sources[] / the proxy lane) instead.`,
      );
    }
  }

  const hostProvider = value.host_provider;
  if (hostProvider !== undefined) {
    if (typeof hostProvider !== "string") {
      pushIssue(issues, "host_provider", "host_provider must be a string.");
    } else if (!VALID_PROVIDERS.has(hostProvider as ProviderName)) {
      pushIssue(
        issues,
        "host_provider",
        `Unsupported host_provider "${hostProvider}". Expected one of: ${Array.from(VALID_PROVIDERS).join(", ")}.`,
      );
    }
  }

  const timeoutMs = value.timeout_ms;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || Number(timeoutMs) <= 0)
  ) {
    pushIssue(
      issues,
      "timeout_ms",
      "timeout_ms must be a positive integer number of milliseconds.",
    );
  }

  const uiMode = value.ui_mode;
  if (uiMode !== undefined) {
    if (typeof uiMode !== "string" || !VALID_UI_MODES.has(uiMode as SessionUiMode)) {
      pushIssue(
        issues,
        "ui_mode",
        `ui_mode must be one of: ${Array.from(VALID_UI_MODES).join(", ")}.`,
      );
    }
  }

  if (
    value.host_can_dispatch_subagents !== undefined &&
    typeof value.host_can_dispatch_subagents !== "boolean"
  ) {
    pushIssue(
      issues,
      "host_can_dispatch_subagents",
      "host_can_dispatch_subagents must be a boolean when provided.",
    );
  }

  if (
    value.autonomous_mode !== undefined &&
    typeof value.autonomous_mode !== "boolean"
  ) {
    pushIssue(
      issues,
      "autonomous_mode",
      "autonomous_mode must be a boolean when provided.",
    );
  }

  validateTemplateProviderSection(
    value.subprocess_template,
    "subprocess_template",
    issues,
    provider === "subprocess-template",
  );
  validateTemplateProviderSection(
    value.vscode_task,
    "vscode_task",
    issues,
    provider === "vscode-task",
  );
  validateTemplateProviderSection(
    value.antigravity,
    "antigravity",
    issues,
    provider === "antigravity",
  );
  validateAgentProviderSection(value.claude_code, "claude_code", issues);
  validateAgentProviderSection(value.codex, "codex", issues);
  validateAgentProviderSection(value.opencode, "opencode", issues);
  validateAgentProviderSection(value.agy, "agy", issues);
  validateOpenAiCompatibleSection(
    value.openai_compatible,
    "openai_compatible",
    issues,
    provider === "openai-compatible",
  );
  validateDispatchableSources(value.sources, issues);

  if (value.synthesis !== undefined) {
    if (!isRecord(value.synthesis)) {
      pushIssue(issues, "synthesis", "synthesis must be a JSON object.");
    } else if (
      value.synthesis.narrative !== undefined &&
      typeof value.synthesis.narrative !== "boolean"
    ) {
      pushIssue(
        issues,
        "synthesis.narrative",
        "synthesis.narrative must be a boolean when provided.",
      );
    }
  }

  if (value.dispatch !== undefined) {
    if (!isRecord(value.dispatch)) {
      pushIssue(issues, "dispatch", "dispatch must be a JSON object.");
    } else {
      if (
        value.dispatch.confirm_threshold !== undefined &&
        (!Number.isInteger(value.dispatch.confirm_threshold) ||
          Number(value.dispatch.confirm_threshold) < 0)
      ) {
        pushIssue(
          issues,
          "dispatch.confirm_threshold",
          "dispatch.confirm_threshold must be a non-negative integer when provided.",
        );
      }
      if (
        value.dispatch.max_packets !== undefined &&
        (!Number.isInteger(value.dispatch.max_packets) ||
          Number(value.dispatch.max_packets) < 0)
      ) {
        pushIssue(
          issues,
          "dispatch.max_packets",
          "dispatch.max_packets must be a non-negative integer when provided.",
        );
      }
      if (value.dispatch.routing_tiers !== undefined) {
        validateRoutingTiers(value.dispatch.routing_tiers, issues);
      }
    }
  }

  if (value.analyzers !== undefined) {
    if (!isRecord(value.analyzers)) {
      pushIssue(
        issues,
        "analyzers",
        "analyzers must be a JSON object mapping analyzer id to a setting.",
      );
    } else {
      for (const [id, setting] of Object.entries(value.analyzers)) {
        if (
          typeof setting !== "string" ||
          !VALID_ANALYZER_SETTINGS.has(setting as AnalyzerSetting)
        ) {
          pushIssue(
            issues,
            `analyzers.${id}`,
            `analyzers.${id} must be one of: ${Array.from(VALID_ANALYZER_SETTINGS).join(", ")}.`,
          );
        }
      }
    }
  }

  return issues;
}

/**
 * Validate a PERSISTED {@link RepoSessionIntent} — the on-disk `session-config.json`
 * shape, which carries audit INTENT + policy ONLY. On top of every field-shape check
 * {@link validateSessionConfig} runs, this REJECTS any dispatch-inventory field (the
 * {@link DISPATCH_INVENTORY_FIELDS} + `dispatch.rolling_engine`) as an `error`, so a
 * resolved backend/launch set is UNREPRESENTABLE on disk: it rides the per-auditor
 * `--auditor` descriptor, never the repo config, and is never inherited across auditors
 * ([[capability-is-per-auditor-not-per-audit]], `spec/unified-dispatch-worker-model.md`).
 * This is what makes the "unrepresentable on disk" invariant REAL rather than
 * TS-write-only — both the audit store and remediate's disk read route through it.
 */
export function validateRepoSessionIntent(value: unknown): ValidationIssue[] {
  const issues = validateSessionConfig(value);
  if (!isRecord(value)) return issues;
  for (const field of DISPATCH_INVENTORY_FIELDS) {
    if (value[field] !== undefined) {
      pushIssue(
        issues,
        field,
        `${field} is dispatch inventory and cannot be persisted on session-config.json — ` +
          `it rides the per-auditor --auditor descriptor (spec/unified-dispatch-worker-model.md).`,
      );
    }
  }
  const dispatch = value.dispatch;
  if (isRecord(dispatch) && dispatch.rolling_engine !== undefined) {
    pushIssue(
      issues,
      "dispatch.rolling_engine",
      "dispatch.rolling_engine is dispatch capability and cannot be persisted — " +
        "set AUDIT_CODE_ROLLING_ENGINE / REMEDIATE_ROLLING_ENGINE or the --auditor descriptor.",
    );
  }
  return issues;
}

/**
 * Read `session-config.json` from `path` and validate it as a {@link RepoSessionIntent}
 * at the load boundary — the single chokepoint both orchestrators route through so a
 * malformed config (or one carrying dispatch inventory that can no longer be persisted)
 * fails loud instead of degrading silently (Auditor-agnostic robustness). Returns
 * `undefined` when the file is absent (a run with no session config is legal), the typed
 * intent when valid, and THROWS on any `error`-severity issue. `warning`-severity issues
 * (e.g. `dangerously_skip_permissions=true`) do not block the load; they are surfaced via
 * `onWarnings` (defaulting to a stderr write so a security-sensitive setting is never
 * silently honored). Consumers overlay the per-auditor descriptor via `resolveSessionConfig`.
 */
export async function readValidatedRepoSessionIntent(
  path: string,
  options: { onWarnings?: (warnings: ValidationIssue[]) => void } = {},
): Promise<RepoSessionIntent | undefined> {
  const raw = await readOptionalJsonFile<unknown>(path);
  if (raw === undefined) {
    return undefined;
  }
  const issues = validateRepoSessionIntent(raw);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Invalid ${path}:\n${formatValidationIssues(errors).replace(/^ {2}/gm, "- ")}`,
    );
  }
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (warnings.length > 0) {
    const surface =
      options.onWarnings ??
      ((w: ValidationIssue[]) =>
        console.warn(
          `Warnings in ${path}:\n${formatValidationIssues(w).replace(/^ {2}/gm, "- ")}`,
        ));
    surface(warnings);
  }
  return raw as RepoSessionIntent;
}
