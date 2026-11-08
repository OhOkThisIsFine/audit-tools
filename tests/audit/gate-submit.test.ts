import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSubmitMcpServer } from "../../src/shared/mcp/submitServer.js";

// The audit callback is optional: remediation retains the existing one-tool surface.
test("optional gate transport preserves objects and rejects lanes outside its declared surface", async () => {
  const seen: unknown[] = [];
  const server = createSubmitMcpServer({ name: "audit-code", version: "test", submit: async () => ({ written: true }),
    gateSubmission: { lanes: ["synthesis_narrative"], submit: async request => { seen.push(request); return { written: true }; } },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "test" });
  await client.connect(clientSide);
  try {
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["submit_result", "submit_gate"]);
    const result = { themes: [], executive_summary: 'Keep \\s and "quotes" intact' };
    expect((await client.callTool({ name: "submit_gate", arguments: { root: "/repo", lane: "synthesis_narrative", result } })).isError).not.toBe(true);
    expect(seen).toEqual([{ root: "/repo", artifactsDir: undefined, lane: "synthesis_narrative", source: JSON.stringify(result, null, 2) }]);
    const refused = await client.callTool({ name: "submit_gate", arguments: { root: "/repo", lane: "design_review_contract", result } });
    expect(refused.isError).toBe(true);
    expect(seen).toHaveLength(1);
  } finally { await client.close(); await server.close(); }
});

import { submitGateResult } from "../../src/audit/cli/submitGateResult.js";
import { GATE_LANES, laneSubmissionPath } from "../../src/audit/cli/laneSubmissions.js";
import { tryConsumeSubmission } from "../../src/audit/cli/nextStepHelpers.js";

test("critical-flow gate preserves the file contract and rejects invalid replacements", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "flow-gate-submit-"));
  const lane = GATE_LANES.critical_flow_fallback;
  const flow = { id: "flow:auth", name: 'Keep \\s and "quotes"', entrypoints: ["src/auth.ts"],
    paths: ["src/auth.ts"], concerns: ["security"], confidence: "high", notes: ["host enrichment"] };
  try {
    const path = laneSubmissionPath(artifactsDir, lane);
    for (const result of [{ flows: [flow] }, { flows: [] }]) {
      expect(await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) }))
        .toMatchObject({ written: true, path, issues: [] });
      const bytes = await readFile(path, "utf8");
      for (const source of ['{', '{}', '[]', JSON.stringify({ flows: {} }),
        JSON.stringify({ flows: [{ ...flow, confidence: "medium" }] }),
        JSON.stringify({ flows: [{ ...flow, paths: "src/auth.ts" }] }),
        JSON.stringify({ flows: [{ ...flow, extra: true }] }),
        JSON.stringify({ flows: [], review: {} }), JSON.stringify({ result })]) {
        expect((await submitGateResult({ artifactsDir, lane, source })).written).toBe(false);
        expect(await readFile(path, "utf8")).toBe(bytes);
      }
      expect(await tryConsumeSubmission(artifactsDir, lane)).toMatchObject({ status: "ok", value: result });
    }
    for (const unsupported of Object.values(GATE_LANES).filter(value => value !== lane && value !== GATE_LANES.synthesis_narrative)) {
      expect(await submitGateResult({ artifactsDir, lane: unsupported, source: '{"flows":[]}' }))
        .toMatchObject({ written: false, issues: [{ code: "unsupported_lane" }] });
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("accepted narrative reaches the existing lane consumer intact, and rejection preserves it", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "gate-submit-"));
  try {
    const result = { themes: [], executive_summary: 'Keep \\s and "quotes" intact' };
    const path = laneSubmissionPath(artifactsDir, "synthesis_narrative");
    const accepted = await submitGateResult({ artifactsDir, lane: "synthesis_narrative", source: JSON.stringify(result) });
    expect(accepted).toMatchObject({ written: true, path, issues: [] });
    const bytes = await readFile(path, "utf8");
    for (const source of ['{', '{}', '{"themes":"invalid"}', '{"result":{"themes":[]},"review":{}}']) {
      expect((await submitGateResult({ artifactsDir, lane: "synthesis_narrative", source })).written).toBe(false);
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    expect((await submitGateResult({ artifactsDir, lane: "design_review_contract", source: JSON.stringify(result) })).written).toBe(false);
    expect((await submitGateResult({ artifactsDir, lane: "../../escaped", source: JSON.stringify(result) })).written).toBe(false);
    const incoming = await tryConsumeSubmission(artifactsDir, "synthesis_narrative");
    expect(incoming).toMatchObject({ status: "ok", value: result });
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});
