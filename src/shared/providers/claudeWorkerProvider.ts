import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "./types.js";
import type { ClaudeWorkerConfig } from "../types/sessionConfig.js";
import { readJsonFile } from "../io/json.js";
import { spawnLoggedCommand } from "./spawnLoggedCommand.js";
import {
  applyWorkerTaskLaunchSettings,
  type WorkerTaskWithCommand,
} from "./workerTaskLaunch.js";
import {
  emitProviderLaunchDiagnostic,
  emitProviderDoneDiagnostic,
} from "./providerDiagnostics.js";

export const CLAUDE_WORKER_PROVIDER_NAME = "claude-worker" as const;

/**
 * The explicit DUMMY key presented to a proxied spawn. The loopback repair-proxy
 * needs no key, and an ambient real `ANTHROPIC_API_KEY` must NEVER be silently
 * presented to a proxied spawn — so the overlay always sets this sentinel rather
 * than leaving the variable to inherit from the parent env.
 */
export const CLAUDE_WORKER_DUMMY_API_KEY = "audit-tools-claude-worker";

/**
 * Per-orchestrator tuning for the otherwise-identical claude-worker provider —
 * mirrors {@link ClaudeCodeProviderOptions} minus the nested-session guard message
 * (this class has no guard; see the class doc). The only intended delta between
 * orchestrators is the skip-permissions default.
 */
export interface ClaudeWorkerProviderOptions {
  /**
   * Whether to default to `--dangerously-skip-permissions` when the config does
   * not set `dangerously_skip_permissions` explicitly. The auditor keeps the safe
   * `false`; the autonomous remediator passes `true` (it applies changes
   * unattended and cannot pause mid-run). An explicit config value wins.
   */
  skipPermissionsDefault?: boolean;
}

/**
 * The `projects` key the Claude CLI trusts a repo under: the absolute repo root
 * with FORWARD slashes on every platform (live probe: the trust warning referenced
 * `projects["C:/Code/audit-tools"].hasTrustDialogAccepted` on win32). Trailing
 * separators are stripped so the key matches the CLI's cwd-derived form.
 */
export function claudeWorkerTrustProjectKey(repoRoot: string): string {
  const forward = repoRoot.trim().replace(/\\/g, "/");
  return forward.length > 1 ? forward.replace(/\/+$/u, "") : forward;
}

/** A filesystem-safe stem for the per-launch isolated config dir. */
function sanitizeForDirName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-");
}

function requireNonEmpty(
  value: string | undefined,
  field: "endpoint" | "backend_provider" | "model",
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `claude-worker provider requires a non-empty ${field} — the source carries it ` +
        `({endpoint: <repair-proxy url>, backend_provider, model}); an isolated spawn ` +
        `with no proxy ${field === "endpoint" ? "endpoint" : "route"} must be impossible.`,
    );
  }
  return value.trim();
}

/**
 * claude-worker backend — the proxied, ISOLATED, per-packet-routed Claude-harness
 * worker (the kind-1 launch transport,
 * docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md). It spawns
 * `claude -p` with a REQUIRED `ANTHROPIC_BASE_URL` overlay pointing at the
 * repair-proxy, a dummy `ANTHROPIC_API_KEY` (never the ambient real key), an
 * isolated per-launch `CLAUDE_CONFIG_DIR`, and `--model
 * <backend_provider>/<model>` — the namespace string the proxy routes on,
 * composed at launch for argv only (it never enters the quota identity).
 *
 * Deliberately NO nested-session guard: this class is NOT `claude-code` (the
 * conversation host) wearing a flag — isolation is its CONSTRUCTOR INVARIANT, not
 * a guard exception. Construction throws unless endpoint/backend_provider/model
 * are present, so every spawn is proxy-fronted with a scrubbed parent env
 * (spawnLoggedCommand strips `CLAUDECODE`/`CLAUDE_CODE*`; `CLAUDE_CONFIG_DIR`
 * survives the scrub and is overlaid per launch) and can safely run from inside a
 * live Claude Code session. The `claude-code` host provider KEEPS its blanket
 * guard, and all four in-session refusal layers key on `claude-code` and never
 * see this name — no guard is refined for this class to exist.
 */
