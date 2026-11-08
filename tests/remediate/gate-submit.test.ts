import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSubmitMcpServer, type SubmitServerOptions } from "../../src/shared/mcp/submitServer.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import { submitRemediationGateResult } from "../../src/remediate/steps/submitGateResult.js";
import { checkConformanceSubject, conformanceReviewPaths } from "../../src/remediate/steps/dispatch/contractConformanceReview.js";

const capture = vi.hoisted(() => ({ options: undefined as Omit<SubmitServerOptions, "version"> | undefined }));
vi.mock("audit-tools/shared/mcp/submitServer", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/shared/mcp/submitServer.js")>(),
  serveSubmitMcpOverStdio: async (options: Omit<SubmitServerOptions, "version">) => { capture.options = options; },
}));
import { program } from "../../src/remediate/index.js";

const harness = createNextStepHarness(".test-remediation-gate-submit");
afterEach(async () => { await harness.cleanupTestRepo(); });

test.each(["implementation", "triage"])("remediation MCP admits a bound independent conformance review without consuming it (%s)", async source => {
  await harness.resetTestRepo();
  const state = makePlanningState({ status: "implementing", items: {
    "B-001": { unit_id: "B-001", status: "pending" },
    "B-002": { unit_id: "B-002", status: "pending" },
  }, conformance_review: { run_id: "PLAN-1", enabled: true } });
  await harness.saveState(state);
  const unit = state.plan!.units.find(unit => unit.id === "B-001")!;
  const subject = { artifactsDir: harness.ARTIFACTS_DIR, runId: state.plan!.plan_id,
    itemId: unit.id, obligationIds: unit.requirement_ids,
    content: { repository_root: harness.REPO_DIR, run_id: state.plan!.plan_id,
      work_item_id: unit.id, review_revision_sha256: state.plan!.review_revision_sha256,
      obligation_ids: unit.requirement_ids, unit },
    evidenceInstruction: "Inspect the bound source and tests independently." };
  if (source === "triage") Object.assign(subject, { content: { context: subject.content, observation: { producer: "triage_required_tests" } } });
  expect((await checkConformanceSubject(subject)).ok).toBe(false);
  const paths = conformanceReviewPaths(subject.artifactsDir, subject.runId, subject.itemId);
  const requestBytes = await readFile(paths.request, "utf8");
  const request = JSON.parse(requestBytes);
  const response = { ...request.response_template,
    declaration: { mode: "independent", reason: "Separate context without implementation reasoning." },
    summary: 'Evidence retains \\s and "quotes"',
  };
  const statePath = join(harness.ARTIFACTS_DIR, "state.json");
  const stateBytes = await readFile(statePath, "utf8");
  await program.parseAsync(["node", "remediate-code", "mcp"]);
  const server = createSubmitMcpServer({ ...capture.options!, version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-conformance-host", version: "test" });
  await client.connect(clientSide);
  try {
    const submit = (result: unknown, workItemId: string | undefined = unit.id) => client.callTool({ name: "submit_gate", arguments: {
      root: harness.REPO_DIR, artifacts_dir: harness.ARTIFACTS_DIR,
      lane: "conformance_review", ...(workItemId ? { work_item_id: workItemId } : {}), result,
    } });
    const call = await submit(response);
    expect(call.isError).not.toBe(true);
    expect(JSON.parse(await readFile(paths.response, "utf8"))).toEqual(response);
    expect(await readFile(paths.request, "utf8")).toBe(requestBytes);
    expect(await readFile(statePath, "utf8")).toBe(stateBytes);
    await expect(readFile(join(subject.artifactsDir, "conformance-review", "subjects", `${request.binding}.review.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const responseBytes = await readFile(paths.response, "utf8");
    for (const invalid of [[], {}, { ...response, binding: "0".repeat(64) },
      { ...response, obligations: [] }, { ...response, obligations: [...response.obligations, ...response.obligations] },
      { ...response, obligations: [{ obligation_id: "unknown", verdict: "satisfied", evidence: ["test"] }] },
      { ...response, declaration: { mode: "independent", reason: "" } }]) {
      expect((await submit(invalid)).isError).toBe(true);
      expect(await readFile(paths.response, "utf8")).toBe(responseBytes);
    }
    for (const id of ["", "unknown", "../../escape"]) {
      expect((await submit(response, id)).isError).toBe(true);
      expect(await readFile(paths.response, "utf8")).toBe(responseBytes);
    }
    for (const changed of [
      { ...state, plan: { ...state.plan!, review_revision_sha256: "0".repeat(64) } },
      { ...state, conformance_review: { run_id: state.plan!.plan_id, enabled: false } },
      { ...state, conformance_review: { run_id: "other-run", enabled: true } },
      { ...state, items: { ...state.items!, [unit.id]: { ...state.items![unit.id]!, status: "resolved" as const } } },
    ]) {
      await harness.saveState(changed);
      const changedBytes = await readFile(statePath, "utf8");
      expect((await submit(response)).isError).toBe(true);
      expect(await readFile(paths.response, "utf8")).toBe(responseBytes);
      expect(await readFile(paths.request, "utf8")).toBe(requestBytes);
      expect(await readFile(statePath, "utf8")).toBe(changedBytes);
      await writeFile(statePath, stateBytes);
    }
    // Neither a stale/tampered request nor caller-selected response_path can
    // redirect admission. The path is derived from the live run and unit.
    await writeFile(paths.request, JSON.stringify({ ...request, binding: "0".repeat(64) }));
    expect((await submit(response)).isError).toBe(true);
    expect(await readFile(paths.response, "utf8")).toBe(responseBytes);
    await writeFile(paths.request, JSON.stringify({ ...request, response_path: join(harness.REPO_DIR, "escape.json") }));
    expect((await submit(response)).isError).not.toBe(true);
    await expect(readFile(join(harness.REPO_DIR, "escape.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(paths.request, requestBytes);
    for (const mode of ["unavailable", "degraded"]) {
      expect((await submit({ ...response, declaration: { mode, reason: "Independent context unavailable." } })).isError).not.toBe(true);
      expect(await checkConformanceSubject(subject)).toMatchObject({ ok: false, issue: { code: "conformance_review_unavailable" } });
    }
    expect((await submit({ ...response, verdict: "insufficient" })).isError).not.toBe(true);
    expect(await checkConformanceSubject(subject)).toMatchObject({ ok: false, issue: { code: "conformance_review_insufficient" } });
    await expect(readFile(join(subject.artifactsDir, "conformance-review", "subjects", `${request.binding}.review.json`))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(statePath, "utf8")).toBe(stateBytes);
    expect((await submit(response)).isError).not.toBe(true);
    expect((await checkConformanceSubject(subject)).ok).toBe(true);
  } finally { await client.close(); await server.close(); }
});

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
