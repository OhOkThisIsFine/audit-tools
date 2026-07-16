import { test, onTestFinished, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareDispatchArtifacts, resolveTierBudgets } = await import("../../src/audit/cli/dispatch.ts");
const { getAuditorDescriptor } = await import("../../src/audit/cli/args.ts");
const { packageRoot } = await import("../../src/audit/cli/paths.ts");

const RUN_ID = "roster-run";

// ── --auditor flag parsing ───────────────────────────────────────────────

const VALID_ROSTER = [
  { rank: "small", context_tokens: 32000, output_tokens: 8000 },
  { rank: "standard", context_tokens: 200000, output_tokens: 32000 },
  { rank: "deep", context_tokens: 200000, output_tokens: 64000 },
];

test("getAuditorDescriptor parses a valid ordered roster from --auditor", () => {
  const auditorJson = JSON.stringify({ self: { roster: VALID_ROSTER } });
  const argv = ["node", "cli", "--auditor", auditorJson];
  const descriptor = getAuditorDescriptor(argv);
  expect(descriptor).not.toBe(null);
  expect(descriptor.self.roster).toEqual(VALID_ROSTER);
});

test("getAuditorDescriptor returns null when the --auditor flag is absent", () => {
  expect(getAuditorDescriptor(["node", "cli", "next-step"])).toBe(null);
});

test("getAuditorDescriptor rejects malformed JSON in --auditor", () => {
  assert.throws(
    () => getAuditorDescriptor(["node", "cli", "--auditor", "{not json"]),
    (err) => err instanceof Error && /JSON object/i.test(err.message),
    "should reject malformed JSON",
  );
});

// The roster inside `--auditor` is re-validated through the SAME shared
// parseHostModelRoster the retired `--host-models` flag used, so a semantically
// malformed roster (valid JSON, bad entries) still fails LOUDLY at the CLI
// boundary — never silently downgrading to the conservative floor deep in dispatch
// budget resolution. (Regression guard: G1's transport collapse must not weaken
// this validation.)
test("getAuditorDescriptor throws on a semantically malformed roster (schema-validated, not just JSON)", () => {
  const bad = (roster) => () =>
    getAuditorDescriptor(["node", "cli", "--auditor", JSON.stringify({ self: { roster } })]);
  // unknown rank
  assert.throws(bad([{ rank: "huge", context_tokens: 200000, output_tokens: 32000 }]), /rank must be one of/i);
  // non-positive context window
  assert.throws(bad([{ rank: "standard", context_tokens: -1, output_tokens: 32000 }]), /context_tokens must be a positive integer/i);
  // non-numeric output cap
  assert.throws(bad([{ rank: "standard", context_tokens: 200000, output_tokens: "lots" }]), /output_tokens must be a positive integer/i);
  // empty roster array
  assert.throws(bad([]), /non-empty/i);
  // a non-array roster (string) is not a valid roster
  assert.throws(bad("{not json"), /JSON array/i);
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
  expect(budgets).toEqual({ small: 1000, standard: 2000, deep: 3000 });
});

test("resolveTierBudgets fills missing ranks from the nearest reported rank", () => {
  // missing small → nearest is standard
  expect(resolveTierBudgets(new Map([["standard", 2000], ["deep", 3000]]))).toEqual({ small: 2000, standard: 2000, deep: 3000 });
  // missing standard, equidistant from both neighbors → prefers the LOWER
  // (less capable) rank so a tier is never over-budgeted (COR-0e031ac0).
  expect(resolveTierBudgets(new Map([["small", 1000], ["deep", 3000]]))).toEqual({ small: 1000, standard: 1000, deep: 3000 });
  // single reported rank serves every tier
  expect(resolveTierBudgets(new Map([["deep", 3000]]))).toEqual({
    small: 3000,
    standard: 3000,
    deep: 3000,
  });
});

// TST-df8bc2ec: empty roster map — must throw rather than silently dispatch with wrong budgets
test("resolveTierBudgets throws when given an empty roster Map", () => {
  assert.throws(
    () => resolveTierBudgets(new Map()),
    (err) => err instanceof Error && /at least one reported rank/i.test(err.message),
    "empty Map must throw with a descriptive error",
  );
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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: SPLIT_ROSTER,
  });
  expect(result.packet_count, "the merged low-risk packet exceeds the small rank's window and re-splits").toBe(2);
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  for (const entry of plan) {
    expect(entry.model_hint.tier).toBe("small");
  }
  expect(result.warning_count, "re-split packets fit their budgets").toBe(0);
});

await test("the same packet at high risk routes to the deep window and stays whole", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.9));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: SPLIT_ROSTER,
  });
  expect(result.packet_count, "deep-routed packets size against the deep rank's window").toBe(1);
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  expect(plan[0].model_hint.tier).toBe("deep");
});

await test("dispatch-quota carries the roster echo, tier budgets, and per-rank pools", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
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
  expect(quota.host_model_roster).toEqual(SPLIT_ROSTER);
  // standard was not reported and is equidistant from small and deep → falls
  // back to the LOWER (small) budget so it is never over-budgeted (COR-0e031ac0).
  expect(quota.tier_budgets).toEqual({
    small: 6000,
    standard: 6000,
    deep: 168000,
  });
  expect(Array.isArray(quota.capacity_pools)).toBeTruthy();
  expect(quota.capacity_pools.length >= 1).toBeTruthy();
  // Pools are ordered most-capable first and carry their rank.
  expect(quota.capacity_pools[0].rank).toBe("deep");
  expect(quota.capacity_pools[0].resolved_limits.context_tokens).toBe(200000);
});

// ── opaque model identity → quota key (F3) ───────────────────────────────────

await test("--host-model-id keys the quota pool as provider/<id>; absent → provider/*", async (t) => {
  for (const [hostModelId, suffix] of [
    ["opaque-x", "/opaque-x"],
    [null, "/*"],
  ]) {
    const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
    onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
    await prepareDispatchArtifacts({
      packageRoot,
      runId: RUN_ID,
      artifactsDir,
      root: artifactsDir,
      sessionConfig: {},
      hostModel: null,
      hostModelId,
    });
    const quota = await readJson(join(runDir, "dispatch-quota.json"));
    expect(quota.capacity_pools[0].pool_id.endsWith(suffix), `pool_id ${quota.capacity_pools[0].pool_id} should end with ${suffix}`).toBeTruthy();
  }
});

await test("per-rank model_id keys each roster pool's quota independently", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.9));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostModelRoster: [
      { rank: "small", context_tokens: 7500, output_tokens: 1500, model_id: "rank-s" },
      { rank: "deep", context_tokens: 200000, output_tokens: 32000, model_id: "rank-d" },
    ],
  });
  const quota = await readJson(join(runDir, "dispatch-quota.json"));
  const poolIds = quota.capacity_pools.map((pool) => pool.pool_id);
  expect(poolIds[0].endsWith("/rank-d"), `deep pool keys its own id: ${poolIds[0]}`).toBeTruthy();
  // The roster echo retains each rank's opaque id for downstream consumers.
  expect(quota.host_model_roster.map((entry) => entry.model_id)).toEqual(["rank-s", "rank-d"]);
});

await test("scalar handshake without a roster keeps the single-pool path (no tier budgets)", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(linkedTasks(0.1));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
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
  expect(result.packet_count, "one window, one merged packet").toBe(1);
  const quota = await readJson(join(runDir, "dispatch-quota.json"));
  expect(quota.host_model_roster).toBe(undefined);
  expect(quota.tier_budgets).toBe(undefined);
  expect(quota.resolved_limits.context_tokens).toBe(200000);
});
