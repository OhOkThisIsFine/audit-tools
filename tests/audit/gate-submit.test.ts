import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSubmitMcpServer } from "../../src/shared/mcp/submitServer.js";

// Gate submission is opt-in: callers without a callback retain the one-tool surface.
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

import { submitGateResult, SUPPORTED_GATE_SUBMISSIONS } from "../../src/audit/cli/submitGateResult.js";
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
    for (const unsupported of Object.values(GATE_LANES).filter(value => !SUPPORTED_GATE_SUBMISSIONS.some(supported => supported === value))) {
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

import { writeJsonFile } from "audit-tools/shared";
import type { IntentCheckpoint } from "audit-tools/shared";
import { loadArtifactBundle, type ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { deriveIntentEquivalenceStatus, runIntentEquivalenceResolve, type IntentEquivalenceVerdictSubmission } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";

function pendingIntentBundle(): ArtifactBundle {
  const prior: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1", confirmed_at: "2026-11-08T00:00:00Z",
    confirmed_by: "host", scope_summary: "Audit source", intent_summary: "Find defects",
  };
  const baseline = runIntentEquivalenceResolve({ intent_checkpoint: prior }).updated;
  baseline.artifact_metadata!.artifacts["intent_checkpoint.json"] = {
    revision: 1, content_hash: "fixture", dependency_revisions: {},
  };
  return { ...baseline, intent_checkpoint: { ...prior, scope_summary: "Review source" } };
}

async function writeIntentBundle(artifactsDir: string, bundle: ArtifactBundle): Promise<void> {
  for (const key of ["intent_checkpoint", "artifact_metadata"] as const) {
    const path = join(artifactsDir, `${key}.json`);
    if (bundle[key]) await writeJsonFile(path, bundle[key]);
    else await rm(path, { force: true });
  }
}

function verdictFor(bundle: ArtifactBundle, verdict: "equivalent" | "changed" = "equivalent"): IntentEquivalenceVerdictSubmission {
  const status = deriveIntentEquivalenceStatus(bundle);
  if (status.kind !== "prose_judgment_pending") throw new Error("Expected pending intent judgment");
  return { verdict, rationale: 'Preserve \\s and "quotes"',
    judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash } };
}

