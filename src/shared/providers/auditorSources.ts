import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type DispatchableSource,
  laneWorkerKindConflict,
} from "../types/sessionConfig.js";
import { resolveAuditCodeStateDir } from "../io/stateDir.js";
import { spawnSyncHidden } from "../tooling/exec.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";
import {
  populateProxyCatalog,
  readProxyCatalog,
  type PopulateProxyCatalogResult,
} from "./proxyCatalog.js";
import { commandExists } from "./providerPathGuard.js";

/**
 * The machine-level declaration file: the backends the OPERATOR owns, hand-authored
 * like `session-config.json`. Deliberately NOT id-keyed and deliberately NOT named
 * like the POPULATE cache (`catalog-cache.json`, `proxyCatalog.ts` — the
 * `catalog-<auditor-id>.json` name this comment once reserved landed WITHOUT the
 * auditor-id key; see the rationale there) — squatting the cache name would turn
 * this read into a direct cache read, violating never-inherit by filename collision.
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
  /** Raw populate-cache reader (tests inject); defaults to reading the cache file. */
  readCatalogFile?: (path: string) => string | null;
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

function defaultProbeHttpReachable(url: string): boolean {
  // Neutral proxy contract liveness: try /health/liveliness first (unauthenticated),
  // then fallback to /v1/models. On /v1/models, ANY HTTP status counts alive
  // (a 401 from a keyed proxy still proves it's listening).
  const probeOnce = (budgetMs: number, path: string): boolean => {
    const script =
      "const [url, ms] = process.argv.slice(1);" +
      "fetch(url, { signal: AbortSignal.timeout(Number(ms)) })" +
      ".then((r) => process.exit(0), () => process.exit(1));";
    const result = spawnSyncHidden(process.execPath, ["-e", script, `${url}${path}`, String(budgetMs)], {
      timeout: budgetMs + 1_500,
    });
    return result.status === 0;
  };

  for (const budgetMs of [1_000, 4_000]) {
    // Try /health/liveliness first (unauthenticated, guaranteed safe)
    if (probeOnce(budgetMs, "/health/liveliness")) return true;
    // Fallback to /v1/models (if /health/liveliness is absent)
    if (probeOnce(budgetMs, "/v1/models")) return true;
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
 * The declared proxy lane (`proxy` top-level key in the same declaration file):
 * the operator asserting "a generic OpenAI-compatible proxy listens here — discover
 * and expand its models into `claude-worker` sources". Optional knobs: `top_k`
 * (models per backend provider), `cost_per_mtok` (the free-to-operator cost axis;
 * wins over the advert price), and `api_key_env` (env var holding the proxy's master
 * key for authenticated endpoints).
 */
export interface ProxyDeclaration {
  endpoint: string;
  top_k?: number;
  cost_per_mtok?: number;
  api_key_env?: string;
  /**
   * The proxy's BACKEND burst-limits per model (see
   * `DispatchableSource.burst_limited`). Stamped onto every expanded lane at RESOLVE
   * time — declaration-authoritative, so flipping it never requires a re-populate —
   * where the worker-kind compatibility rule then refuses agentic expansion
   * ({@link laneWorkerKindConflict}) with a per-lane reason.
   */
  burst_limited?: boolean;
}

/** `readProxyDeclaration`'s outcome: the lane, or why it is absent. */
export interface ProxyDeclarationResult {
  declaration: ProxyDeclaration | null;
  /** Present only when a `proxy` key EXISTS but is malformed (never thrown). */
  reason?: string;
}

/**
 * Read the optional `proxy` block from the machine declaration. Tolerant like
 * {@link readSourceDeclaration}: an absent / unparseable file or a missing key is
 * simply `{declaration: null}`; a PRESENT-but-malformed block degrades to lane-absent
 * WITH a reason (surfaced via `resolveAmbientSources`' `dropped[]`), never a throw.
 * Malformed optional knobs (`top_k` / `cost_per_mtok` / `api_key_env`) are dropped
 * individually — a bad tuning value must not cost the operator the whole lane.
 *
 * Rejection: if a `repair_proxy` key exists, it is not recognized and surfaces a
 * dropped reason telling the operator what key to use instead (never silent ignore).
 */
export function readProxyDeclaration(
  deps: AmbientSourceDeps = {},
): ProxyDeclarationResult {
  const path = resolveSourceDeclarationPath(deps.homeDir);
  const raw = (deps.readDeclarationFile ?? defaultReadDeclarationFile)(path);
  if (raw === null) return { declaration: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { declaration: null };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { declaration: null };
  }

  // Check for unrecognized `repair_proxy` key and surface it as a dropped reason (never silent).
  const unresolvedBlock = (parsed as Record<string, unknown>).repair_proxy;
  if (unresolvedBlock !== undefined) {
    return {
      declaration: null,
      reason: "repair_proxy is retired — declare a proxy block instead.",
    };
  }

  const block = (parsed as { proxy?: unknown }).proxy;
  if (block === undefined) return { declaration: null };
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return {
      declaration: null,
      reason: "proxy must be a JSON object with an endpoint — fix the declaration.",
    };
  }
  const { endpoint, top_k, cost_per_mtok, api_key_env, burst_limited } =
    block as Record<string, unknown>;
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    return {
      declaration: null,
      reason: "proxy.endpoint must be a non-empty url string — fix the declaration.",
    };
  }
  const declaration: ProxyDeclaration = {
    // Trailing slashes stripped so the reach probe, the discovery cache's stored
    // endpoint, and the expanded sources all compare on one canonical form.
    endpoint: endpoint.trim().replace(/\/+$/u, ""),
  };
  if (typeof top_k === "number" && Number.isInteger(top_k) && top_k > 0) {
    declaration.top_k = top_k;
  }
  if (
    typeof cost_per_mtok === "number" &&
    Number.isFinite(cost_per_mtok) &&
    cost_per_mtok >= 0
  ) {
    declaration.cost_per_mtok = cost_per_mtok;
  }
  if (typeof api_key_env === "string" && api_key_env.trim().length > 0) {
    declaration.api_key_env = api_key_env.trim();
  }
  if (typeof burst_limited === "boolean") {
    declaration.burst_limited = burst_limited;
  }
  return { declaration };
}

