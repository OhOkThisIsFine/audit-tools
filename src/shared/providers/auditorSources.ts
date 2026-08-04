import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type DispatchableSource,
  laneWorkerKindConflict,
} from "../types/sessionConfig.js";
import { resolveAuditCodeStateDir } from "../io/stateDir.js";
import { spawnSyncHidden } from "../tooling/exec.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";
import { commandExists } from "./providerPathGuard.js";

/**
 * The machine-level declaration file: the backends the OPERATOR owns, hand-authored
 * like `session-config.json`. Deliberately NOT id-keyed: each invocation intersects
 * the declaration with its own ambient reach instead of inheriting another
 * auditor's resolved capability.
 *
 * A declaration is not a cache: it is operator INTENT, not a prior auditor's resolved
 * state. Reading it and intersecting it with live ambient reach does not inherit
 * anything ([[capability-is-per-auditor-not-per-audit]]).
 */
export const SOURCE_DECLARATION_FILENAME = "sources-declared.json";


/** A declared source that did NOT survive the ambient-reach intersection. */
export interface DroppedSource {
  /** The source's declared id, or its derived `${transport}:${model ?? endpoint}` fallback. */
  id: string;
  /** Operator-facing explanation — always says what to fix. */
  reason: string;
}

/** The outcome of `declared ∩ ambient-verifiable`. */
export interface ResolvedSourceSet {
  /** Sources this process PROVED it can reach. */
  sources: DispatchableSource[];
  /** Declared-but-unreachable sources, each with a reason. Never silently discarded. */
  dropped: DroppedSource[];
}

/** Injectable ambient probes — the whole environment this module reads. */
export interface AmbientSourceDeps {
  /** Env snapshot. MUST be the env the provider will read at launch (see `resolveAmbientSources`). */
  env?: NodeJS.ProcessEnv;
  /** PATH probe; defaults to the shared `commandExists`. */
  commandExists?: (command: string) => boolean;
  /** File-readable probe; defaults to a real `access(R_OK)`. */
  fileReadable?: (path: string) => boolean;
  /** Home dir; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Raw declaration reader (tests inject); defaults to reading the declaration file. */
  readDeclarationFile?: (path: string) => string | null;
  /**
   * HTTP liveness probe for endpoint-shaped lanes (the proxy). Deliberately
   * SYNC — resolve stays cheap and synchronous (populate is where the network
   * lives); the default shells escalating-budget probes (`GET <endpoint>/health/liveliness`
   * then `GET <endpoint>/v1/models` fallback) through a hidden node child. Tests inject.
   */
  probeHttpReachable?: (url: string) => boolean;
}

/**
 * Default launcher command per CLI-backed dispatchable source, mirroring each
 * provider's own `config.command ?? "<default>"` fallback (`codexProvider.ts:59`,
 * `opencodeProvider.ts:58`, `agyProvider.ts:67-69`). A source overrides it via
 * `endpoint`, which IS the launcher command for CLI providers
 * (`DispatchableSource.endpoint` docs, `sessionConfig.ts`).
 */
const CLI_DEFAULT_COMMAND: Readonly<Record<string, string>> = {
  codex: "codex",
  opencode: "opencode",
  agy: "agy",
};

/** Gated for the 2026-07-18 agy sunset: `agy` falls back to a legacy `gemini` binary. */
const AGY_LEGACY_COMMAND = "gemini";

function defaultFileReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultReadDeclarationFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Escalating-budget reachability: try `probeOnce` at each budget in order, returning
 * true on the first success. The retry (not the spawn) is the load-bearing property —
 * a healthy lane must survive a slow first attempt — so it is factored out here to be
 * unit-testable without spawning. `budgets` is ordered small→large so the common warm
 * case exits on the first, cheap attempt. Two bounded attempts with escalating budgets:
 * a healthy declared lane must NOT be dropped on a single cold probe. Warm, a proxy's
 * `/health/liveliness` answers in ~25ms; a COLD proxy whose model catalog is being
 * (re)built can exceed a short budget, so a second, longer (4s) attempt covers it.
 * A genuinely-dead endpoint costs both budgets once, at run start, for one lane —
 * acceptable.
 */
export function probeReachableWithEscalation(
  probeOnce: (budgetMs: number) => boolean,
  budgets: readonly number[] = [1_000, 4_000],
): boolean {
  for (const budgetMs of budgets) {
    if (probeOnce(budgetMs)) return true;
  }
  return false;
}

/**
 * Build liveness URLs for both ordinary OpenAI-compatible bases and proxies
 * whose API base is `/v1` but whose health endpoint is served at the origin.
 */