test("intent gate admits both live verdicts through the existing consumer and executor", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "intent-gate-submit-"));
  try {
    for (const verdict of ["equivalent", "changed"] as const) {
      const bundle = pendingIntentBundle();
      await writeIntentBundle(artifactsDir, bundle);
      const result = verdictFor(bundle, verdict);
      expect(await submitGateResult({ artifactsDir, lane: GATE_LANES.intent_equivalence, source: JSON.stringify(result) }))
        .toMatchObject({ written: true, issues: [] });
      const consumed = await tryConsumeSubmission<IntentEquivalenceVerdictSubmission>(artifactsDir, GATE_LANES.intent_equivalence);
      expect(consumed).toMatchObject({ status: "ok", value: result });
      if (consumed.status !== "ok") throw new Error("Expected accepted intent verdict");
      const resolved = runIntentEquivalenceResolve(await loadArtifactBundle(artifactsDir), consumed.value);
      expect(deriveIntentEquivalenceStatus(resolved.updated).kind).toBe("satisfied");
      expect(resolved.updated.artifact_metadata?.intent_baseline?.revision).toBe(verdict === "equivalent" ? 1 : 2);
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("intent gate rejects malformed, stale, and non-pending submissions without replacing accepted bytes", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "intent-gate-reject-"));
  const lane = GATE_LANES.intent_equivalence;
  try {
    const bundle = pendingIntentBundle();
    await writeIntentBundle(artifactsDir, bundle);
    const result = verdictFor(bundle);
    expect((await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) })).written).toBe(true);
    const path = laneSubmissionPath(artifactsDir, lane);
    const bytes = await readFile(path, "utf8");
    for (const source of ['{', '{}', JSON.stringify({ ...result, review: {} }),
      JSON.stringify({ ...result, verdict: "yes" }), JSON.stringify({ ...result, judged_pair: { prior_hash: 4, new_hash: "x" } })]) {
      expect((await submitGateResult({ artifactsDir, lane, source })).written).toBe(false);
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    for (const field of ["prior_hash", "new_hash"] as const) {
      const stale = { ...result, judged_pair: { ...result.judged_pair, [field]: "stale" } };
      expect(await submitGateResult({ artifactsDir, lane, source: JSON.stringify(stale) }))
        .toMatchObject({ written: false, issues: [{ code: "stale_intent_pair" }] });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    const metadata = bundle.artifact_metadata!;
    const checkpoint = bundle.intent_checkpoint!;
    const nonPending: ArtifactBundle[] = [
      {}, { intent_checkpoint: checkpoint },
      runIntentEquivalenceResolve(bundle, result).updated,
      { ...bundle, intent_checkpoint: { ...checkpoint, lens_selection: { exclude: ["tests"] } } },
      { ...bundle, artifact_metadata: { ...metadata, intent_baseline: { ...metadata.intent_baseline!, gate_version: "old" } } },
    ];
    for (const next of nonPending) {
      await writeIntentBundle(artifactsDir, next);
      expect(await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) }))
        .toMatchObject({ written: false, issues: [{ code: "intent_judgment_not_pending" }] });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("intent consumer still rejects a checkpoint change after successful submission", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "intent-gate-race-"));
  try {
    const bundle = pendingIntentBundle();
    await writeIntentBundle(artifactsDir, bundle);
    expect((await submitGateResult({ artifactsDir, lane: GATE_LANES.intent_equivalence, source: JSON.stringify(verdictFor(bundle)) })).written).toBe(true);
    await writeIntentBundle(artifactsDir, { ...bundle, intent_checkpoint: { ...bundle.intent_checkpoint!, scope_summary: "A different scope" } });
    const live = await loadArtifactBundle(artifactsDir);
    const consumed = await tryConsumeSubmission<IntentEquivalenceVerdictSubmission>(artifactsDir, GATE_LANES.intent_equivalence);
    if (consumed.status !== "ok") throw new Error("Expected stored verdict");
    expect(runIntentEquivalenceResolve(live, consumed.value).updated).toBe(live);
    expect(deriveIntentEquivalenceStatus(live).kind).toBe("prose_judgment_pending");
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

import { handleGraphEnrichmentBranch } from "../../src/audit/cli/nextStepHelpers.js";
import { createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { runGraphEnrichmentExecutor } from "../../src/audit/orchestrator/graphEnrichmentExecutor.js";

test("edge gate preserves tolerant file shapes and refuses invalid replacements", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "edge-gate-shapes-"));
  const lane = GATE_LANES.edge_reasoning;
  const rewrites = [{ from: "a.ts", to: "b.ts", reason: 'Keep \\s and "quotes"' }];
  try {
    const path = laneSubmissionPath(artifactsDir, lane);
    for (const result of [rewrites, { rewrites }, { alternate: rewrites }, [], { rewrites: [] }]) {
      expect(await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) }))
        .toMatchObject({ written: true, path, issues: [] });
      const bytes = await readFile(path, "utf8");
      for (const source of ['{', 'null', '42', '"text"', '{}', '{"rewrites":{}}',
        '{"rewrites":[],"other":[]}', '{"rewrites":[],"review":{}}']) {
        expect((await submitGateResult({ artifactsDir, lane, source })).written).toBe(false);
        expect(await readFile(path, "utf8")).toBe(bytes);
      }
      expect(await tryConsumeSubmission(artifactsDir, lane)).toMatchObject({ status: "ok", value: result });
    }
    for (const lane of [GATE_LANES.synthesis_narrative, GATE_LANES.critical_flow_fallback, GATE_LANES.intent_equivalence]) {
      expect((await submitGateResult({ artifactsDir, lane, source: '[]' })).written).toBe(false);
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("submitted edge rewrites retain the consumer flag and executor graph limits", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "edge-gate-consumer-"));
  const lane = GATE_LANES.edge_reasoning;
  const reason = 'Keep \\s and "quotes"';
  const rewrites = [
    { from: "a.ts", to: "b.ts", kind: "heuristic", reason, confidence: 1, direction: "undirected" },
    { from: "a.ts", to: "b.ts", reason: "duplicate must not replace first" },
    { from: "a.ts", to: "c.ts", reason: "high confidence must not change" },
    { from: "unknown.ts", to: "b.ts", reason: "must not add an edge" },
    null, { from: "a.ts", to: "b.ts", reason: 42 },
  ];
  try {
    for (const result of [rewrites, { rewrites }, { alternate: rewrites }]) {
      const bundle: ArtifactBundle = {
        repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-11-08T00:00:00Z", files: [] },
        file_disposition: { files: [] },
        graph_bundle: { graphs: { imports: [
          { from: "a.ts", to: "b.ts", kind: "heuristic", confidence: 0.2, direction: "directed", reason: "old" },
          { from: "a.ts", to: "c.ts", kind: "import", confidence: 0.95, direction: "directed", reason: "import" },
        ], calls: [], references: [] } },
      };
      const expected = structuredClone(bundle.graph_bundle!);
      expected.graphs.imports![0]!.reason = reason;
      expect((await submitGateResult({ artifactsDir, lane, source: JSON.stringify(result) })).written).toBe(true);
      const path = laneSubmissionPath(artifactsDir, lane);
      const bytes = await readFile(path, "utf8");
      const params = { root: artifactsDir, sourceRoot: artifactsDir, artifactsDir, graphLlmEdgeReasoning: false };
      const state = { status: "active" as const, obligations: [] };
      const tx = createFoldTransaction();
      let executions = 0;
      const deps: NonNullable<Parameters<typeof handleGraphEnrichmentBranch>[5]> = {
        unresolvedAnalyzers: () => [],
        runStep: async (options, carried) => {
          executions++;
          expect(options.preferredExecutor).toBe("graph_enrichment_executor");
          const applied = await runGraphEnrichmentExecutor(carried, {
            root: artifactsDir, registry: [], llmEdgeReasoning: options.graphLlmEdgeReasoning,
            edgeReasoning: options.edgeReasoningResults,
          });
          return { audit_state: state, selected_obligation: null, selected_executor: "graph_enrichment_executor",
            progress_made: true, artifacts_written: applied.artifacts_written, progress_summary: "",
            next_likely_step: null, updated_bundle: applied.updated };
        },
      };
      expect(await handleGraphEnrichmentBranch(params, bundle, state, { value: undefined }, tx, deps))
        .toMatchObject({ action: "fallthrough" });
      expect(executions).toBe(0);
      expect(await readFile(path, "utf8")).toBe(bytes);
      const branch = await handleGraphEnrichmentBranch({ ...params, graphLlmEdgeReasoning: true }, bundle, state, { value: undefined }, tx, deps);
      expect(executions).toBe(1);
      expect(branch).toMatchObject({ action: "continue", bundle: { graph_bundle: expected } });
      if (branch.action !== "continue") throw new Error("Expected applied edge reasoning");
      expect(branch.bundle.graph_bundle).toEqual(expected);
      expect(tx.staged).toHaveLength(1);
      expect(tx.staged[0]!.applied).toBe(true);
    }
  } finally { await rm(artifactsDir, { recursive: true, force: true }); }
});