export class ClaudeWorkerProvider implements FreshSessionProvider {
  name = CLAUDE_WORKER_PROVIDER_NAME;
  private readonly config: ClaudeWorkerConfig;
  private readonly endpoint: string;
  private readonly backendProvider: string;
  private readonly model: string;
  private readonly launchCommand: typeof spawnLoggedCommand;
  private readonly skipPermissionsDefault: boolean;

  constructor(
    config: ClaudeWorkerConfig = {},
    options: ClaudeWorkerProviderOptions = {},
    launchCommand: typeof spawnLoggedCommand = spawnLoggedCommand,
  ) {
    this.config = config;
    this.endpoint = requireNonEmpty(config.endpoint, "endpoint");
    this.backendProvider = requireNonEmpty(
      config.backend_provider,
      "backend_provider",
    );
    this.model = requireNonEmpty(config.model, "model");
    this.launchCommand = launchCommand;
    this.skipPermissionsDefault = options.skipPermissionsDefault ?? false;
  }

  /**
   * Create the per-launch isolated `CLAUDE_CONFIG_DIR` and mechanically pre-seed
   * trust for the node's repo root, so the spawned harness never stalls on the
   * interactive trust dialog (tool-enforced, never host-remembered).
   */
  private async prepareIsolatedConfigDir(
    input: LaunchFreshSessionInput,
  ): Promise<string> {
    const configDir = join(
      tmpdir(),
      "audit-tools-claude-worker",
      `${sanitizeForDirName(input.runId)}-${randomUUID()}`,
    );
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, ".claude.json"),
      JSON.stringify({
        projects: {
          [claudeWorkerTrustProjectKey(input.repoRoot)]: {
            hasTrustDialogAccepted: true,
          },
        },
      }),
      "utf8",
    );
    return configDir;
  }

  async launch(input: LaunchFreshSessionInput) {
    const prompt = await readFile(input.promptPath, "utf8");
    const task = await readJsonFile<WorkerTaskWithCommand>(input.taskPath);
    const command = this.config.command ?? "claude";
    const promptFlag = this.config.prompt_flag ?? "-p";
    const skipPermissions =
      this.config.dangerously_skip_permissions ?? this.skipPermissionsDefault;
    // The prompt is delivered via stdin (mirrors ClaudeCodeProvider), so
    // `promptFlag` is a bare flag; `--model` carries the proxy's namespace
    // routing key `<backend_provider>/<model>`, passed VERBATIM to the endpoint.
    const args = [
      promptFlag,
      "--model",
      `${this.backendProvider}/${this.model}`,
      ...(this.config.extra_args ?? []),
      ...(skipPermissions ? ["--dangerously-skip-permissions"] : []),
    ];
    const configDir = await this.prepareIsolatedConfigDir(input);
    emitProviderLaunchDiagnostic(this.name, input);
    try {
      const result = await this.launchCommand(
        command,
        args,
        {
          ...applyWorkerTaskLaunchSettings(input, task),
          stdinText: prompt,
        },
        // spawnLoggedCommand merges this overlay over process.env, THEN scrubs
        // CLAUDECODE/CLAUDE_CODE* — CLAUDE_CONFIG_DIR survives the scrub (prefix
        // is CLAUDE_CONF), so the child sees exactly this isolated dir.
        {
          ANTHROPIC_BASE_URL: this.endpoint,
          ANTHROPIC_API_KEY: CLAUDE_WORKER_DUMMY_API_KEY,
          CLAUDE_CONFIG_DIR: configDir,
        },
      );
      emitProviderDoneDiagnostic(this.name, input, result);
      return result;
    } finally {
      // Best-effort cleanup of the per-launch config dir — a cleanup failure
      // must never fail (or mask) the launch result.
      await rm(configDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
