import { test, expect } from "vitest";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { scoreTokens, cacheHitRatioRegressed, renderTokenScorecardMarkdown, packetPromptPrefixHash } =
  await import("../../src/audit/reporting/scoreTokens.ts");
const { cmdScoreTokens } = await import("../../src/audit/cli/scoreTokensCommand.ts");
const { buildPacketPrompt } = await import("../../src/audit/cli/dispatch.ts");

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "tokens");

async function readLedgerEntries() {
  const text = await readFile(join(fixturesDir, "sample-run.token-usage.jsonl"), "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// ── pure scoreTokens ────────────────────────────────────────────────────────

test("scoreTokens is a pure function: twice-run byte-identical (determinism), order-independent", async () => {
  const entries = await readLedgerEntries();
  const a = JSON.stringify(scoreTokens("sample-run", entries));
  const b = JSON.stringify(scoreTokens("sample-run", entries));
  expect(a, "two runs over the same input must be byte-identical").toBe(b);

  const shuffled = [...entries].reverse();
  const c = JSON.stringify(scoreTokens("sample-run", shuffled));
  expect(a, "reordering entries must not change the scorecard").toBe(c);

  expect(renderTokenScorecardMarkdown(scoreTokens("sample-run", entries))).toBe(
    renderTokenScorecardMarkdown(scoreTokens("sample-run", entries)),
  );
});

test("no-silent-scoring: an all-null usage entry lands in unmeasured_steps, never as 0 in totals", async () => {
  const entries = await readLedgerEntries();
  const card = scoreTokens("sample-run", entries);

  // packet-3 (claude-code, no structured usage) is the ONLY all-null entry.
  expect(card.totals.measured_steps).toBe(3);
  expect(card.totals.unmeasured_steps).toBe(1);

  // Totals sum ONLY the measured legs (1000+800+500, 200+150+90) — packet-3
  // contributes nothing, not a silent 0 that would still be arithmetically
  // invisible here, but IS counted correctly in unmeasured_steps above.
  expect(card.totals.input_tokens).toBe(2300);
  expect(card.totals.output_tokens).toBe(440);

  const step3 = card.steps.find((s) => s.packet_id === "packet-3");
  expect(step3.input_tokens).toBeNull();
  expect(step3.output_tokens).toBeNull();
  expect(step3.cache_read_tokens).toBeNull();
  expect(step3.cache_hit_ratio).toBeNull();
});

test("cache_hit_ratio per step requires BOTH legs measured; overall aggregates measured steps only", async () => {
  const entries = await readLedgerEntries();
  const card = scoreTokens("sample-run", entries);

  const byId = Object.fromEntries(card.steps.map((s) => [s.packet_id, s]));
  expect(byId["packet-1"].cache_hit_ratio).toBeCloseTo(400 / 1400, 10);
  expect(byId["packet-4"].cache_hit_ratio).toBeCloseTo(100 / 600, 10);
  // packet-2 reported input/output but no cache fields — no ratio, not 0.
  expect(byId["packet-2"].cache_hit_ratio).toBeNull();
  expect(byId["packet-3"].cache_hit_ratio).toBeNull();

  // Overall = (400+100) / ((400+1000)+(100+500)) = 500/2000.
  expect(card.cache_hit_ratio_overall).toBeCloseTo(0.25, 10);
});

test("cache_hit_ratio_overall is null when no step qualifies", () => {
  const card = scoreTokens("run-x", [
    { packet_id: "p1", pool_id: "pool-a", input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null },
    { packet_id: "p2", pool_id: "pool-a", input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null },
  ]);
  expect(card.cache_hit_ratio_overall).toBeNull();
});

test("provider_coverage: measured pool stays measured even if some of its steps are unmeasured; a fully-unreported pool is unmeasured", async () => {
  const entries = await readLedgerEntries();
  const card = scoreTokens("sample-run", entries);

  expect(card.provider_coverage["openai-compatible#nim/llama-3.1-70b"]).toBe("measured");
  expect(card.provider_coverage["claude-code#default/opus"]).toBe("unmeasured");
});

// ── cacheHitRatioRegressed gate (mirrors hallucinationRegressed) ──────────────

test("cacheHitRatioRegressed: the sole gate is a cache-hit-ratio DECREASE vs baseline", async () => {
  const entries = await readLedgerEntries();
  const baseline = scoreTokens("sample-run", entries); // cache_hit_ratio_overall = 0.25

  // No baseline → nothing can regress.
  expect(cacheHitRatioRegressed(baseline, null)).toBe(false);
  expect(cacheHitRatioRegressed(baseline, undefined)).toBe(false);

  // Equal ratio → not a regression (byte-identical re-run never trips).
  expect(cacheHitRatioRegressed(baseline, baseline)).toBe(false);

  // Lower current ratio → regression (cache-hit dropped).
  const worse = { ...baseline, cache_hit_ratio_overall: 0.1 };
  expect(cacheHitRatioRegressed(worse, baseline)).toBe(true);

  // Higher current ratio → improvement, not a regression.
  const better = { ...baseline, cache_hit_ratio_overall: 0.9 };
  expect(cacheHitRatioRegressed(better, baseline)).toBe(false);

  // A null current ratio (no cache-eligible measured steps) cannot regress.
  const nullCurrent = { ...baseline, cache_hit_ratio_overall: null };
  expect(cacheHitRatioRegressed(nullCurrent, baseline)).toBe(false);

  // A null baseline ratio is treated as 0 (the floor); a ratio can never drop
  // below 0, so a null baseline never trips a regression.
  const nullBaseline = { ...baseline, cache_hit_ratio_overall: null };
  expect(cacheHitRatioRegressed(worse, nullBaseline)).toBe(false);

  // Token totals never gate: a scorecard whose totals balloon but whose
  // cache_hit_ratio_overall is unchanged never trips.
  const totalsBallooned = {
    ...baseline,
    totals: { ...baseline.totals, input_tokens: baseline.totals.input_tokens * 100 },
    cache_hit_ratio_overall: baseline.cache_hit_ratio_overall,
  };
  expect(cacheHitRatioRegressed(totalsBallooned, baseline)).toBe(false);
});

// ── prefix stability (structural, provider-independent) ───────────────────────

function makePacket(id) {
  return {
    packet_id: id,
    task_ids: [`task-${id}`],
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: 100 },
    total_lines: 100,
    estimated_tokens: 500,
    lenses: ["correctness"],
    priority: "medium",
    entrypoints: [],
    key_edges: [],
    boundary_files: [],
  };
}

function makeAuditTask(id) {
  return {
    task_id: `task-${id}`,
    unit_id: `unit-${id}`,
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: 50 },
    rationale: "check the logic",
    priority: "medium",
    tags: [],
  };
}