export function buildLivenessProbeUrls(url: string): string[] {
  const base = url.replace(/\/+$/u, "");
  try {
    const parsed = new URL(base);
    const path = parsed.pathname.replace(/\/+$/u, "");
    const origin = parsed.origin;
    const root = path.toLowerCase().endsWith("/v1")
      ? `${origin}${path.slice(0, -3)}`.replace(/\/+$/u, "")
      : origin;
    return [
      `${base}/health/liveliness`,
      `${base}/models`,
      `${root}/health/liveliness`,
      `${root}/health`,
      `${root}/v1/models`,
    ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  } catch {
    return [`${base}/health/liveliness`, `${base}/models`];
  }
}

function defaultProbeHttpReachable(url: string): boolean {
  // Neutral proxy contract liveness: any HTTP response proves the listener is
  // alive, including a 401 from a keyed proxy. Try the API base first, then
  // origin-level health/model routes for proxies that mount health outside /v1.
  const probeOnce = (budgetMs: number, targetUrl: string): boolean => {
    const script =
      "const [url, ms] = process.argv.slice(1);" +
      "fetch(url, { signal: AbortSignal.timeout(Number(ms)) })" +
      ".then((r) => process.exit(0), () => process.exit(1));";
    const result = spawnSyncHidden(process.execPath, ["-e", script, targetUrl, String(budgetMs)], {
      timeout: budgetMs + 1_500,
    });
    return result.status === 0;
  };

  for (const budgetMs of [1_000, 4_000]) {
    for (const candidate of buildLivenessProbeUrls(url)) {
      if (probeOnce(budgetMs, candidate)) return true;
    }
  }
  return false;
}

/** The source's stable id, matching `DispatchableSource.id`'s documented default. */
function sourceId(source: DispatchableSource): string {
  return source.id ?? `${source.transport}:${source.model ?? source.endpoint ?? "?"}`;
}

/** Resolve the declaration file path for this machine (state dir via `io/stateDir.ts`). */
export function resolveSourceDeclarationPath(homeDir?: string): string {
  return join(resolveAuditCodeStateDir(homeDir), SOURCE_DECLARATION_FILENAME);
}

/**
 * Read the operator's machine-level source declaration.
 *
 * Degrades to `[]` on absent / unparseable / structurally-invalid input — never
 * throws. This read sits on the path of every `next-step`, so a malformed file must
 * not be able to fail a run (the two-tier dependency policy's "wrap the parser so
 * malformed input degrades to empty"). Validation reuses `validateSessionConfig`, so
 * the declaration is held to exactly the same bar as a `--auditor sources[]`.
 */
export function readSourceDeclaration(
  deps: AmbientSourceDeps = {},
): DispatchableSource[] {
  const path = resolveSourceDeclarationPath(deps.homeDir);
  const raw = (deps.readDeclarationFile ?? defaultReadDeclarationFile)(path);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const sources = (parsed as { sources?: unknown }).sources;
  if (sources === undefined) return [];
  // Hold the declaration to the same validator both other boundaries use. Any
  // error-severity issue ⇒ degrade to empty rather than admit a half-checked pool.
  const issues = validateSessionConfig({ sources });
  if (issues.some((issue) => issue.severity === "error")) return [];
  return sources as DispatchableSource[];
}

/**
 * `api_key_env` names an environment VARIABLE; it never carries the value. A
 * declaration that pastes `NAME=value` (or the secret itself) used to be
 * accepted verbatim by every reader and then reported as `unset var
 * "NAME=value"` — which reads as a missing env var and sends the operator to
 * their shell instead of to the typo.
 *
 * The check belongs to the FIELD, not to one of its readers: both endpoint-backed
 * source transports must reject the typo with the same precise explanation.
 * Returns a precise reason, or `null` when the name is well formed. Reach
 * branches call {@link apiKeyEnvReachReason}, which pairs this with the
 * env-is-set half. [[validator-guards-every-field-caller-reads]]
 */
export function invalidEnvVarNameReason(field: string, value: string): string | null {
  const name = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  return (
    `${field} "${name}" is not an environment variable NAME` +
    (value.includes("=")
      ? " — it looks like a NAME=value pair; declare only the NAME (the value belongs in the environment)."
      : " (expected letters, digits and underscores, not starting with a digit).")
  );
}

/**
 * The whole `api_key_env` reach rule in ONE place: the declared string must be a
 * well-formed variable NAME, and that variable must be set and non-empty in this
 * process. Returns the refusal reason, or `null` when the field proves reach.
 *
 * Every reach branch that reads `api_key_env` calls this. Copying the two checks
 * per transport is what let the `claude-worker` proxy lane keep reporting a
 * `NAME=value` typo as an unset variable long after the `openai-compatible`
 * branch was fixed. [[validator-guards-every-field-caller-reads]]
 */
function apiKeyEnvReachReason(
  apiKeyEnv: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const bad = invalidEnvVarNameReason("api_key_env", apiKeyEnv);
  if (bad !== null) return bad;
  if (!(env[apiKeyEnv.trim()] ?? "").trim()) {
    return `env var "${apiKeyEnv.trim()}" is unset or empty in this process.`;
  }
  return null;
}

/**
 * Can THIS process prove it can reach this declared source?
 *
 * The spec's rule is `declared ∩ ambient-verifiable-by-this-process` — a declared lane
 * enters the pool only if this process PROVES reach, never `declared ∪ stored`. Each
 * check verifies what the declaration actually asserts:
 *
 * - `api_key_env` → the env var is present and non-empty (and is a NAME, not `NAME=value`)
 * - `no_auth: true` → the endpoint answers a liveness probe (see below)
 * - CLI provider → its launcher resolves on PATH
 * - `subprocess-template` → its `command_template[0]` resolves on PATH
 * - `credentials_path` → the file is readable
 *
 * **`no_auth: true` is not an opt-out.** It swaps one PROOF for another — the env-var
 * check for an endpoint liveness probe — so a keyless lane is still verified, not
 * merely asserted. It must be declared explicitly rather than inferred from a missing
 * `api_key_env`, because the probe treats any HTTP status as alive (a 401 proves the
 * endpoint is listening), so inferring it would silently admit a keyed endpoint whose
 * key the operator forgot.
 *
 * **There is no inline-`api_key` case to refuse here — the field is RETIRED**, and a
 * credential is named (`api_key_env`) or absent. It used to be refused at this gate:
 * possession proves nothing about reach, and it was the one shape an operator could
 * always choose, which made the whole rule opt-out by construction. Refusing a shape
 * that can still be declared leaves an always-passes lane whose only catcher (the
 * reactive `lies reachably` quarantine) does not exist; deleting the shape closes it
 * at the source. The declaration is now refused earlier and louder, at validation
 * (`validation/sessionConfig.ts`), so a pasted key can never reach this function.
 *
 * ⚠ That does NOT close the quarantine gap itself: a lane whose key was revoked or whose
 * endpoint died still verifies here (env var present, launcher on PATH) and is
 * re-admitted every run. That open property is tracked in `docs/backlog/open-bugs.md`.
 *
 * NOTE — this is the repo's first ambient CREDENTIAL probe, and it deliberately
 * inverts the policy stated at `providerFactory.ts` ("env presence is intentionally not
 * probed here"). That policy governs LAUNCH-TIME resolution; this is REACH declaration.
 * The two are different questions; see that comment's pointer back here.
 */
export function verifySourceReach(
  source: DispatchableSource,
  deps: AmbientSourceDeps = {},
): { verified: true } | { verified: false; reason: string } {
  const env = deps.env ?? process.env;
  const exists = deps.commandExists ?? commandExists;
  const readable = deps.fileReadable ?? defaultFileReadable;

  if (source.credentials_path !== undefined) {
    if (typeof source.credentials_path !== "string" || !readable(source.credentials_path)) {
      return {
        verified: false,
        reason: `credentials_path "${String(source.credentials_path)}" is not readable.`,
      };
    }
  }

  switch (source.transport) {
    case "openai-compatible": {
      if (!source.endpoint?.trim()) {
        return { verified: false, reason: "openai-compatible source has no endpoint (base_url)." };
      }
      if (!source.model?.trim()) {
        return { verified: false, reason: "openai-compatible source has no model." };
      }
      // Explicitly keyless: reach is the endpoint answering, not an env var — the
      // same bar the `claude-worker` proxy lane below already holds. Contradictory
      // declarations are refused rather than silently resolved.
      if (source.no_auth === true) {
        if (source.api_key_env !== undefined) {
          return {
            verified: false,
            reason:
              "source declares BOTH no_auth and api_key_env — pick one (no_auth means the endpoint takes no credential).",
          };
        }
        const noAuthProbe = deps.probeHttpReachable ?? defaultProbeHttpReachable;
        const noAuthEndpoint = source.endpoint.trim().replace(/\/+$/u, "");
        return noAuthProbe(noAuthEndpoint)
          ? { verified: true }
          : {
              verified: false,
              reason: `keyless endpoint "${noAuthEndpoint}" failed the liveness probe.`,
            };
      }
      if (!source.api_key_env?.trim()) {
        return {
          verified: false,
          reason:
            "openai-compatible source has no api_key_env (declare no_auth: true if the endpoint genuinely takes no credential).",
        };
      }
      const badKeyEnv = apiKeyEnvReachReason(source.api_key_env, env);
      if (badKeyEnv !== null) return { verified: false, reason: badKeyEnv };
      return { verified: true };
    }
    case "codex":
    case "opencode":
    case "agy": {
      const declared = source.endpoint?.trim();
      if (declared) {
        return exists(declared)
          ? { verified: true }
          : { verified: false, reason: `launcher "${declared}" is not on PATH.` };
      }
      const fallback = CLI_DEFAULT_COMMAND[source.transport];
      if (exists(fallback)) return { verified: true };
      // Gated for the 2026-07-18 sunset, mirroring agyProvider's own fallback.
      if (source.transport === "agy" && exists(AGY_LEGACY_COMMAND)) {
        return { verified: true };
      }
      return { verified: false, reason: `launcher "${fallback}" is not on PATH.` };
    }
    case "subprocess-template": {
      const template = source.parameters?.command_template;
      const launcher = Array.isArray(template) ? template[0] : undefined;
      if (typeof launcher !== "string" || !launcher.trim()) {
        return {
          verified: false,
          reason: "subprocess-template source has no parameters.command_template[0] to probe.",
        };
      }
      return exists(launcher)
        ? { verified: true }
        : { verified: false, reason: `launcher "${launcher}" is not on PATH.` };
    }
    case "worker-command": {
      // worker-command runs `task.worker_command` — a PER-TASK argv with no
      // source-level launcher, so there is nothing to probe ahead of dispatch.
      return {
        verified: false,
        reason:
          "worker-command reach is per-task (task.worker_command), so it is not declarable as an ambient source.",
      };
    }
    case "claude-worker": {
      // The proxied isolated Claude-harness worker: its reach IS the proxy's
      // liveness (endpoint = the proxy url). Explicit declarations are held to the
      // same bar as every other endpoint source. `api_key_env` is optional here.
      if (!source.endpoint?.trim()) {
        return {
          verified: false,
          reason: "claude-worker source has no endpoint (the proxy url).",
        };
      }
      if (!source.model?.trim()) {
        return { verified: false, reason: "claude-worker source has no model." };
      }
      // When api_key_env is declared, it is held to the SAME bar as every other
      // reader of the field — name shape included (see {@link apiKeyEnvReachReason}).
      if (source.api_key_env?.trim()) {
        const badProxyKeyEnv = apiKeyEnvReachReason(source.api_key_env, env);
        if (badProxyKeyEnv !== null) return { verified: false, reason: badProxyKeyEnv };
      }
      const probe = deps.probeHttpReachable ?? defaultProbeHttpReachable;
      const endpoint = source.endpoint.trim().replace(/\/+$/u, "");
      return probe(endpoint)
        ? { verified: true }
        : {
            verified: false,
            reason: `proxy at "${endpoint}" failed the liveness probe.`,
          };
    }
  }
}

/**
 * `declared ∩ ambient-verifiable` — the dispatch pool THIS process can actually reach.
 *
 * Resolved IN-PROCESS, never routed through the conversational host. That is a
 * correctness property, not an optimization: `openAiCompatibleProvider` reads its key
 * from `process.env` AT LAUNCH, so resolving here makes the reach check and the launch
 * read the SAME env — they cannot disagree. A host relay would open a gap between what
 * was promised and what is true at the moment of use (CLAUDE.md, *Auditor-agnostic
 * robustness*).
 *
 * It is also what makes concurrent multi-IDE runs safe with no identity machinery: each
 * IDE spawns its own audit-tools process, which inherits THAT IDE's env, so each
 * intersects the same machine-level declaration against its own real reach and gets its
 * own answer. Nothing is shared, so nothing can contaminate
 * ([[capability-is-per-auditor-not-per-audit]]).
 */
export function resolveAmbientSources(
  deps: AmbientSourceDeps = {},
): ResolvedSourceSet {
  const declared = readSourceDeclaration(deps);
  const sources: DispatchableSource[] = [];
  const dropped: DroppedSource[] = [];
  for (const source of declared) {
    const reach = verifySourceReach(source, deps);
    if (reach.verified) sources.push(source);
    else dropped.push({ id: sourceId(source), reason: reach.reason });
  }
  // Worker-kind × pool-class compatibility, applied ONCE over the assembled set so
  // all declared lanes are held to the same rule. Per-lane, so one
  // incompatible lane never costs the operator the rest of the pool (unlike a
  // validator error, which degrades the whole declaration).
  const compatible: DispatchableSource[] = [];
  for (const source of sources) {
    const conflict = laneWorkerKindConflict(source);
    if (conflict === null) compatible.push(source);
    else dropped.push({ id: sourceId(source), reason: conflict });
  }
  return { sources: compatible, dropped };
}