test("built MCP edge gate round-trips arrays and wrappers without weakening other lanes", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "edge-gate-mcp-"));
  const client = new Client({ name: "edge-test-host", version: "test" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/audit/cli.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const args = { root: artifactsDir, artifacts_dir: artifactsDir, lane: GATE_LANES.edge_reasoning };
    const rewrites = [{ from: "a.ts", to: "b.ts", reason: 'Keep \\s and "quotes"' }];
    const path = laneSubmissionPath(artifactsDir, args.lane);
    for (const result of [rewrites, { rewrites }, { alternate: rewrites }, []]) {
      expect((await client.callTool({ name: "submit_gate", arguments: { ...args, result } })).isError).not.toBe(true);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    }
    const bytes = await readFile(path, "utf8");
    for (const result of [{ rewrites: [], other: [] }, { rewrites: [], review: {} }, null, 42]) {
      expect((await client.callTool({ name: "submit_gate", arguments: { ...args, result } })).isError).toBe(true);
      expect(await readFile(path, "utf8")).toBe(bytes);
    }
    for (const lane of [GATE_LANES.analyzer_consent, GATE_LANES.analyzer_decisions, GATE_LANES.design_review_contract]) {
      expect((await client.callTool({ name: "submit_gate", arguments: { ...args, lane, result: {} } })).isError).toBe(true);
    }
    expect((await client.callTool({ name: "submit_gate", arguments: { ...args, lane: GATE_LANES.synthesis_narrative, result: [] } })).isError).toBe(true);
    expect((await client.callTool({ name: "submit_result", arguments: { root: artifactsDir, work_item_id: "fixture", result: [] } })).isError).toBe(true);
  } finally {
    await client.close(); await transport.close();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});

test("built MCP submit_gate admits the live intent pair and reports stale pairs as errors", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "intent-gate-mcp-"));
  const client = new Client({ name: "intent-test-host", version: "test" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/audit/cli.js", import.meta.url)), "mcp"],
    env: process.env as Record<string, string>, stderr: "pipe",
  });
  try {
    const bundle = pendingIntentBundle();
    await writeIntentBundle(artifactsDir, bundle);
    await client.connect(transport);
    const result = verdictFor(bundle);
    const arguments_ = { root: artifactsDir, artifacts_dir: artifactsDir, lane: GATE_LANES.intent_equivalence, result };
    const admitted = await client.callTool({ name: "submit_gate", arguments: arguments_ });
    expect(admitted.isError).not.toBe(true);
    expect(admitted.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text" })]));
    expect(JSON.parse((admitted.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ written: true, issues: [] });
    const path = laneSubmissionPath(artifactsDir, GATE_LANES.intent_equivalence);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
    const bytes = await readFile(path, "utf8");
    const refused = await client.callTool({ name: "submit_gate", arguments: {
      ...arguments_, result: { ...result, judged_pair: { ...result.judged_pair, new_hash: "stale" } },
    } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ written: false, issues: [{ code: "stale_intent_pair" }] });
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await client.close();
    await transport.close();
    await rm(artifactsDir, { recursive: true, force: true });
  }
});
