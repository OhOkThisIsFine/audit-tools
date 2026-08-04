import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

/** Injectable reader — returns the config file text, throws when it is absent. */
export type ReadTextFile = (filePath: string) => string;

/**
 * Discover Codex's configured concurrent-subagent ceiling from its own config
 * file: `~/.codex/config.toml` `[agents].max_concurrent_threads_per_session`.
 * `max_threads` remains supported as Codex's legacy alias. This is the honest
 * discovery source for the Codex cap — Codex does not surface it via env, but it
 * IS a user-configurable value in Codex's config, so we read it rather than
 * assume a product default. Returns null when the file is missing,
 * unreadable/malformed, or neither key is a positive integer. Never throws — a
 * bad config degrades to "no discovered value".
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

  const agentsRecord = agents as Record<string, unknown>;
  const value =
    agentsRecord.max_concurrent_threads_per_session ?? agentsRecord.max_threads;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}
