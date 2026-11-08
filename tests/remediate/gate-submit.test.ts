import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSubmitMcpServer, type SubmitServerOptions } from "../../src/shared/mcp/submitServer.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { submitRemediationGateResult } from "../../src/remediate/steps/submitGateResult.js";

const capture = vi.hoisted(() => ({ options: undefined as Omit<SubmitServerOptions, "version"> | undefined }));
vi.mock("audit-tools/shared/mcp/submitServer", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/shared/mcp/submitServer.js")>(),
  serveSubmitMcpOverStdio: async (options: Omit<SubmitServerOptions, "version">) => { capture.options = options; },
}));
import { program } from "../../src/remediate/index.js";

const harness = createNextStepHarness(".test-remediation-gate-submit");
afterEach(async () => { await harness.cleanupTestRepo(); });

test("remediation MCP submits triage decisions without advancing, then the file consumer applies them", async () => {
  await harness.resetTestRepo();
  const state = makePlanningState({ status: "waiting_for_triage", items: {
    "B-001": { unit_id: "B-001", status: "blocked", rework_count: 99 },
    "B-002": { unit_id: "B-002", status: "resolved" },
  } });
  await harness.saveState(state);
  const statePath = join(harness.ARTIFACTS_DIR, "state.json");
  const originalState = await readFile(statePath, "utf8");
  await program.parseAsync(["node", "remediate-code", "mcp"]);
  expect(capture.options).toBeDefined();
  const server = createSubmitMcpServer({ ...capture.options!, version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-host", version: "test" });
  await client.connect(clientSide);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(["submit_result", "submit_gate"]);
    expect(tools.find(tool => tool.name === "submit_gate")!.description).toContain("Obtain the user's decisions first");
    const result = { plan_id: state.plan!.plan_id, items: [{ unit_id: "B-001", action: "ignore", rationale: 'Keep \\s and "quotes"' }] };
    const submit = (value: unknown, lane = "triage") => client.callTool({ name: "submit_gate", arguments: {
      root: harness.REPO_DIR, artifacts_dir: harness.ARTIFACTS_DIR, lane, result: value,
    } });
    expect((await submit(result)).isError).not.toBe(true);
    const path = join(harness.ARTIFACTS_DIR, "triage_resolution.json");
    const bytes = await readFile(path, "utf8");
    expect(JSON.parse(bytes)).toEqual(result);
    expect(await readFile(statePath, "utf8")).toBe(originalState);
    for (const invalid of [{}, [], { items: [{ unit_id: "unknown", action: "ignore" }] },
      { items: [{ unit_id: "B-001", action: "invalid" }] }, { ...result, plan_id: "stale" }]) {
      expect((await submit(invalid)).isError).toBe(true);
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect(await readFile(statePath, "utf8")).toBe(originalState);
    }
    expect((await submit(result, "../../escape")).isError).toBe(true);
    for (const changed of [
      { ...state, status: "planning" as const },
      { ...state, items: { "B-001": { unit_id: "B-001", status: "resolved" as const }, "B-002": state.items!["B-002"]! } },
    ]) {
      await harness.saveState(changed);
      const changedBytes = await readFile(statePath, "utf8");
      expect((await submit(result)).isError).toBe(true);
      expect(await readFile(path, "utf8")).toBe(bytes);
      expect(await readFile(statePath, "utf8")).toBe(changedBytes);
    }
    await harness.saveState(state);
    // Legacy file submissions intentionally permit an omitted plan id.
    expect((await submit({ items: result.items })).isError).not.toBe(true);
    const next = await runTriagePhase(state, { root: harness.REPO_DIR, artifactsDir: harness.ARTIFACTS_DIR });
    expect(next.items!["B-001"]!.status).toBe("ignored");
    expect(next.status).toBe("closing");
  } finally { await client.close(); await server.close(); }
});

test("triage admission refuses malformed JSON, unsupported lanes and absent runs without creating a submission", async () => {
  await harness.resetTestRepo();
  const submit = (source: string, lane = "triage") => submitRemediationGateResult({ artifactsDir: harness.ARTIFACTS_DIR, lane, source });
  expect(await submit("{")).toMatchObject({ written: false, issues: [{ code: "invalid_json" }] });
  expect(await submit("{}", "../../escape")).toMatchObject({ written: false, issues: [{ code: "unsupported_lane" }] });
  expect(await submit('{"items":[]}')).toMatchObject({ written: false, issues: [{ code: "triage_not_pending" }] });
  await expect(readFile(join(harness.ARTIFACTS_DIR, "triage_resolution.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("built remediation MCP exposes triage and writes only its bound decision file", async () => {
  await harness.resetTestRepo();
  await harness.saveState(makePlanningState({ status: "triage", items: {
    "B-001": { unit_id: "B-001", status: "blocked" },
    "B-002": { unit_id: "B-002", status: "pending" },
  } }));
  const statePath = join(harness.ARTIFACTS_DIR, "state.json");
  const before = await readFile(statePath, "utf8");
  const client = new Client({ name: "test-built-host", version: "test" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/remediate/index.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = { items: [{ unit_id: "B-001", action: "retry", rationale: 'Retain \\s and "quotes"' }] };
    const call = await client.callTool({ name: "submit_gate", arguments: {
      root: harness.REPO_DIR, artifacts_dir: harness.ARTIFACTS_DIR, lane: "triage", result,
    } });
    expect(call.isError).not.toBe(true);
    const report = JSON.parse((call.content as Array<{ text: string }>)[0]!.text);
    expect(Object.keys(report).sort()).toEqual(["issues", "path", "written"]);
    expect(JSON.parse(await readFile(join(harness.ARTIFACTS_DIR, "triage_resolution.json"), "utf8"))).toEqual(result);
    expect(await readFile(statePath, "utf8")).toBe(before);
  } finally { await client.close(); await transport.close(); }
});
