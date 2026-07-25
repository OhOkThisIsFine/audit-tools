// The HYBRID DECISION POINT, driven end-to-end (H2+H4 collapse residual pin).
//
// Every existing hybrid test calls the two halves DIRECTLY — `planHybridDispatch`
// with a hand-built pool array, then `driveRollingImplementDispatch` with a
// hand-built `poolsOverride`. Nothing drove the production decision point in
// `buildImplementDispatchStep` (an unexported branch reachable only through
// `decideNextStep`) and asserted which pools the drive ACTUALLY receives. The
// settled-pool exclusion there
//
//     const liveBackendPools = backendPools.filter((p) => !settled.has(p.id));
//
// is the one part of the split the coordinator cannot enforce for the drive: the
// coordinator's claim walk drops a settled pool from its OWN assignment, but the
// engine's per-packet selection binds freely across `poolsOverride`, so a pool
// settled on a PRIOR cycle would be re-offered and re-die every cycle. Hand-passing
// `poolsOverride` in a test asserts the engine, never the decision that built it.
//
// This harness closes that: two real openai-compatible backend sources served by a
// LOCAL stub endpoint (so "which pool the drive received" is observable as network
// traffic, not as an argument we passed ourselves), one of them pre-seeded into the
// run's cross-cycle settled set, driven through `decideNextStep`.
//
// The settled pool is declared `cost_per_mtok: 0` and the live one `5`, so it is the
// pool cost-first admission would PREFER — the exclusion is therefore load-bearing,
// not incidentally satisfied by ordering.
//
// Red on HEAD with the filter neutralized (`liveBackendPools` → `backendPools`):
// every node dispatches to the settled endpoint.

