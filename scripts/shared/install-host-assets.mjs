// sites-pinned: tests/shared/postinstall-mcp-registration.test.ts, tests/audit/postinstall-contract.test.ts
// Shared postinstall driver for the audit-code and remediate-code host-asset
// deployers (scripts/audit/postinstall.mjs, scripts/remediate/postinstall.mjs).
//
// This is a plain .mjs module: both postinstalls run at `npm install` time,
// before `tsc` has produced dist/, so this file must never import from dist/
// or from src/**/*.ts. It owns only the mechanical bits that are byte-identical
// across the two tools (I/O primitives, the install-list loop, the OpenCode
// global-config install wrapper, the Antigravity plugin block, and the final
// summary line). Each tool keeps its own permission constants and OpenCode
// config-merge functions locally — those differ in exact merge behavior
// between audit-code and remediate-code and must not be forced into parity.
import { dirname, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * Read a source file that is required for the install to proceed at all
 * (e.g. the prompt/skill markdown — the product surface itself). A missing
 * required source is a LOUD failure: it throws so the postinstall exits
 * non-zero and any failure an earlier step already recorded is never masked
 * by an exit-code reset here. Only truly optional sources go through
 * readOptionalSource, which still degrades to a skip.
 */
export function readRequiredSource(path, label, toolName) {
  if (!existsSync(path)) {
    throw new Error(
      `${toolName}: ${label} source not found at ${path} - required for the install; not skipping silently`,
    );
  }
  return readFileSync(path);
}

/** Read a source file whose absence only skips one optional install step. */
export function readOptionalSource(path, label, toolName) {
  if (!existsSync(path)) {
    console.warn(`${toolName}: ${label} source not found at ${path} - skipping optional install`);
    return null;
  }
  return readFileSync(path);
}

/**
 * Write a generated file, creating parent directories as needed.
 * Returns "installed" on first write, "updated" on subsequent writes.
 */
export function writeGeneratedFile(path, content) {
  const action = existsSync(path) ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return action;
}

/** Coerce an unknown value to a plain object (non-array). */
export function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * The ONE stdio launch of a bin's submit-only MCP server (decision 4,
 * 2026-11-06). Absolute node plus the package's own entry script, never the
 * bare bin name: a host that spawns without a shell cannot run the Windows
 * `.cmd` shim npm installs, and an absolute path needs no PATH lookup. Each
 * reinstall rewrites it, so a moved package or a new node is picked up then.
 *
 * @param {string} pkgRoot
 * @param {string} toolName
 * @returns {{command: string, args: string[]}}
 */
export function mcpServerLaunch(pkgRoot, toolName) {
  return { command: process.execPath, args: [join(pkgRoot, `${toolName}.mjs`), "mcp"] };
}

/**
 * The OpenCode `mcp` object with this tool's server registered under
 * `mcp.servers` (the current schema; the flat `mcp.<name>` form is deprecated).
 * The retired repo-local server's flat `auditor` entry is removed only when it
 * still launches that server, so a user's own entry of that name survives.
 */
export function mergeOpenCodeMcpServer(existingMcp, toolName, launch) {
  const mcp = { ...objectValue(existingMcp) };
  const stale = objectValue(mcp.auditor).command;
  if (Array.isArray(stale) && stale.some((part) => String(part).includes("run-mcp-server"))) {
    delete mcp.auditor;
  }
  return {
    ...mcp,
    servers: {
      ...objectValue(mcp.servers),
      [toolName]: { type: "local", command: [launch.command, ...launch.args] },
    },
  };
}

/**
 * True when a Codex entry has this package's launch shape,
 * `{command, args: [<dir>/<tool>.mjs, "mcp"]}` and nothing else: an install of
 * this package wrote it (a clone's own `npm install` runs this postinstall
 * too, so the entry can point at a clone or a removed lap worktree). Any other
 * entry is the user's.
 */
function isOwnCodexLaunch(entry, toolName) {
  const args = entry.args;
  return (
    Object.keys(entry).length === 2 &&
    typeof entry.command === "string" &&
    Array.isArray(args) &&
    args.length === 2 &&
    args[1] === "mcp" &&
    typeof args[0] === "string" &&
    args[0].split(/[\\/]/).pop() === `${toolName}.mjs`
  );
}

/** A parsed TOML value as JSON with sorted object keys: key order and prototype do not count. */
function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

