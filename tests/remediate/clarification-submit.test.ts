import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { submitRemediationGateResult } from "../../src/remediate/steps/submitGateResult.js";

const harness = createNextStepHarness(".test-clarification-submit");
const statePath = join(harness.ARTIFACTS_DIR, "state.json");
const resolutionPath = join(harness.ARTIFACTS_DIR, "clarification_resolution.json");
const answer = { unit_id: "B-001", action: "clarified", rationale: 'Keep \\s and "quotes"; do not widen scope.' };
function pausedState() {
  return makePlanningState({ status: "waiting_for_clarification", items: Object.fromEntries(
    ["B-001", "B-002"].map(unit_id => [unit_id, { unit_id, status: "needs_clarification" as const,
      clarification_question: { category: "scope_of_fix" as const, description: `Question for ${unit_id}?` } }]),
  ) });
}
async function start() {
  await harness.resetTestRepo();
  const state = pausedState();
  await harness.writeIntentCheckpoint();
  await writeApprovedPlanFixture(harness.ARTIFACTS_DIR, state);
  await harness.saveState(state);
  await harness.acknowledgeResume();
  return state;
}
const submit = (value: unknown) => submitRemediationGateResult({ artifactsDir: harness.ARTIFACTS_DIR,
  lane: "clarification", source: JSON.stringify(value) });
afterEach(async () => { await harness.cleanupTestRepo(); });

test.each(["clarified", "reject_finding", "defer"] as const)("built MCP admits %s without applying it; the file consumer owns the transition", async action => {
  await start();
  const before = await readFile(statePath, "utf8");
  const client = new Client({ name: "clarification-host", version: "test" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/remediate/index.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "submit_gate")!.description).toContain("Obtain the user's decisions first");
    const result = [{ ...answer, action }];
    const call = await client.callTool({ name: "submit_gate", arguments: {
      root: harness.REPO_DIR, artifacts_dir: harness.ARTIFACTS_DIR, lane: "clarification", result,
    } });
    expect(call.isError).not.toBe(true);
    const report = JSON.parse((call.content as Array<{ text: string }>)[0]!.text);
    expect(Object.keys(report).sort()).toEqual(["issues", "path", "written"]);
    expect(report.path).toBe(resolutionPath);
    expect(JSON.parse(await readFile(resolutionPath, "utf8"))).toEqual(result);
    expect(await readFile(statePath, "utf8")).toBe(before);
    await decideNextStep({ root: harness.REPO_DIR });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    expect(after.items["B-001"].status).toBe(action === "clarified" ? "pending" : action === "defer" ? "ignored" : "deemed_inappropriate");
    expect(after.items["B-001"].clarification_question).toBeUndefined();
    if (action === "clarified") expect(after.items["B-001"].clarification_context).toBe(answer.rationale);
    expect(after.items["B-002"].status).toBe("needs_clarification");
    expect(after.plan).toEqual(JSON.parse(before).plan);
    await expect(readFile(resolutionPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await client.close(); await transport.close(); }
});

test.each([
  { label: "object wrapper", value: { resolutions: [answer] } },
  { label: "duplicate unit", value: [answer, answer] },
  { label: "unknown unit", value: [answer, { ...answer, unit_id: "unknown" }] },
  { label: "invalid action", value: [answer, { unit_id: "B-002", action: "approve" }] },
  { label: "missing answer", value: [{ unit_id: "B-001", action: "clarified" }] },
  { label: "blank answer", value: [{ ...answer, rationale: "  " }] },
  { label: "retired scope expansion", value: [{ ...answer, scope_additions: ["secret.ts"] }] },
])("clarification refuses $label atomically without replacing an accepted submission", async ({ value }) => {
  await start();
  expect(await submit([answer])).toMatchObject({ written: true });
  const bytes = await readFile(resolutionPath, "utf8");
  const state = await readFile(statePath, "utf8");
  expect(await submit(value)).toMatchObject({ written: false });
  expect(await readFile(resolutionPath, "utf8")).toBe(bytes);
  expect(await readFile(statePath, "utf8")).toBe(state);
});

test("clarification preserves the file route's empty and partial answer semantics", async () => {
  await start();
  expect(await submit([])).toMatchObject({ written: true });
  const step = await decideNextStep({ root: harness.REPO_DIR });
  expect(step.step_kind).toBe("collect_clarifications");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  expect(state.items["B-001"].status).toBe("needs_clarification");
  expect(state.items["B-002"].status).toBe("needs_clarification");
  expect(await submit([{ unit_id: "B-001", action: "defer" }])).toMatchObject({ written: true });
  await decideNextStep({ root: harness.REPO_DIR });
  const after = JSON.parse(await readFile(statePath, "utf8"));
  expect(after.status).toBe("waiting_for_clarification");
  expect(after.items["B-001"].status).toBe("ignored");
  expect(after.items["B-002"].status).toBe("needs_clarification");
});

test("admission and later consumption each reject units no longer waiting for an answer", async () => {
  const state = await start();
  expect(await submit([answer])).toMatchObject({ written: true });
  const bytes = await readFile(resolutionPath, "utf8");
  state.items!["B-001"] = { unit_id: "B-001", status: "resolved" };
  await harness.saveState(state);
  expect(await submit([answer])).toMatchObject({ written: false });
  expect(await readFile(resolutionPath, "utf8")).toBe(bytes);
  const step = await decideNextStep({ root: harness.REPO_DIR });
  expect(step.step_kind).toBe("collect_clarifications");
  expect(await readFile(step.prompt_path, "utf8")).toContain("not waiting for a clarification");
  const after = JSON.parse(await readFile(statePath, "utf8"));
  expect(after.items["B-001"].status).toBe("resolved");
  expect(after.items["B-002"].status).toBe("needs_clarification");
});

test("absent or nonpending clarification runs and malformed JSON write nothing", async () => {
  await harness.resetTestRepo();
  expect(await submit([answer])).toMatchObject({ written: false, issues: [{ code: "clarification_not_pending" }] });
  expect(await submitRemediationGateResult({ artifactsDir: harness.ARTIFACTS_DIR, lane: "clarification", source: "{" }))
    .toMatchObject({ written: false, issues: [{ code: "invalid_json" }] });
  for (const state of [makePlanningState(), { ...pausedState(), status: "implementing" as const },
    makePlanningState({ status: "waiting_for_clarification" })]) {
    await harness.saveState(state);
    const before = await readFile(statePath, "utf8");
    expect(await submit([answer])).toMatchObject({ written: false, issues: [{ code: "clarification_not_pending" }] });
    expect(await readFile(statePath, "utf8")).toBe(before);
  }
  await expect(readFile(resolutionPath)).rejects.toMatchObject({ code: "ENOENT" });
});