import { afterAll, describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { nodeSettledPoolsPath } from "../../src/remediate/steps/rollingSession.js";
import { addSettledPool, type SessionConfig } from "audit-tools/shared";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const PLAN_ID = "PLAN-HYB-DP";
/**
 * Explicit `id` + explicit `account` on each source, so the CapacityPool key is
 * `${id}#${account}` by construction — the settled set must be seeded with the exact
 * id the decision point will filter on, and deriving it from credential resolution
 * would make the fixture depend on the ambient environment.
 */
const POOL_SETTLED = "stub-settled#acct-settled";
const POOL_LIVE = "stub-live#acct-live";

const NODES = [
  { id: "F-001", block: "B-001", file: "alpha.mjs", content: "export const alpha = 1;\n" },
  { id: "F-002", block: "B-002", file: "beta.mjs", content: "export const beta = 2;\n" },
  { id: "F-003", block: "B-003", file: "gamma.mjs", content: "export const gamma = 3;\n" },
];

function buildState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: PLAN_ID,
      findings: NODES.map((n) => ({
        id: n.id,
        title: `Create ${n.file}`,
        category: "correctness",
        severity: "low",
        confidence: "high",
        lens: "correctness",
        summary: `Create ${n.file}.`,
        affected_files: [{ path: n.file }],
        evidence: [`${n.file}:1`],
      })),
      blocks: NODES.map((n) => ({
        block_id: n.block,
        items: [n.id],
        parallel_safe: true,
        dependencies: [],
        touched_files: [n.file],
      })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      NODES.map((n) => [
        n.id,
        {
          finding_id: n.id,
          status: "pending",
          block_id: n.block,
          item_spec: {
            finding_id: n.id,
            concrete_change: `Create ${n.file} containing exactly: ${n.content}`,
            no_change: false,
            touched_files: [n.file],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      ]),
    ),
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

/**
 * One local endpoint serving BOTH sources on distinct path prefixes, so the pool a
 * node actually ran on is observable as a request that arrived — the property the
 * decision point owns and no hand-passed `poolsOverride` can demonstrate.
 */
interface StubEndpoint {
  server: Server;
  baseUrlFor(lane: string): string;
  hits(lane: string): string[];
}

async function startStubEndpoint(): Promise<StubEndpoint> {
  const hits = new Map<string, string[]>();
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const lane = url.split("/")[1] ?? "";
    if (req.method !== "POST") {
      // Liveness probes (`/v1/models`) — any status counts as alive.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const node = NODES.find((n) => body.includes(n.id));
      const laneHits = hits.get(lane) ?? [];
      laneHits.push(node?.block ?? "unknown");
      hits.set(lane, laneHits);
      const content = JSON.stringify({
        files: node ? [{ path: node.file, content: node.content }] : [],
        result: {
          contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
          phase: "implement",
          item_results: node
            ? [{ finding_id: node.id, status: "resolved", evidence: ["stub endpoint landed the file"] }]
            : [],
        },
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    baseUrlFor: (lane) => `http://127.0.0.1:${port}/${lane}/v1`,
    hits: (lane) => hits.get(lane) ?? [],
  };
}

/** Every `engine_admitted` pool id in the drive's own decision log. */
async function admittedPoolIds(explainsPath: string): Promise<string[]> {
  if (!existsSync(explainsPath)) return [];
  const raw = await readFile(explainsPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { kind: string; pool_id?: string })
    .filter((rec) => rec.kind === "engine_admitted")
    .map((rec) => rec.pool_id ?? "");
}

describe("hybrid decision point — the pools the drive receives (H2+H4 residual pin)", () => {
  const harness = createNextStepHarness(".test-hybrid-decision-point-pools");
  let endpoint: StubEndpoint | null = null;
  afterAll(async () => {
    if (endpoint) await new Promise<void>((resolve) => endpoint!.server.close(() => resolve()));
    await harness.cleanupTestRepo();
  });

  it(
    "excludes a CROSS-CYCLE settled backend pool from the drive: no node is dispatched to it, even though it is the cost-preferred pool",
    async () => {
      endpoint = await startStubEndpoint();
      await harness.resetTestRepo();
      const { REPO_DIR, ARTIFACTS_DIR } = harness;

      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false });
      expect(git("init").status).toBe(0);
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      // Trivial cross-platform `check` so each node's derived verify resolves + passes.
      await writeFile(
        join(REPO_DIR, "package.json"),
        JSON.stringify({ name: "hyb-dp", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
        "utf8",
      );
      await writeFile(join(REPO_DIR, ".gitignore"), "node_modules/\n.audit-tools/\n", "utf8");
      git("add", "package.json", ".gitignore");
      git("commit", "-m", "base");

      await new StateStore(ARTIFACTS_DIR).saveState(buildState());
      await harness.acknowledgeResume();
      await harness.writeIntentCheckpoint();

      // provider = the conversation HOST (so `canDispatchImpl` takes the hybrid
      // branch); two openai-compatible SOURCES are the in-process backend pools.
      // Passed as the EFFECTIVE config, not written to session-config.json: dispatch
      // inventory (`provider` / `sources`) is descriptor-borne and the persisted-intent
      // validator refuses it on disk.
      const source = (id: string, account: string, lane: string, cost: number) => ({
        id,
        account,
        transport: "openai-compatible" as const,
        endpoint: endpoint!.baseUrlFor(lane),
        model: `stub/${lane}`,
        api_key: "stub-key",
        cost_per_mtok: cost,
        quota: { context_tokens: 200_000, max_concurrent: 2 },
      });
      const sessionConfig: SessionConfig = {
        provider: "claude-code",
        sources: [
          // Declared FREE → cost-first admission prefers it. It is also the pool
          // that settled on a prior cycle, so the drive must never see it.
          source("stub-settled", "acct-settled", "settled", 0),
          source("stub-live", "acct-live", "live", 5),
        ],
        timeout_ms: 60_000,
      };

      // The cross-cycle fact: the free pool exhausted on an earlier cycle.
      await addSettledPool(nodeSettledPoolsPath(ARTIFACTS_DIR, PLAN_ID), POOL_SETTLED);

      await decideNextStep({
        root: REPO_DIR,
        hostCanDispatchSubagents: true,
        hostMaxConcurrent: 1,
        rollingEngine: true,
        sessionConfig,
      });

      // The in-process partition ran, and it ran ONLY on the live pool: the settled
      // endpoint received no request at all.
      expect(endpoint.hits("live").length).toBeGreaterThan(0);
      expect(endpoint.hits("settled")).toEqual([]);

      // Same fact from the drive's own decision log: every admitted packet bound the
      // live pool. (Belt-and-braces: traffic proves the launch, the log proves the
      // engine's selection — a settled pool merely OFFERED would show up here.)
      const admitted = await admittedPoolIds(
        join(ARTIFACTS_DIR, "runs", PLAN_ID, "implement", "dispatch-explains.jsonl"),
      );
      expect(admitted.length).toBeGreaterThan(0);
      expect([...new Set(admitted)]).toEqual([POOL_LIVE]);

      // End-to-end, not just routing: the live pool's work landed on HEAD.
      const landed = NODES.filter((n) => git("show", `HEAD:${n.file}`).status === 0);
      expect(landed.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