/**
 * Replace the text of the `[mcp_servers.<tool>]` table: from its header line to
 * the next table header, less the blank and comment lines just before that
 * header (they introduce the next table). Undefined when no such header line
 * exists (for example a dotted-key or inline form).
 */
function replaceCodexTable(text, toolName, table) {
  const lines = text.split(/(?<=\n)/);
  const name = toolName.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${name}"|'${name}'|${name})\\s*\\]\\s*(?:#.*)?\\r?\\n?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  while (end > start + 1 && /^\s*(?:#.*)?\r?\n?$/.test(lines[end - 1])) end--;
  return [...lines.slice(0, start), table, ...lines.slice(end)].join("");
}

/**
 * Register this tool's `[mcp_servers.<tool>]` table in the Codex config. The
 * user's file is never re-serialized (that would drop their comments and
 * layout): an absent entry is appended as text, an identical one is left, an
 * entry of this package's own launch shape at another path is replaced in
 * place (an earlier install of this package wrote it), and any other entry is
 * the user's edit and is left, with a note.
 *
 * The file is written only when the COMPOSED text parses to exactly the old
 * config plus this one entry. An appended table cannot extend an inline
 * `mcp_servers = { ... }` (TOML closes inline tables), and a file that does not
 * parse today cannot be judged at all: each returns "manual" and leaves the
 * file as it is, never making it invalid and never failing the install over a
 * user's own config.
 *
 * @returns {"installed" | "replaced" | "unchanged" | "kept" | "manual"}
 */
function registerCodexMcpServer(path, toolName, launch) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const parsesAs = (text) => {
    try {
      return parseToml(text);
    } catch {
      return undefined;
    }
  };
  const current = parsesAs(existing);
  if (current === undefined) return "manual";
  const entry = objectValue(objectValue(current.mcp_servers)[toolName]);
  const rawTable = stringifyToml({ mcp_servers: { [toolName]: launch } });
  const table = rawTable.endsWith("\n") ? rawTable : `${rawTable}\n`;
  let next;
  /** @type {"installed" | "replaced"} */
  let action;
  if (Object.keys(entry).length > 0) {
    // Compare by field, not by serialized text: the same entry with its keys in
    // another order is unchanged, not an edit to report as kept.
    const sameLaunch =
      Object.keys(entry).length === 2 &&
      entry.command === launch.command &&
      JSON.stringify(entry.args) === JSON.stringify(launch.args);
    if (sameLaunch) return "unchanged";
    if (!isOwnCodexLaunch(entry, toolName)) return "kept";
    next = replaceCodexTable(existing, toolName, table);
    if (next === undefined) return "manual";
    action = "replaced";
  } else {
    const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    next = `${existing}${separator}${table}`;
    action = "installed";
  }
  const composed = parsesAs(next);
  const expected = { ...current, mcp_servers: { ...objectValue(current.mcp_servers), [toolName]: launch } };
  if (composed === undefined || canonicalJson(composed) !== canonicalJson(expected)) return "manual";
  mkdirSync(dirname(path), { recursive: true });
  // The user's own config: temp-then-rename, so a crash mid-write leaves the
  // old file whole instead of a truncated one.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, next, "utf8");
  renameSync(temp, path);
  return action;
}

/**
 * Register a bin's submit-only MCP server with the hosts whose format each
 * keeps in a file this package owns or appends to: the tool's Claude plugin
 * (`.mcp.json`), its Antigravity plugin (`mcp_config.json`) and the Codex
 * config. OpenCode is registered inside each tool's merged global config
 * (`mergeOpenCodeMcpServer`). Each host is its own counted step.
 *
 * @param {{toolName: string, homeDir: string, launch: {command: string, args: string[]}, claudePluginDir: string}} options
 * @param {{succeeded: number, failed: number}} counts
 */