function renderPromptFor(id) {
  return buildPacketPrompt({
    packet: makePacket(id),
    packetTasks: [makeAuditTask(id)],
    fileList: `- src/${id}.ts (100 lines)`,
    largeFileSection: [],
    taskSections: [`### task-${id}`],
    resultPath: `/artifacts/runs/run-1/task-results/${id}-inline-result.json`,
  });
}

test("packetPromptPrefixHash: identical fixed prefixes across packets hash identically", () => {
  const promptA = renderPromptFor("abc");
  const promptB = renderPromptFor("xyz");
  // Sanity: the two full prompts differ (volatile per-packet content).
  expect(promptA).not.toBe(promptB);

  const hashA = packetPromptPrefixHash(promptA);
  const hashB = packetPromptPrefixHash(promptB);
  expect(hashA).toBe(hashB);

  const card = scoreTokens("run-1", [
    { packet_id: "abc", pool_id: "pool-a" },
    { packet_id: "xyz", pool_id: "pool-a" },
  ], { abc: hashA, xyz: hashB });
  expect(card.prefix_stability).toEqual({ stable: true, diverging_packet_ids: [] });
});

test("packetPromptPrefixHash: a prefix-touching diff is caught as a diverging packet id", () => {
  const promptA = renderPromptFor("abc");
  const promptB = renderPromptFor("xyz");
  const hashA = packetPromptPrefixHash(promptA);
  const hashB = packetPromptPrefixHash(promptB);

  // Simulate a regression that mutates the FIXED prefix for one packet only
  // (e.g. a schema-block edit that landed for one code path but not another).
  const mutatedPrefix = promptB.slice(0, promptB.indexOf("## Packet")).replace("## Output", "## OUTPUT-MUTATED") +
    promptB.slice(promptB.indexOf("## Packet"));
  const hashBMutated = packetPromptPrefixHash(mutatedPrefix);
  expect(hashBMutated).not.toBe(hashA);

  const card = scoreTokens("run-1", [
    { packet_id: "abc", pool_id: "pool-a" },
    { packet_id: "xyz", pool_id: "pool-a" },
  ], { abc: hashA, xyz: hashBMutated });
  expect(card.prefix_stability.stable).toBe(false);
  expect(card.prefix_stability.diverging_packet_ids).toEqual(["xyz"]);
});

test("prefix_stability defaults to stable when no prefix hashes are supplied", () => {
  const card = scoreTokens("run-1", [{ packet_id: "abc", pool_id: "pool-a" }]);
  expect(card.prefix_stability).toEqual({ stable: true, diverging_packet_ids: [] });
});