/**
 * The default populate fetch: time-boxed so a routable-but-dead proxy cannot hang a
 * `next-step` at the Gate-0 build (network-tolerant means bounded, not just caught).
 */
const populateFetchWithTimeout: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(5_000) });

/**
 * POPULATE the declared proxy lane (plan §populate-vs-resolve): read the
 * machine declaration's `proxy` block and, when present, fetch its model
 * discovery into the machine-level populate cache ({@link populateProxyCatalog}).
 * This is the network half the resolve path must never run — call it at Gate-0
 * build time (once per run) or on explicit refresh, NEVER from `resolveAmbientSources`.
 *
 * "Present + reachable" gating is the fetch itself: the discovery GET is both the
 * liveness proof and the payload, so a separate pre-probe would only double the
 * network. Never throws: no declared lane ⇒ `null`; a failed/unreachable fetch ⇒
 * `{written:false, reason}` and any prior cache is left untouched — the lane then
 * resolves from the existing cache or unexpanded with its own `dropped[]` reason,
 * degrading Gate-0, never blocking it.
 */
export async function populateDeclaredProxyCatalog(
  deps: AmbientSourceDeps & { fetchImpl?: typeof fetch } = {},
): Promise<PopulateProxyCatalogResult | null> {
  const { declaration } = readProxyDeclaration(deps);
  if (declaration === null) return null;
  return populateProxyCatalog({
    endpoint: declaration.endpoint,
    ...(declaration.top_k !== undefined ? { topK: declaration.top_k } : {}),
    ...(declaration.cost_per_mtok !== undefined
      ? { costPerMtok: declaration.cost_per_mtok }
      : {}),
    ...(declaration.api_key_env !== undefined
      ? { apiKeyEnv: declaration.api_key_env }
      : {}),
    fetchImpl: deps.fetchImpl ?? populateFetchWithTimeout,
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
  });
}

