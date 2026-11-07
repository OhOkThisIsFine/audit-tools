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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";

import { createSubmitMcpServer, type SubmitToolRequest } from "../../src/shared/mcp/submitServer.js";

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