// ── CLI smoke: cmdScoreTokens ───────────────────────────────────────────────

test("cmdScoreTokens: reads the fixture ledger + run dir, writes .json/.md, and echoes a summary", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "score-tokens-cli-"));
  try {
    const artifactsDir = join(tempDir, ".audit-tools", "audit");
    const runId = "sample-run";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    const ledgerText = await readFile(join(fixturesDir, "sample-run.token-usage.jsonl"), "utf8");
    await writeFile(join(runDir, "token-usage.jsonl"), ledgerText, "utf8");

    const previousWrite = process.stdout.write.bind(process.stdout);
    let stdout = "";
    process.stdout.write = (chunk, ...rest) => {
      stdout += chunk.toString();
      return true;
    };
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await cmdScoreTokens(["--artifacts-dir", artifactsDir, "--run-id", runId]);
    } finally {
      process.stdout.write = previousWrite;
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = previousExitCode;

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Token scorecard — sample-run/);
    expect(stdout).toMatch(/Cache-hit ratio \(gated\): 25\.0%/);

    const jsonOut = JSON.parse(await readFile(join(artifactsDir, "score-tokens.json"), "utf8"));
    expect(jsonOut.run_id).toBe("sample-run");
    expect(jsonOut.totals.measured_steps).toBe(3);
    expect(jsonOut.totals.unmeasured_steps).toBe(1);

    const mdOut = await readFile(join(artifactsDir, "score-tokens.md"), "utf8");
    expect(mdOut).toMatch(/Token scorecard — sample-run/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cmdScoreTokens: derives real prefix_stability from the recorded dispatch-plan + packet prompts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "score-tokens-prefix-"));
  try {
    const artifactsDir = join(tempDir, ".audit-tools", "audit");
    const runId = "prefix-run";
    const runDir = join(artifactsDir, "runs", runId);
    await mkdir(runDir, { recursive: true });

    // Minimal ledger so the command has something to score (usage null = unmeasured);
    // prefix_stability is driven by the plan + prompts, independent of usage.
    const ledger = ["p1", "p2"]
      .map((id) =>
        JSON.stringify({
          packet_id: id,
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          observed_cost_usd: null,
        }),
      )
      .join("\n");
    await writeFile(join(runDir, "token-usage.jsonl"), `${ledger}\n`, "utf8");

    const p1Path = join(runDir, "p1.md");
    const p2Path = join(runDir, "p2.md");
    // Identical fixed prefix (everything before "## Packet") ⇒ cache-eligible ⇒ stable.
    const prefix = "## Output\nshared schema prefix\n";
    await writeFile(p1Path, `${prefix}## Packet p1\nbody one`, "utf8");
    await writeFile(p2Path, `${prefix}## Packet p2\nbody two`, "utf8");
    await writeFile(
      join(runDir, "dispatch-plan.json"),
      JSON.stringify([
        { packet_id: "p1", prompt_path: p1Path },
        { packet_id: "p2", prompt_path: p2Path },
      ]),
      "utf8",
    );

    const runOnce = async () => {
      const prevWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      const prevExit = process.exitCode;
      process.exitCode = 0;
      try {
        await cmdScoreTokens(["--artifacts-dir", artifactsDir, "--run-id", runId]);
      } finally {
        process.stdout.write = prevWrite;
      }
      process.exitCode = prevExit;
      return JSON.parse(await readFile(join(artifactsDir, "score-tokens.json"), "utf8"));
    };

    const stableCard = await runOnce();
    expect(stableCard.prefix_stability).toEqual({ stable: true, diverging_packet_ids: [] });

    // Mutate ONLY p2's fixed prefix — a prefix-cache-busting regression. p1 is the
    // sorted-first reference, so p2 must be surfaced as the diverging packet.
    await writeFile(p2Path, `## Output\nDIFFERENT prefix\n## Packet p2\nbody two`, "utf8");
    const divergedCard = await runOnce();
    expect(divergedCard.prefix_stability.stable).toBe(false);
    expect(divergedCard.prefix_stability.diverging_packet_ids).toEqual(["p2"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cmdScoreTokens: missing ledger fails cleanly with a non-zero exit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "score-tokens-cli-missing-"));
  try {
    const artifactsDir = join(tempDir, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    const previousError = console.error;
    let stderr = "";
    console.error = (...values) => {
      stderr += `${values.join(" ")}\n`;
    };
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await cmdScoreTokens(["--artifacts-dir", artifactsDir, "--run-id", "nonexistent-run"]);
    } finally {
      console.error = previousError;
    }
    const exitCode = process.exitCode ?? 0;
    process.exitCode = previousExitCode;

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no ledger found/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
