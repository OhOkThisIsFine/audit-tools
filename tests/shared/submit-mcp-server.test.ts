/**
 * The submit-only MCP server (decision 4, 2026-11-06): ONE tool, `submit_result`,
 * and never a step or a prompt (no second copy of the next-step contract).
 *
 * The tool takes the result as a structured object, so no shell and no escaping
 * stand between the reader and the bound path. It hands the draw's submit core
 * the serialized object and reports the core's verdict; a refusal or a caller
 * error comes back as a tool error the reader can act on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFileSync, cpSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { createSubmitMcpServer, type SubmitToolRequest } from "../../src/shared/mcp/submitServer.js";
import { scratchDir } from "../helpers/scratch.js";

async function connect(submit: (request: SubmitToolRequest) => Promise<{ readonly written: boolean }>) {
  const server = createSubmitMcpServer({ name: "audit-code", version: "0.0.0-test", submit });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

test("the server exposes exactly one tool, submit_result", async () => {
  const client = await connect(async () => ({ written: true }));
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["submit_result"]);
  expect(Object.keys(tools[0]!.inputSchema.properties ?? {}).sort()).toEqual(
    ["artifacts_dir", "result", "root", "work_item_id"],
  );
});

test("submit_result hands the core the serialized object, backslash intact, and reports its verdict", async () => {
  const seen: SubmitToolRequest[] = [];
  const client = await connect(async (request) => {
    seen.push(request);
    return { written: true };
  });
  const result = { quoted_text: 'token.replace(/\\s+/g, "")' };
  const call = await client.callTool({
    name: "submit_result",
    arguments: { root: "/repo", work_item_id: "W-1", result },
  });
  expect(call.isError).not.toBe(true);
  expect(JSON.parse(text(call))).toEqual({ written: true });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.root).toBe("/repo");
  expect(seen[0]!.artifactsDir).toBeUndefined();
  expect(seen[0]!.workItemId).toBe("W-1");
  expect(JSON.parse(seen[0]!.source)).toEqual(result);
  expect(seen[0]!.source).toContain("\\\\s+");
});

test("a refusal and a caller error both come back as tool errors with the reason", async () => {
  const refusing = await connect(async () => ({ written: false, issues: [{ message: "assigned task lens" }] }));
  const refused = await refusing.callTool({
    name: "submit_result",
    arguments: { root: "/repo", work_item_id: "W-1", result: {} },
  });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toMatch(/assigned task lens/u);

  const throwing = await connect(async () => {
    throw new Error("'W-9' is not a work item of the current run");
  });
  const thrown = await throwing.callTool({
    name: "submit_result",
    arguments: { root: "/repo", work_item_id: "W-9", result: {} },
  });
  expect(thrown.isError).toBe(true);
  expect(text(thrown)).toMatch(/W-9.*not a work item/u);
});

test.skipIf(process.platform !== "win32").each([
  ["audit-code", "audit/index.js"],
  ["remediate-code", "remediate/index.js"],
])("%s stdio leaves the package renameable and refuses an old session", async (bin, entry) => {
  const fixture = scratchDir(`mcp-reinstall-${bin}`);
  const installed = join(fixture, "audit-tools");
  const old = join(fixture, "retired");
  const initialCaller = join(installed, "caller");
  const manifest = JSON.stringify({
    name: "audit-tools", version: "9.9.9", type: "module",
    exports: { "./shared": "./dist/shared/index.js" },
  });
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  mkdirSync(initialCaller, { recursive: true });
  writeFileSync(join(installed, "package.json"), manifest);
  copyFileSync(join(checkout, `${bin}.mjs`), join(installed, `${bin}.mjs`));
  cpSync(join(checkout, "wrapper"), join(installed, "wrapper"), { recursive: true });
  mkdirSync(join(installed, "scripts", "shared"), { recursive: true });
  copyFileSync(join(checkout, "scripts", "shared", "primitives.mjs"), join(installed, "scripts", "shared", "primitives.mjs"));
  mkdirSync(join(installed, "dist", "shared", "mcp"), { recursive: true });
  mkdirSync(join(installed, "dist", "shared", "io"), { recursive: true });
  // Audit wrapper imports its installer renderer eagerly, even on a command
  // that never uses it. Keep the export (and fail if it ever gets invoked).
  writeFileSync(join(installed, "dist", "shared", "index.js"),
    'export function renderHostAsset() { throw Error("Unexpected installer render"); }');
  for (const module of ["shared/mcp/submitServer.js", "shared/io/json.js"]) {
    copyFileSync(join(checkout, "dist", module), join(installed, "dist", module));
  }
  symlinkSync(realpathSync(join(checkout, "node_modules")), join(fixture, "node_modules"), "junction");
  mkdirSync(join(installed, "dist", entry.split("/")[0]!), { recursive: true });
  writeFileSync(join(installed, "dist", entry), `
    import { serveSubmitMcpOverStdio } from "../shared/mcp/submitServer.js";
    if (process.argv[2] !== "mcp") {
      process.stdout.write(JSON.stringify({ cwd: process.cwd(), caller: process.env.AUDIT_TOOLS_CALLER_CWD }));
    } else {
      const submit = async (request) => ({
        written: true, root: request.root, artifactsDir: request.artifactsDir,
        cwd: process.cwd(), caller: process.env.AUDIT_TOOLS_CALLER_CWD,
      });
      await serveSubmitMcpOverStdio({ name: ${JSON.stringify(bin)}, submit, gateSubmission: { lanes: ["fixture"], submit } },
        ${bin === "remediate-code" ? JSON.stringify(".audit-tools/remediation") : "undefined"});
    }
  `);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(installed, `${bin}.mjs`), "mcp"],
    cwd: initialCaller,
  });
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const submit = (root = fixture, artifacts_dir?: string) => client.callTool({
    name: "submit_result", arguments: { root, artifacts_dir, work_item_id: "W-1", result: {} },
  });
  try {
    await client.connect(transport);
    const accepted = await submit(fixture, bin === "remediate-code" ? ".audit-tools/remediation" : undefined);
    expect(accepted.isError).not.toBe(true);
    expect(JSON.parse(text(accepted))).toMatchObject({
      written: true, root: fixture, cwd: realpathSync(fixture), caller: initialCaller,
    });
    expect(text(await submit("."))).toContain("absolute repository root");
    expect(text(await submit(fixture, "elsewhere"))).toContain("absolute artifacts directory");
    renameSync(installed, old);
    expect(await submit()).toMatchObject({ isError: true });
    mkdirSync(installed);
    writeFileSync(join(installed, "package.json"), manifest);
    const stale = await submit();
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Restart this MCP server");
    const staleGate = await client.callTool({
      name: "submit_gate", arguments: { root: fixture, lane: "fixture", result: {} },
    });
    expect(staleGate.isError).toBe(true);
    expect(text(staleGate)).toContain("No result was written");
  } finally {
    await client.close();
  }
});