/**
 * Populate the proxy catalog ONLY when the resolve half would otherwise drop the
 * lane for it: a `proxy` is declared but the cache is absent or was fetched from a
 * different endpoint. Bounded by construction — after one success the cache exists
 * and this is a cheap read — so a draw with no Gate-0 build moment (remediate) can
 * call it on every config load without a per-load network fetch. Freshness (TTL /
 * explicit refresh) is deliberately NOT this function's job (backlog).
 * [[silent-fail-closed-on-one-draw]] — both draws must trigger populate, not just audit.
 */
export async function populateProxyCatalogIfMissing(
  deps: AmbientSourceDeps & { fetchImpl?: typeof fetch } = {},
): Promise<PopulateProxyCatalogResult | null> {
  const { declaration } = readProxyDeclaration(deps);
  if (declaration === null) return null;
  const cache = readProxyCatalog(deps);
  if (
    cache !== null &&
    cache.endpoint.replace(/\/+$/u, "") === declaration.endpoint
  ) {
    return {
      sources: cache.sources,
      written: false,
      reason: "populate cache already present",
      dropped: [],
    };
  }
  return populateDeclaredProxyCatalog(deps);
}

/**
 * Can THIS process prove it can reach this declared source?
 *
 * The spec's rule is `declared ∩ ambient-verifiable-by-this-process` — a declared lane
 * enters the pool only if this process PROVES reach, never `declared ∪ stored`. Each
 * check verifies what the declaration actually asserts:
 *
 * - `api_key_env` → the env var is present and non-empty
 * - CLI provider → its launcher resolves on PATH
 * - `subprocess-template` → its `command_template[0]` resolves on PATH
 * - `credentials_path` → the file is readable
 * - inline `api_key` → NOT verifiable (see below)
 *
 * **Inline `api_key` is refused.** Possessing a credential proves nothing about reach:
 * the endpoint may be dead, the key revoked. It is also the one shape an operator can
 * always choose, so admitting it would make the whole rule opt-out by construction —
 * and it is an always-passes lane whose only catcher (the reactive `lies reachably`
 * quarantine) is G5, not yet built. A stale free-tier declaration would be admitted as
 * reachable and, under cost-first routing (λ=0), take EVERY packet first and fail them
 * all. A public constant lives in an env var fine.
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
      if (source.api_key !== undefined && source.api_key_env === undefined) {
        return {
          verified: false,
          reason:
            "inline api_key is not ambient-verifiable (it proves possession, not reach) — move the key into an env var and declare api_key_env.",
        };
      }
      if (!source.api_key_env?.trim()) {
        return { verified: false, reason: "openai-compatible source has no api_key_env." };
      }
      if (!(env[source.api_key_env] ?? "").trim()) {
        return {
          verified: false,
          reason: `env var "${source.api_key_env}" is unset or empty in this process.`,
        };
      }
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
      // liveness (endpoint = the proxy url). Normally these sources come pre-verified
      // from the populate cache via the `proxy` lane; a hand-declared one is held to
      // the same bar. Inline api_key refused for the same possession≠reach reasons as
      // openai-compatible above; api_key_env is optional (keyless proxy default).
      if (!source.endpoint?.trim()) {
        return {
          verified: false,
          reason: "claude-worker source has no endpoint (the proxy url).",
        };
      }
      if (!source.model?.trim()) {
        return { verified: false, reason: "claude-worker source has no model." };
      }
      if (source.api_key !== undefined) {
        return {
          verified: false,
          reason:
            "inline api_key is not ambient-verifiable (it proves possession, not reach) — declare api_key_env if the proxy requires one, otherwise omit.",
        };
      }
      // When api_key_env is declared, the env var must be set (reach verification).
      if (source.api_key_env?.trim()) {
        if (!(env[source.api_key_env] ?? "").trim()) {
          return {
            verified: false,
            reason: `env var "${source.api_key_env}" is unset or empty in this process.`,
          };
        }
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
  resolveProxyLane(deps, sources, dropped);
  // Worker-kind × pool-class compatibility, applied ONCE over the assembled set so
  // declared and proxy-expanded lanes are held to the same rule. Per-lane, so one
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

/**
 * The proxy lane of the resolve half (plan §populate-vs-resolve): a declared
 * `proxy` whose liveness probe passes expands from the POPULATE CACHE — never
 * a mid-resolve fetch. Fail-open, mirroring the declared-source contract: every
 * outcome short of expansion lands in `dropped[]` with an operator-facing reason
 * (malformed declaration / probe failure / cache absent-stale-empty), so the lane is
 * never silently discarded.
 */
