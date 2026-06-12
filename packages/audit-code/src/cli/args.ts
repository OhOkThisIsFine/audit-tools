import { existsSync, createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import {
  renderPromptCommand,
  toPromptPathToken,
  quotePromptCommandArg,
  parseHostModelRoster,
  type SessionConfig,
  type HostModelRosterEntry,
} from "@audit-tools/shared";
import { resolveFreshSessionProviderName } from "../providers/index.js";

export type UiMode = "visible" | "headless";

export const DIRECT_CLI_DEFAULTS = {
  rootDir: ".",
  artifactsDir: ".audit-tools/audit",
  maxRuns: 1000,
  agentBatchSize: 6,
  parallelWorkers: 1,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
  uiMode: "headless" as UiMode,
};

function isLongFlagToken(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith("--");
}

export function getFlag(
  argv: string[],
  name: string,
  fallback?: string,
): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const candidate = argv[index + 1];
  if (!candidate || isLongFlagToken(candidate)) return fallback;
  return candidate;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function getOptionalBooleanFlag(
  argv: string[],
  name: string,
): boolean | undefined {
  const raw = getFlag(argv, name);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`${name} must be either true or false.`);
}

export function optionalBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function resolveHostDispatchCapability(options: {
  explicit?: boolean;
  sessionConfig: SessionConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (options.explicit !== undefined) {
    return options.explicit;
  }
  if (options.sessionConfig.host_can_dispatch_subagents !== undefined) {
    return options.sessionConfig.host_can_dispatch_subagents;
  }
  return optionalBooleanEnv(
    (options.env ?? process.env).AUDIT_CODE_HOST_CAN_DISPATCH,
  ) ?? true;
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function digestId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function safeArtifactStem(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : "artifact";
}

export function artifactNameForId(value: string, extension: string): string {
  return `${safeArtifactStem(value)}_${digestId(value)}.${extension}`;
}

export const quoteCommandArg = quotePromptCommandArg;

/**
 * Normalize a generated command token to POSIX path separators. These command
 * strings are embedded in step prompts and `allowed_commands` and run by the
 * host — often through a bash-like shell, which treats `\` as an escape and
 * silently corrupts Windows absolute paths (`node C:\a\b.mjs` collapses to
 * `node C:ab.mjs`). Node accepts forward slashes on Windows, and `/` survives
 * bash, PowerShell, and cmd alike. Only tokens that actually carry a backslash
 * are touched, and no non-path argument in this CLI contains one, so this is a
 * targeted normalization rather than a blanket rewrite.
 */
export const toPosixCommandToken = toPromptPathToken;

export function renderCommand(argv: string[]): string {
  return renderPromptCommand(argv);
}

export function summarizeLaunchExit(result: {
  accepted?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  command?: string;
  stdoutPath?: string;
  stderrPath?: string;
  error?: string;
}): string | null {
  if (result.accepted !== false && !result.error) {
    return null;
  }
  const parts = [
    result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.exitCode ?? "unknown"}`,
    result.command ? `command: ${result.command}` : null,
    result.stdoutPath ? `stdout: ${result.stdoutPath}` : null,
    result.stderrPath ? `stderr: ${result.stderrPath}` : null,
    result.error ?? null,
  ].filter((part): part is string => Boolean(part));
  return parts.join("; ");
}

export function taskResultPath(taskResultsDir: string, taskId: string): string {
  return join(taskResultsDir, artifactNameForId(taskId, "json"));
}

const CANONICAL_RESULT_FILENAME = /_[0-9a-f]{12}\.json$/i;

// True when `filename` matches the canonical per-task result naming produced by
// artifactNameForId (stem + "_" + 12-hex sha256 digest + ".json"). Lets
// merge-and-ingest tell legitimate prior-round results apart from genuinely
// stray files (e.g. packet-23-results.json) left in task-results/.
export function isCanonicalResultFilename(filename: string): boolean {
  return CANONICAL_RESULT_FILENAME.test(filename);
}

export function packetPromptPath(taskResultsDir: string, packetId: string): string {
  return join(taskResultsDir, artifactNameForId(packetId, "prompt.md"));
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return await new Promise((resolveInput, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolveInput(input));
    process.stdin.on("error", reject);
  });
}

function resolveFlagPath(
  argv: string[],
  name: string,
  fallback: string,
): string {
  return resolve(getFlag(argv, name, fallback) as string);
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function parsePositiveIntegerFlag(
  argv: string[],
  name: string,
): number | undefined {
  const raw = getFlag(argv, name);
  if (raw === undefined) {
    return undefined;
  }
  return normalizePositiveInteger(Number(raw));
}

export function getArtifactsDir(argv: string[]): string {
  return resolveFlagPath(
    argv,
    "--artifacts-dir",
    DIRECT_CLI_DEFAULTS.artifactsDir,
  );
}

export function getRootDir(argv: string[]): string {
  return resolveFlagPath(argv, "--root", DIRECT_CLI_DEFAULTS.rootDir);
}

export function warnIfNotGitRepo(root: string): void {
  const gitEntry = join(root, ".git");
  if (!existsSync(gitEntry)) {
    console.warn(
      `Warning: target directory '${root}' does not appear to be a git repository. Diff-based signals will be unavailable.`,
    );
  }
}

export function getBatchResultsDir(argv: string[]): string | undefined {
  const value = getFlag(argv, "--batch-results");
  return value ? resolve(value) : undefined;
}

export function getMaxRuns(argv: string[]): number {
  return parsePositiveIntegerFlag(argv, "--max-runs") ?? DIRECT_CLI_DEFAULTS.maxRuns;
}

export function getAgentBatchSize(argv: string[], sessionConfig: SessionConfig): number {
  return (
    parsePositiveIntegerFlag(argv, "--agent-batch-size") ??
    normalizePositiveInteger(sessionConfig.agent_task_batch_size) ??
    DIRECT_CLI_DEFAULTS.agentBatchSize
  );
}

export function getParallelWorkers(argv: string[], sessionConfig: SessionConfig): number {
  return (
    parsePositiveIntegerFlag(argv, "--parallel") ??
    normalizePositiveInteger(sessionConfig.parallel_workers) ??
    DIRECT_CLI_DEFAULTS.parallelWorkers
  );
}

export function getTimeoutMs(argv: string[], sessionConfig: SessionConfig): number {
  return (
    parsePositiveIntegerFlag(argv, "--timeout") ??
    normalizePositiveInteger(sessionConfig.timeout_ms) ??
    DIRECT_CLI_DEFAULTS.timeoutMs
  );
}

export function getExplicitProvider(argv: string[]): string | undefined {
  return getFlag(argv, "--provider");
}

export function getHostModel(argv: string[]): string | null {
  return getFlag(argv, "--host-model") ?? null;
}

export function getHostMaxActiveSubagents(argv: string[]): number | null {
  return parsePositiveIntegerFlag(argv, "--host-max-active-subagents") ?? null;
}

/**
 * Context window (input tokens) the host reports for the model it will dispatch
 * subagents to — the dispatch-time capability handshake. Outranks the static
 * model table when sizing packets, so the partition fills the real model's
 * window instead of the conservative 32k default.
 */
export function getHostContextTokens(argv: string[]): number | null {
  return parsePositiveIntegerFlag(argv, "--host-context-tokens") ?? null;
}

/** Output-token cap the host reports for its dispatch model (handshake). */
export function getHostOutputTokens(argv: string[]): number | null {
  return parsePositiveIntegerFlag(argv, "--host-output-tokens") ?? null;
}

/**
 * Ordered model roster the host reports at the dispatch handshake
 * (`--host-models`, JSON array, lowest rank first) — the multi-rank
 * generalization of the scalar `--host-context-tokens`/`--host-output-tokens`
 * pair. `rank` values are RELATIVE labels (`small`/`standard`/`deep`) aligned
 * with `model_hint.tier`; windows are discovered, never guessed, and the host
 * never names a model. Malformed input throws (shared parser) so a mistyped
 * handshake fails loudly instead of silently downgrading to the floor.
 */
export function getHostModelRoster(
  argv: string[],
): HostModelRosterEntry[] | null {
  const raw = getFlag(argv, "--host-models");
  return raw ? parseHostModelRoster(raw) : null;
}

/**
 * Opaque model identity the host reports for its dispatch model
 * (`--host-model-id`). Used ONLY as a quota-key segment so quota learning keys
 * on `provider/<id>` instead of `provider/*` when no model name is resolvable —
 * never a window authority, never matched against a name table.
 */
export function getHostModelId(argv: string[]): string | null {
  const value = getFlag(argv, "--host-model-id");
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function resolveRunProviderName(
  argv: string[],
  sessionConfig: SessionConfig,
): string {
  return resolveFreshSessionProviderName(
    getExplicitProvider(argv),
    sessionConfig,
  );
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunkSize = normalizePositiveInteger(size);
  if (chunkSize === undefined) {
    throw new Error("chunkArray size must be a positive integer.");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

export function getUiMode(
  argv: string[],
  fallback: UiMode = DIRECT_CLI_DEFAULTS.uiMode,
): UiMode {
  const raw = getFlag(argv, "--ui");
  if (raw === "visible") return "visible";
  if (raw === "headless") return "headless";
  return fallback;
}

export function looksLikeCliFlag(value: string | undefined): boolean {
  return isLongFlagToken(value);
}

export async function countLines(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lines = 0;
    let byteCount = 0;
    let lastByte = -1;
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteCount += buffer.length;
      for (let i = 0; i < buffer.length; ++i) {
        if (buffer[i] === 10) lines++;
        lastByte = buffer[i];
      }
    });
    stream.on("end", () => {
      if (byteCount === 0) return resolve(0);
      resolve(lastByte !== 10 ? lines + 1 : lines);
    });
    stream.on("error", reject);
  });
}

export async function listBatchResultFiles(batchDir: string): Promise<string[]> {
  const entries = await readdir(batchDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(batchDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No JSON audit result files found in ${batchDir}.`);
  }

  return files;
}