export function installMcpServerRegistrations({ toolName, homeDir, launch, claudePluginDir }, counts) {
  const declaration = Buffer.from(JSON.stringify({ mcpServers: { [toolName]: launch } }, null, 2) + "\n");
  /** @type {Array<[string, string, (path: string) => string]>} */
  const steps = [
    ["Claude plugin MCP server", join(claudePluginDir, ".mcp.json"), (path) => writeGeneratedFile(path, declaration)],
    [
      "Antigravity plugin MCP server",
      join(homeDir, ".gemini", "config", "plugins", toolName, "mcp_config.json"),
      (path) => writeGeneratedFile(path, declaration),
    ],
    ["Codex MCP server", join(homeDir, ".codex", "config.toml"), (path) => registerCodexMcpServer(path, toolName, launch)],
  ];
  for (const [label, path, install] of steps) {
    try {
      const action = install(path);
      if (action === "kept") {
        console.log(
          `${toolName}: kept the ${label} entry you edited in ${path}; the launch this release would write is ` +
            `${JSON.stringify(launch)}`,
        );
      } else if (action === "manual") {
        console.log(
          `${toolName}: left ${path} unchanged — writing the ${label} table there would not parse to the old ` +
            `config plus this entry (an inline mcp_servers table, a dotted-key entry, or a file that does not ` +
            `parse today). Add it by hand: ` +
            `[mcp_servers.${toolName}] command = ${JSON.stringify(launch.command)} args = ${JSON.stringify(launch.args)}`,
        );
      } else {
        console.log(`${toolName}: ${action} ${label} at ${path}`);
      }
      counts.succeeded++;
    } catch (err) {
      console.warn(`${toolName}: could not register the ${label} at ${path} (${/** @type {any} */ (err).message})`);
      counts.failed++;
    }
  }
}

/** Strip YAML frontmatter from a text file, returning only the body. */
export function splitFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
  return { body: match ? normalized.slice(match[0].length) : normalized };
}

/** Read-merge-write a JSON file. Returns "installed" or "updated". */
export function installMergedJson(path, buildMerged) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const merged = buildMerged(existing);
  const action = existing ? "updated" : "installed";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return action;
}

/**
 * The scoped OpenCode permission merge helpers are single-sourced in
 * audit-tools/shared (global top-level scope vs. per-agent scope). Resolve
 * them best-effort: on a fresh workspace checkout the shared dist may not be
 * built yet, in which case the caller skips OpenCode config deployment with a
 * warning instead of failing the whole install.
 */
export async function resolveSharedOpenCodePermissions() {
  try {
    const shared = await import("audit-tools/shared");
    if (
      typeof shared.mergeOpenCodeAgentPermissionRule === "function" &&
      typeof shared.mergeOpenCodeGlobalPermissionRule === "function" &&
      typeof shared.migrateOpenCodeGlobalExternalDirectory === "function" &&
      typeof shared.withoutOpenCodeWildcard === "function" &&
      typeof shared.orderOpenCodePermissionRule === "function"
    ) {
      return shared;
    }
  } catch {
    // Leave null; the caller reports the skip.
  }
  return null;
}

/**
 * Install a flat list of `{ label, path, sourcePath, content }` entries,
 * logging one line per success and a manual-recovery block per failure.
 * Mutates `counts.succeeded` / `counts.failed`.
 */
export function runInstalls(toolName, installs, counts) {
  for (const install of installs) {
    try {
      const action = writeGeneratedFile(install.path, install.content);
      console.log(`${toolName}: ${action} global ${install.label} at ${install.path}`);
      counts.succeeded++;
    } catch (err) {
      console.warn(`${toolName}: could not install global ${install.label} (${/** @type {any} */ (err).message})`);
      console.warn(`  To install manually, copy from:`);
      console.warn(`    ${install.sourcePath}`);
      console.warn(`  to:`);
      console.warn(`    ${install.path}`);
      counts.failed++;
    }
  }
}

/**
 * Install the merged global OpenCode config, or report the skip when the
 * shared permission helpers aren't built yet. Mutates `counts`.
 *
 * `label` names the artifact in log lines (e.g. "OpenCode config" for
 * audit-code, "OpenCode command" for remediate-code — the two tools have
 * historically worded this differently). `manualInstructions`, if given, is
 * an array of extra warn lines printed on failure only.
 */
/**
 * @param {{toolName: string, path: string, sharedOpenCodePermissions: any, buildMerged: Function, label: string, manualInstructions?: string[]}} options
 * @param {{succeeded: number, failed: number}} counts
 */
