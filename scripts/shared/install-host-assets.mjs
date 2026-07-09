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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Read a source file that is required for the install to proceed at all
 * (e.g. the prompt/skill markdown). Missing source is reported as a skip
 * (exitCode reset to 0, not a failure) rather than thrown.
 */
export function readRequiredSource(path, label, toolName) {
  if (!existsSync(path)) {
    console.warn(`${toolName}: ${label} source not found at ${path} - skipping global command install`);
    process.exitCode = 0;
    return null;
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
      typeof shared.withoutOpenCodeWildcard === "function"
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
      console.warn(`${toolName}: could not install global ${install.label} (${err.message})`);
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
    console.warn(`${toolName}: could not install global ${label} (${err.message})`);
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
    console.warn(`${toolName}: could not install Antigravity plugin (${err.message})`);
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
