import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareDispatchArtifacts, resolveTierBudgets } = await import(
  "../src/cli/dispatch.ts"
);
const { getHostModelRoster } = await import("../src/cli/args.ts");
const { packageRoot } = await import("../src/cli/paths.ts");

const RUN_ID = "roster-run";

// ── --host-models flag parsing ───────────────────────────────────────────────

const VALID_ROSTER = [
  { rank: "small", context_tokens: 32000, output_tokens: 8000 },
  { rank: "standard", context_tokens: 200000, output_tokens: 32000 },
  { rank: "deep", context_tokens: 200000, output_tokens: 64000 },
];

test("getHostModelRoster parses a valid ordered roster", () => {
  const argv = ["node", "cli", "--host-models", JSON.stringify(VALID_ROSTER)];
  assert.deepEqual(getHostModelRoster(argv), VALID_ROSTER);
});

test("getHostModelRoster returns null when the flag is absent", () => {
  assert.equal(getHostModelRoster(["node", "cli"]), null);
});

test("getHostModelRoster rejects malformed input", () => {
  const cases = [
    "not json",
    "{}",
    "[]",
    JSON.stringify([{ rank: "huge", context_tokens: 1000, output_tokens: 100 }]),
    JSON.stringify([{ rank: "small", context_tokens: -5, output_tokens: 100 }]),
    JSON.stringify([{ rank: "small", context_tokens: 1000 }]),
  ];
  for (const raw of cases) {
    assert.throws(
      () => getHostModelRoster(["node", "cli", "--host-models", raw]),
      undefined,
      `should reject: ${raw}`,
    );
  }
});

// ── tier-budget resolution ───────────────────────────────────────────────────

test("resolveTierBudgets maps reported ranks directly", () => {
  const budgets = resolveTierBudgets(
    new Map([
      ["small", 1000],
      ["standard", 2000],
      ["deep", 3000],
    ]),
  );
  assert.deepEqual(budgets, { small: 1000, standard: 2000, deep: 3000 });
});

test("resolveTierBudgets fills missing ranks from the nearest reported rank", () => {
  // missing small → nearest is standard
  assert.deepEqual(
    resolveTierBudgets(new Map([["standard", 2000], ["deep", 3000]])),
    { small: 2000, standard: 2000, deep: 3000 },
  );
  // missing standard with both neighbors → prefers the more capable (deep)
  assert.deepEqual(
    resolveTierBudgets(new Map([["small", 1000], ["deep", 3000]])),
    { small: 1000, standard: 3000, deep: 3000 },
  );
  // single reported rank serves every tier
  assert.deepEqual(resolveTierBudgets(new Map([["deep", 3000]])), {
    small: 3000,
    standard: 3000,
    deep: 3000,
  });
});

// ── partition-then-validate against per-rank windows ─────────────────────────

// Two affinity-linked tasks (same unit/dir, different lens+file). Frozen
// estimates: 4000 content tokens each; built-packet estimate = 900 overhead +
// 1000 lines × 4 tokens/line per file. Lenses stay non-sensitive so no
// standard-floor escalator interferes with the risk baseline.
function linkedTasks(riskEstimate) {
  return ["maintainability", "correctness"].map((lens, i) => ({
    task_id: `t-${lens}`,
    unit_id: "unit-linked",
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [`src/linked/${i}.ts`],
    file_line_counts: { [`src/linked/${i}.ts`]: 1000 },
    rationale: `review ${lens}`,
    priority: "low",
    token_estimate: 4000,
    risk_estimate: riskEstimate,
  }));
}

async function makeArtifactsDir(tasks) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-roster-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(tasks),
    "utf8",
  );
  return { artifactsDir, runDir };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// small rank window: 7500 − 1500 → 6000-token packet budget. The merged packet
// (~8900 tokens) exceeds it; each single-task sub-packet (~4900) fits.
const SPLIT_ROSTER = [
  { rank: "small", context_tokens: 7500, output_tokens: 1500 },
  { rank: "deep", context_tokens: 200000, output_tokens: 32000 },
];

await test("a low-risk packet routed to a small window re-splits to fit (design a)", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: SPLIT_ROSTER,
  });
  assert.equal(
    result.packet_count,
    2,
    "the merged low-risk packet exceeds the small rank's window and re-splits",
  );
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  for (const entry of plan) {
    assert.equal(entry.model_hint.tier, "small");
  }
  assert.equal(result.warning_count, 0, "re-split packets fit their budgets");
});

await test("the same packet at high risk routes to the deep window and stays whole", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.9));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: SPLIT_ROSTER,
  });
  assert.equal(
    result.packet_count,
    1,
    "deep-routed packets size against the deep rank's window",
  );
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan[0].model_hint.tier, "deep");
});

await test("dispatch-quota carries the roster echo, tier budgets, and per-rank pools", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: SPLIT_ROSTER,
  });
  const quota = await readJson(join(runDir, "dispatch-quota.json"));
  assert.deepEqual(quota.host_model_roster, SPLIT_ROSTER);
  // standard was not reported → falls back to the nearest (deep) budget.
  assert.deepEqual(quota.tier_budgets, {
    small: 6000,
    standard: 168000,
    deep: 168000,
  });
  assert.ok(Array.isArray(quota.capacity_pools));
  assert.ok(quota.capacity_pools.length >= 1);
  // Pools are ordered most-capable first and carry their rank.
  assert.equal(quota.capacity_pools[0].rank, "deep");
  assert.equal(quota.capacity_pools[0].resolved_limits.context_tokens, 200000);
});

await test("scalar handshake without a roster keeps the single-pool path (no tier budgets)", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostContextTokens: 200000,
    hostOutputTokens: 32000,
  });
  assert.equal(result.packet_count, 1, "one window, one merged packet");
  const quota = await readJson(join(runDir, "dispatch-quota.json"));
  assert.equal(quota.host_model_roster, undefined);
  assert.equal(quota.tier_budgets, undefined);
  assert.equal(quota.resolved_limits.context_tokens, 200000);
});
