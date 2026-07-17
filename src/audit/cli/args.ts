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
  auditArtifactsDir,
  resolveRepoRoot,
  resolveHostDispatchCapability as sharedResolveHostDispatchCapability,
  assertHostProviderName,
  validateSessionConfig,
  formatValidationIssues,
  type ProviderName,
  type SessionConfig,
  type DispatchableSource,
  type AuditorDescriptor,
  type AuditorSelf,
} from "audit-tools/shared";
import { resolveFreshSessionProviderName } from "../providers/index.js";

export const DIRECT_CLI_DEFAULTS = {
  rootDir: ".",
  // Sentinel marking "no explicit --artifacts-dir". When this is the resolved
  // value, getArtifactsDir rebases the default onto --root via the shared
  // auditArtifactsDir() helper rather than resolving the literal against CWD —
  // so `--root <X>` with no --artifacts-dir lands under <X>/.audit-tools/audit.
  artifactsDir: ".audit-tools/audit",
  timeoutMs: 30 * 60 * 1000, // 30 minutes
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
  // Single-sourced in shared so audit and remediate can't drift; audit supplies its
  // own env var name.
  return sharedResolveHostDispatchCapability({
    explicit: options.explicit,
    sessionConfig: options.sessionConfig,
    envVarName: "AUDIT_CODE_HOST_CAN_DISPATCH",
    env: options.env,
  });
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

export function taskResultPath(taskResultsDir: string, taskId: string): string {
  return join(taskResultsDir, artifactNameForId(taskId, "json"));
}

// Canonical result filenames produced by artifactNameForId: a stem, "_", a
// 12-hex sha256 digest, then ".json" — optionally with one extra suffix segment
// before ".json" (the host writes packet results as "<stem>_<digest>.inline-result.json").
const CANONICAL_RESULT_FILENAME = /_[0-9a-f]{12}(\.[a-z0-9-]+)?\.json$/i;

// True when `filename` matches the canonical result naming above. Lets
// merge-and-ingest tell legitimate packet / prior-round results apart from
// genuinely stray files (e.g. packet-23-results.json) left in task-results/.
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

export function getRootDir(argv: string[]): string {
  // Anchor the repo root away from a drifted cwd (never trust bare `--root .`):
  // resolveRepoRoot climbs out of any `.audit-tools/` and re-anchors to the
  // existing run's root / git toplevel. See src/shared/io/repoRoot.ts.
  return resolveRepoRoot(getFlag(argv, "--root", DIRECT_CLI_DEFAULTS.rootDir) as string);
}

/**
 * Resolve the artifacts dir. An explicit `--artifacts-dir` is honored verbatim
 * (resolved against CWD). With NO `--artifacts-dir`, the default rebases onto
 * `--root` via the shared `auditArtifactsDir()` helper — so `--root <X>` lands
 * the default under `<X>/.audit-tools/audit`. Previously the default resolved
 * the `.audit-tools/audit` literal against CWD independently of `--root`, so a
 * bare `--root <X>` silently ignored `<X>` (the latent bug fixed here).
 */
export function getArtifactsDir(argv: string[]): string {
  const explicit = getFlag(argv, "--artifacts-dir");
  if (explicit !== undefined) {
    return resolve(explicit);
  }
  return auditArtifactsDir(getRootDir(argv));
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

/**
 * B1: explicit conversation-host provider override (`--host-provider`). Names the
 * auditor actually DRIVING this run, whose account meter the dispatch fan-out is
 * charged to — a quota-ATTRIBUTION key, distinct from `--provider` (which may name
 * a demoted headless backend that is only the per-packet worker). Normally left
 * unset: the host is auto-detected from the run's own session env. Constrained to
 * a known ProviderName so a typo fails LOUDLY here rather than silently mis-keying.
 */
export function getHostProvider(argv: string[]): ProviderName | null {
  const value = getFlag(argv, "--host-provider");
  if (value === undefined) return null;
  assertHostProviderName(value);
  return value;
}

export function getHostModel(argv: string[]): string | null {
  return getFlag(argv, "--host-model") ?? null;
}

/**
 * Parse the current driver's dispatch-capability handshake, carried as ONE
 * `--auditor <json>` flag (G1 collapsed the former N `--host-*` scalar flags onto
 * `descriptor.self`; G2 folded the driver's provider identity + own host/IDE launch
 * blocks onto `self` and resliced the per-backend dispatch blocks to a top-level
 * `sources[]`). Malformed JSON or a non-object throws loudly so a mistyped handshake
 * fails here rather than silently downgrading. `null` when the flag is absent.
 * [[capability-is-per-auditor-not-per-audit]] [[unified-dispatch-worker-model]]
 */
export function getAuditorDescriptor(argv: string[]): AuditorDescriptor | null {
  const raw = getFlag(argv, "--auditor");
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--auditor must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--auditor must be a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;
  const rawSelf =
    obj.self && typeof obj.self === "object" && !Array.isArray(obj.self)
      ? (obj.self as Record<string, unknown>)
      : {};
  // Validate each `self` field to exactly the strictness the retired `--host-*`
  // parsers enforced, so the `--auditor` transport is a faithful collapse — not a
  // validation downgrade. The roster is re-validated through the SAME shared
  // `parseHostModelRoster` the `--host-models` flag used (loud throw on a malformed
  // roster: a mistyped handshake fails at the CLI boundary, never silently deep in
  // dispatch budget resolution). Scalars mirror `parsePositiveIntegerFlag`
  // (silent-drop of a non-positive-int, resolving to the conservative default);
  // booleans/model_id mirror their old parsers (drop a non-boolean / blank id).
  const self: AuditorSelf = {};
  // `self.provider` is the driver's identity + quota-attribution key: a mistyped
  // value would mis-charge dispatch fan-out to the wrong account, so it throws
  // loudly here (same strictness as the retired `--host-provider` parser).
  if (rawSelf.provider !== undefined) {
    if (typeof rawSelf.provider !== "string") {
      throw new Error("--auditor `self.provider` must be a string.");
    }
    assertHostProviderName(rawSelf.provider);
    self.provider = rawSelf.provider;
  }
  if (typeof rawSelf.model_id === "string" && rawSelf.model_id.trim().length > 0) {
    self.model_id = rawSelf.model_id.trim();
  }
  if (rawSelf.roster !== undefined) {
    self.roster = parseHostModelRoster(JSON.stringify(rawSelf.roster));
  }
  const contextTokens = normalizePositiveInteger(rawSelf.context_tokens);
  if (contextTokens !== undefined) self.context_tokens = contextTokens;
  const outputTokens = normalizePositiveInteger(rawSelf.output_tokens);
  if (outputTokens !== undefined) self.output_tokens = outputTokens;
  const maxActiveSubagents = normalizePositiveInteger(rawSelf.max_active_subagents);
  if (maxActiveSubagents !== undefined) self.max_active_subagents = maxActiveSubagents;
  const parallelWorkers = normalizePositiveInteger(rawSelf.parallel_workers);
  if (parallelWorkers !== undefined) self.parallel_workers = parallelWorkers;
  if (typeof rawSelf.can_dispatch_subagents === "boolean") {
    self.can_dispatch_subagents = rawSelf.can_dispatch_subagents;
  }
  if (typeof rawSelf.can_restrict_subagent_tools === "boolean") {
    self.can_restrict_subagent_tools = rawSelf.can_restrict_subagent_tools;
  }
  if (typeof rawSelf.can_select_subagent_model === "boolean") {
    self.can_select_subagent_model = rawSelf.can_select_subagent_model;
  }
  if (typeof rawSelf.proxy_transport === "boolean") {
    self.proxy_transport = rawSelf.proxy_transport;
  }
  // The driver's OWN launch transport (only the host/IDE providers that are NOT
  // generic dispatchable sources). Passed through structurally like the retired
  // inventory blocks; deep-validated downstream by the session-config validator when
  // resolved. A non-object is dropped rather than throwing (mirrors the old
  // pass-through), since these are optional operator tuning, not identity keys.
  for (const key of ["claude_code", "vscode_task", "antigravity"] as const) {
    const block = rawSelf[key];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      (self as Record<string, unknown>)[key] = block;
    }
  }
  const rawSources = obj.sources;
  if (
    rawSources !== undefined &&
    rawSources !== null &&
    !Array.isArray(rawSources)
  ) {
    throw new Error("--auditor `sources` must be a JSON array.");
  }
  const sources: DispatchableSource[] | undefined = Array.isArray(rawSources)
    ? (rawSources as DispatchableSource[])
    : undefined;
  // Validate the descriptor's DISPATCH content through the SAME shape/injection checks
  // the disk-load boundary applies (`validateSessionConfig`): descriptor `sources` +
  // launch blocks are host-supplied and must be mechanically validated, never trusted
  // (auditor-agnostic robustness — the descriptor is now the channel that carries what
  // the repo config used to). A malformed source `quota` (the C1 over-sizing guard) or a
  // command-injection-shaped launch command fails HERE at the parse boundary, not deep in
  // dispatch. `provider` is left unset for this check so a launch-block source does not
  // trip the "required section" validation. Errors throw; warnings are not surfaced here
  // (a descriptor cannot be persisted, so there is nothing durable to flag).
  const descriptorDispatchErrors = validateSessionConfig({
    ...(sources !== undefined ? { sources } : {}),
    ...(self.claude_code ? { claude_code: self.claude_code } : {}),
    ...(self.vscode_task ? { vscode_task: self.vscode_task } : {}),
    ...(self.antigravity ? { antigravity: self.antigravity } : {}),
  }).filter((issue) => issue.severity === "error");
  if (descriptorDispatchErrors.length > 0) {
    throw new Error(
      `--auditor descriptor is invalid:\n${formatValidationIssues(descriptorDispatchErrors).replace(/^ {2}/gm, "- ")}`,
    );
  }
  return {
    ...(typeof obj.auditor_id === "string" ? { auditor_id: obj.auditor_id } : {}),
    ...(typeof obj.resolved_at === "number" ? { resolved_at: obj.resolved_at } : {}),
    self,
    ...(sources !== undefined ? { sources } : {}),
  };
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
  // Admit ONLY canonical result filenames (<stem>_<digest>[.suffix].json). A
  // bare `*.json` filter would ingest any stray JSON co-located in the dir — a
  // session-config, a schema pointer, an editor scratch file — as if it were an
  // audit result. The canonical-name gate is the same one merge-and-ingest uses
  // to tell real result files apart from spurious ones.
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".json") &&
        isCanonicalResultFilename(entry.name),
    )
    .map((entry) => join(batchDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(
      `No canonical audit result files (<stem>_<digest>.json) found in ${batchDir}.`,
    );
  }

  return files;
}
