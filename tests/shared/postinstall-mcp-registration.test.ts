/**
 * The package postinstall registers each bin's submit-only MCP server with every
 * host whose MCP format is documented (decision 4, 2026-11-06; formats verified
 * against each host's documentation and, for OpenCode, its live config schema).
 *
 * The launch is `node <package>/<bin>.mjs mcp`, never the bare bin name: a
 * host that spawns without a shell cannot run the Windows `.cmd` shim npm
 * installs, and an absolute node path needs no PATH lookup.
 *
 * A user's own config is never re-serialized where formatting carries meaning:
 * the Codex TOML gets an appended table, and an entry the user changed by hand
 * is left alone.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";
import { expect, test } from "vitest";

import { spawnHidden as spawn } from "../helpers/spawn.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOLS = ["audit-code", "remediate-code"] as const;

function runPostinstall(homeDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "scripts", "postinstall.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, AUDIT_TOOLS_REPO_VISIBILITY: "private" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

function expectedLaunch(tool: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(repoRoot, `${tool}.mjs`), "mcp"] };
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

const CODEX_SEED = '# my own comment\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "other"\n';

test("postinstall registers both submit servers with every documented host, idempotently", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-tools-mcp-home-"));
  try {
    const codexPath = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, CODEX_SEED, "utf8");
    const opencodePath = join(homeDir, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(
      opencodePath,
      JSON.stringify({
        mcp: {
          // The retired repo-local server's entry: ours, stale, removed.
          auditor: { type: "local", command: ["node", ".audit-code/install/run-mcp-server.mjs"] },
          // A user's own server: untouched.
          mine: { type: "local", command: ["mine"] },
        },
      }),
      "utf8",
    );

    await runPostinstall(homeDir);

    const opencode = await readJson(opencodePath);
    expect(opencode.mcp.auditor).toBeUndefined();
    expect(opencode.mcp.mine).toEqual({ type: "local", command: ["mine"] });
    const codex = await readFile(codexPath, "utf8");
    expect(codex.startsWith(CODEX_SEED)).toBe(true);
    const codexServers = (parseToml(codex) as { mcp_servers: Record<string, unknown> }).mcp_servers;
    expect(codexServers.other).toEqual({ command: "other" });

    for (const tool of TOOLS) {
      const launch = expectedLaunch(tool);
      expect(opencode.mcp.servers[tool], `OpenCode ${tool}`).toEqual({
        type: "local",
        command: [launch.command, ...launch.args],
      });
      expect(codexServers[tool], `Codex ${tool}`).toEqual(launch);
      const claudePlugin = join(
        homeDir, ".claude", "plugins", "marketplaces", "claude-plugins-official", "external_plugins", tool,
      );
      expect((await readJson(join(claudePlugin, ".mcp.json"))).mcpServers[tool], `Claude ${tool}`).toEqual(launch);
      const antigravityPlugin = join(homeDir, ".gemini", "config", "plugins", tool);
      expect(
        (await readJson(join(antigravityPlugin, "mcp_config.json"))).mcpServers[tool],
        `Antigravity ${tool}`,
      ).toEqual(launch);
    }
    expect(Object.keys(opencode.agent?.auditor?.permission ?? {})).not.toContain("auditor_*");

    // A second run changes nothing the first run wrote.
    await runPostinstall(homeDir);
    expect(await readFile(codexPath, "utf8")).toBe(codex);
    expect(await readJson(opencodePath)).toEqual(opencode);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall never makes a Codex config invalid: an inline mcp_servers table is left as it is", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-tools-mcp-home-"));
  try {
    const codexPath = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(codexPath), { recursive: true });
    // TOML closes an inline table: an appended [mcp_servers.<tool>] would not parse.
    const seed = 'mcp_servers = { other = { command = "o" } }\n';
    await writeFile(codexPath, seed, "utf8");
    await runPostinstall(homeDir);
    expect(await readFile(codexPath, "utf8")).toBe(seed);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall reads a Codex entry with its keys in another order as unchanged, not as a hand edit", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-tools-mcp-home-"));
  try {
    const codexPath = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(codexPath), { recursive: true });
    // The launch this release writes, with `args` first. JSON string escapes are
    // valid TOML basic-string escapes, so a Windows path round-trips.
    const launch = expectedLaunch("audit-code");
    const seed =
      `[mcp_servers.audit-code]\nargs = ${JSON.stringify(launch.args)}\n` +
      `command = ${JSON.stringify(launch.command)}\n`;
    await writeFile(codexPath, seed, "utf8");
    const output = await runPostinstall(homeDir);
    expect(output).toContain("audit-code: unchanged Codex MCP server");
    expect(output).not.toContain("kept the Codex MCP server entry");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("postinstall leaves a Codex entry the user changed by hand alone", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "audit-tools-mcp-home-"));
  try {
    const codexPath = join(homeDir, ".codex", "config.toml");
    await mkdir(dirname(codexPath), { recursive: true });
    const seed = '[mcp_servers.audit-code]\ncommand = "my-node"\nargs = ["custom.mjs", "mcp"]\n';
    await writeFile(codexPath, seed, "utf8");
    await runPostinstall(homeDir);
    const codex = await readFile(codexPath, "utf8");
    expect(codex.startsWith(seed)).toBe(true);
    const servers = (parseToml(codex) as { mcp_servers: Record<string, unknown> }).mcp_servers;
    expect(servers["audit-code"]).toEqual({ command: "my-node", args: ["custom.mjs", "mcp"] });
    expect(servers["remediate-code"]).toEqual(expectedLaunch("remediate-code"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
