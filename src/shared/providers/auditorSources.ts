import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DispatchableSource } from "../types/sessionConfig.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";
import { commandExists } from "./providerPathGuard.js";

/**
 * The machine-level declaration file: the backends the OPERATOR owns, hand-authored
 * like `session-config.json`. Deliberately NOT id-keyed and deliberately NOT named
 * `catalog-<auditor-id>.json` — that name is reserved for the future POPULATE cache
 * (`spec/unified-dispatch-worker-model.md`), and squatting it would turn this read
 * into a direct cache read, violating never-inherit by filename collision.
 *
 * A declaration is not a cache: it is operator INTENT, not a prior auditor's resolved
 * state. Reading it and intersecting it with live ambient reach does not inherit
 * anything ([[capability-is-per-auditor-not-per-audit]]).
 */
export const SOURCE_DECLARATION_FILENAME = "sources-declared.json";

/** `~/.audit-code` — the established home-dir state dir (`src/audit/cli.ts` puts quota state here). */
const STATE_DIR_NAME = ".audit-code";

/** A declared source that did NOT survive the ambient-reach intersection. */
export interface DroppedSource {
  /** The source's declared id, or its derived `${provider}:${model ?? endpoint}` fallback. */
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

/** The source's stable id, matching `DispatchableSource.id`'s documented default. */
function sourceId(source: DispatchableSource): string {
  return source.id ?? `${source.provider}:${source.model ?? source.endpoint ?? "?"}`;
}

/** Resolve the declaration file path for this machine. */
export function resolveSourceDeclarationPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), STATE_DIR_NAME, SOURCE_DECLARATION_FILENAME);
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

  switch (source.provider) {
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
      const fallback = CLI_DEFAULT_COMMAND[source.provider];
      if (exists(fallback)) return { verified: true };
      // Gated for the 2026-07-18 sunset, mirroring agyProvider's own fallback.
      if (source.provider === "agy" && exists(AGY_LEGACY_COMMAND)) {
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
  return { sources, dropped };
}