export function installOpenCodeGlobalConfig(
  { toolName, path, sharedOpenCodePermissions, buildMerged, label, manualInstructions },
  counts,
) {
  if (!sharedOpenCodePermissions) {
    // Expected when audit-tools/shared isn't built yet — notably during `npm ci`
    // in CI, where postinstall runs before the shared build step. This is a SKIP,
    // not a failure: counting it would trip the `failed > 0` exit-1 guard. Genuine
    // OpenCode write errors are still counted as failures.
    console.warn(
      `${toolName}: audit-tools/shared is unavailable (build the shared workspace first); skipping OpenCode config deployment`,
    );
    return;
  }
  try {
    const action = installMergedJson(path, buildMerged);
    console.log(`${toolName}: ${action} global ${label} in ${path}`);
    counts.succeeded++;
  } catch (err) {
    console.warn(`${toolName}: could not install global ${label} (${/** @type {any} */ (err).message})`);
    for (const line of manualInstructions ?? []) console.warn(line);
    counts.failed++;
  }
}

/**
 * Install the Antigravity (Gemini IDE / Antigravity Hub) global plugin:
 * a `plugin.json` manifest plus a copy of the tool's SKILL.md. Mutates
 * `counts`; both writes count as a single succeeded/failed step, matching
 * the tools' pre-extraction behavior.
 */
export function installAntigravityPlugin(
  { toolName, homeDir, pluginName, pluginVersion, skillSource },
  counts,
) {
  const antigravityPluginDir = join(homeDir, ".gemini", "config", "plugins", pluginName);
  const antigravityPluginJsonPath = join(antigravityPluginDir, "plugin.json");
  const antigravityPluginSkillPath = join(antigravityPluginDir, "skills", "SKILL.md");
  try {
    const pluginJsonAction = writeGeneratedFile(
      antigravityPluginJsonPath,
      Buffer.from(JSON.stringify({ name: pluginName, version: pluginVersion }, null, 2) + "\n"),
    );
    console.log(`${toolName}: ${pluginJsonAction} Antigravity plugin manifest at ${antigravityPluginJsonPath}`);

    const skillAction = writeGeneratedFile(antigravityPluginSkillPath, skillSource);
    console.log(`${toolName}: ${skillAction} Antigravity plugin skill at ${antigravityPluginSkillPath}`);
    counts.succeeded++;
  } catch (err) {
    console.warn(`${toolName}: could not install Antigravity plugin (${/** @type {any} */ (err).message})`);
    counts.failed++;
  }
}

/**
 * Install the Claude Desktop plugin (manifest + command + skill) so the tool
 * appears in the slash-command menu. Claude Desktop reads external plugins from
 * `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/`.
 *
 * One step, one succeeded/failed count — matching the installers' pre-extraction
 * behaviour. `pluginDir` is derived by the PLAN (host-asset-plan.mjs), never
 * spelled here, so the two tools cannot disagree about where it lands.
 *
 * @param {{toolName: string, pluginDir: string, manifest: object,
 *          commandContent: Buffer|string, skillContent: Buffer|string}} options
 * @param {{succeeded: number, failed: number}} counts
 */
export function installClaudeDesktopPlugin(
  { toolName, pluginDir, manifest, commandContent, skillContent },
  counts,
) {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  const commandPath = join(pluginDir, "commands", `${toolName}.md`);
  const skillPath = join(pluginDir, "skills", toolName, "SKILL.md");
  try {
    const manifestAction = writeGeneratedFile(
      manifestPath,
      Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
    );
    console.log(`${toolName}: ${manifestAction} Claude Desktop plugin manifest at ${manifestPath}`);

    const commandAction = writeGeneratedFile(commandPath, commandContent);
    console.log(`${toolName}: ${commandAction} Claude Desktop plugin command at ${commandPath}`);

    const skillAction = writeGeneratedFile(skillPath, skillContent);
    console.log(`${toolName}: ${skillAction} Claude Desktop plugin skill at ${skillPath}`);

    console.log(`${toolName}: restart Claude Desktop for /${toolName} to appear in the slash-command menu`);
    counts.succeeded++;
  } catch (err) {
    console.warn(`${toolName}: could not install Claude Desktop plugin (${/** @type {any} */ (err).message})`);
    console.warn(`  Plugin directory: ${pluginDir}`);
    counts.failed++;
  }
}

/** Log the final summary line and set a non-zero exit code on any failure. */
export function finishPostinstall(toolName, counts, startTime) {
  console.log(
    `${toolName}: postinstall complete — ${counts.succeeded} succeeded, ${counts.failed} failed (${Date.now() - startTime}ms)`,
  );
  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}
