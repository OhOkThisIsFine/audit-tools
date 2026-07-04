import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/**
 * Codex's documented default concurrent-subagent ceiling: `[agents].max_threads`
 * defaults to 6 when unset (OpenAI Codex config reference / subagents docs). This
 * is a real product default, NOT a value we invented — but Codex Desktop exposes
 * no environment variable for it, so when the config file is silent we fall back
 * to this constant and label the source `known_default` (never `environment`).
 */
export const CODEX_DEFAULT_MAX_THREADS = 6;

/** Injectable reader — returns the config file text, throws when it is absent. */
export type ReadTextFile = (filePath: string) => string;

/**
 * Discover Codex's configured concurrent-subagent ceiling from its own config
 * file: `~/.codex/config.toml` `[agents].max_threads`. This is the honest
 * discovery source for the Codex cap — Codex does not surface it via env, but it
 * IS a user-configurable value in Codex's config, so we read it there rather than
 * assume. Returns null (caller applies {@link CODEX_DEFAULT_MAX_THREADS}) when the
 * file is missing/unreadable/malformed or the key is absent or not a positive
 * integer. Never throws — a bad config degrades to "no discovered value".
 */
export function readCodexConfiguredMaxThreads(options?: {
  configPath?: string;
  readText?: ReadTextFile;
}): number | null {
  const configPath =
    options?.configPath ?? path.join(homedir(), ".codex", "config.toml");
  const readText = options?.readText ?? ((p: string) => readFileSync(p, "utf8"));

  let raw: string;
  try {
    raw = readText(configPath);
  } catch {
    return null; // no config file → no discovered value
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    return null; // malformed TOML degrades to no value (never throws)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const agents = (parsed as Record<string, unknown>).agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return null;

  const value = (agents as Record<string, unknown>).max_threads;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