function resolveProxyLane(
  deps: AmbientSourceDeps,
  sources: DispatchableSource[],
  dropped: DroppedSource[],
): void {
  const { declaration, reason } = readProxyDeclaration(deps);
  if (reason !== undefined) {
    dropped.push({ id: "proxy", reason });
    return;
  }
  if (declaration === null) return;
  const { endpoint } = declaration;
  const laneId = `proxy:${endpoint}`;
  // Reach-verify the declared master key BEFORE the liveness probe. A proxy's
  // health endpoint is typically unauthenticated (LiteLLM's /health/liveliness
  // is), so the probe passes with no key and the lane then fails downstream at
  // populate — surfacing "cache absent, run the populate" when the operator DID
  // run it and the real cause is the unset var. Mirrors the same check the
  // expanded per-model claude-worker sources get in `verifySourceReach`.
  const env = deps.env ?? process.env;
  if (declaration.api_key_env !== undefined) {
    if (!(env[declaration.api_key_env] ?? "").trim()) {
      dropped.push({
        id: laneId,
        reason: `env var "${declaration.api_key_env}" is unset or empty in this process.`,
      });
      return;
    }
  }
  const probe = deps.probeHttpReachable ?? defaultProbeHttpReachable;
  if (!probe(endpoint)) {
    dropped.push({
      id: laneId,
      reason: `proxy at "${endpoint}" failed the liveness probe — lane dropped for this invocation.`,
    });
    return;
  }
  const catalog = readProxyCatalog(deps);
  if (catalog === null) {
    dropped.push({
      id: laneId,
      reason:
        "proxy is reachable but the populate cache is absent/invalid — run the populate (populateProxyCatalog) to expand this lane.",
    });
    return;
  }
  if (catalog.endpoint.replace(/\/+$/u, "") !== endpoint) {
    dropped.push({
      id: laneId,
      reason: `populate cache was fetched from "${catalog.endpoint}", not the declared "${endpoint}" — re-run the populate.`,
    });
    return;
  }
  if (catalog.sources.length === 0) {
    dropped.push({
      id: laneId,
      reason:
        "proxy expansion is empty (no reachable backend models at populate time) — lane present but unexpanded.",
    });
    return;
  }
  // Declared-wins dedup: an expanded lane whose (service, model)
  // identity a DECLARED source already covers is skipped, so one pool identity
  // never maps to two sources (the launch bridge's pool→source map is 1:1 by
  // assumption — a duplicate would arbitrate the transport by silent map-order
  // clobber). The operator's explicit lane always beats auto-expansion; routing
  // through the proxy for that model is still available by declaring the
  // claude-worker source explicitly.
  const declaredIdentities = new Set(
    sources.map((s) => `${s.service ?? s.transport}/${s.model ?? ""}`),
  );
  for (const expanded of catalog.sources) {
    const identity = `${expanded.service ?? expanded.transport}/${expanded.model ?? ""}`;
    if (declaredIdentities.has(identity)) {
      dropped.push({
        id: sourceId(expanded),
        reason: `expanded lane skipped — a declared source already covers backend identity "${identity}" (declared wins over expansion).`,
      });
      continue;
    }
    // `burst_limited` is stamped from the CURRENT declaration, not the populate
    // cache — declaration-authoritative in BOTH directions: an explicit `false`
    // strips a cache-carried flag just as `true` adds one, so flipping the knob
    // takes effect on the next resolve without a re-populate (a stale cache can
    // neither launder the flag off nor pin it on).
    sources.push(
      typeof declaration.burst_limited === "boolean"
        ? { ...expanded, burst_limited: declaration.burst_limited }
        : expanded,
    );
  }
}
