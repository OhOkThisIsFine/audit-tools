import { join } from "node:path";
import {
  readOptionalTextFile,
  readJsonFile,
  writeJsonFile,
  writeTextFile,
  TOKEN_USAGE_LEDGER_FILENAME,
} from "audit-tools/shared";
import {
  scoreTokens,
  cacheHitRatioRegressed,
  renderTokenScorecardMarkdown,
  packetPromptPrefixHash,
  type TokenUsageEntry,
  type TokenScorecard,
} from "../reporting/scoreTokens.js";
import { getArtifactsDir, getFlag } from "./args.js";

/**
 * Parse a token-usage ledger (JSON Lines, one {@link TokenUsageEntry}-shaped
 * record per line — see `appendTokenUsageLine`). Blank lines are skipped; a
 * malformed line is dropped rather than aborting the whole read (tolerant, same
 * discipline as the provider extractors — a single bad line never blocks
 * scoring the rest of the run).
 */
function parseLedger(text: string): TokenUsageEntry[] {
  const entries: TokenUsageEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as TokenUsageEntry;
      if (parsed && typeof parsed.packet_id === "string") entries.push(parsed);
    } catch {
      // Malformed line — skip it; scoring proceeds over the rest.
    }
  }
  return entries;
}

/**
 * Build the `packet_id -> fixed-prefix hash` map the prefix-stability signal
 * needs, from a completed run's recorded artifacts: `<runDir>/dispatch-plan.json`
 * lists each packet's `prompt_path`, and those packet prompt files persist after
 * the run. We hash the cache-eligible fixed prefix of each (everything before the
 * `## Packet` marker — the boundary `buildPacketPrompt` and its cache-safety test
 * pin). This makes the prefix-stability guard REAL post-hoc: a change that
 * mutates the cache-eligible prefix surfaces as a diverging packet id, the
 * structural (provider-independent) complement to the cache-hit-ratio signal.
 * Fully tolerant: a missing/malformed plan or an unreadable prompt simply yields
 * no hash for that packet (or an empty map), and scoreTokens then reports
 * prefix_stability as "no signal" (stable) rather than a false divergence.
 */
async function buildPrefixHashes(runDir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const planText = await readOptionalTextFile(join(runDir, "dispatch-plan.json"));
  if (planText === undefined) return hashes;
  let plan: Array<{ packet_id?: unknown; prompt_path?: unknown }>;
  try {
    const parsed = JSON.parse(planText);
    plan = Array.isArray(parsed) ? parsed : [];
  } catch {
    return hashes;
  }
  for (const entry of plan) {
    if (typeof entry?.packet_id !== "string" || typeof entry?.prompt_path !== "string") continue;
    const prompt = await readOptionalTextFile(entry.prompt_path);
    if (prompt === undefined) continue;
    hashes[entry.packet_id] = packetPromptPrefixHash(prompt);
  }
  return hashes;
}

/**
 * `score-tokens` — emit the deterministic token/cache-hit scorecard for a run's
 * recorded token-usage ledger (the cost counterpart to `score-audit`, A-2).
 *
 * Resolution:
 *   --run-id <id>          the run whose ledger to score (used to locate the
 *                          default ledger path AND stamp the scorecard's run_id)
 *   --usage-ledger <path>  token-usage.jsonl (default: <artifacts>/runs/<run-id>/token-usage.jsonl)
 *   --run-dir <path>       explicit run dir override (default: <artifacts>/runs/<run-id>)
 *   --baseline <path>      a prior score-tokens.json to gate against (optional)
 *   --out <path>           where to write score-tokens.json (default: <artifacts>/score-tokens.json)
 *
 * The exit code is wired SOLELY to a cache-hit-ratio REGRESSION vs --baseline
 * (track-don't-gate: token totals are printed but never gate). With no baseline
 * the run only emits the scorecard and always exits 0.
 */
export async function cmdScoreTokens(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const runId = getFlag(argv, "--run-id") ?? "unknown";
  const runDir = getFlag(argv, "--run-dir") ?? join(artifactsDir, "runs", runId);
  const ledgerPath = getFlag(argv, "--usage-ledger") ?? join(runDir, TOKEN_USAGE_LEDGER_FILENAME);
  const baselinePath = getFlag(argv, "--baseline");
  const outPath = getFlag(argv, "--out") ?? join(artifactsDir, "score-tokens.json");

  const ledgerText = await readOptionalTextFile(ledgerPath);
  if (ledgerText === undefined) {
    console.error(
      `score-tokens: no ledger found at ${ledgerPath} — pass --run-id or --usage-ledger.`,
    );
    process.exitCode = 1;
    return;
  }
  const entries = parseLedger(ledgerText);

  let baseline: TokenScorecard | null = null;
  if (baselinePath) {
    try {
      baseline = await readJsonFile<TokenScorecard>(baselinePath);
    } catch (error) {
      console.error(
        `Could not read baseline scorecard at ${baselinePath}: ${(error as Error).message}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const prefixHashes = await buildPrefixHashes(runDir);
  const scorecard = scoreTokens(runId, entries, prefixHashes);
  await writeJsonFile(outPath, scorecard);
  const summary = renderTokenScorecardMarkdown(scorecard);
  const summaryPath = outPath.replace(/\.json$/, ".md");
  await writeTextFile(summaryPath, summary);

  process.stdout.write(summary);
  console.error(`Token scorecard written to ${outPath} (summary: ${summaryPath})`);

  // The ONLY gate: a cache-hit-ratio regression against the baseline.
  if (cacheHitRatioRegressed(scorecard, baseline)) {
    console.error(
      `✗ cache-hit-ratio regression: ${fmt(scorecard.cache_hit_ratio_overall)} < ` +
        `baseline ${fmt(baseline?.cache_hit_ratio_overall ?? 0)}`,
    );
    process.exitCode = 1;
    return;
  }
  if (baseline) {
    console.error(
      `✓ cache-hit ratio ${fmt(scorecard.cache_hit_ratio_overall)} within baseline ` +
        `${fmt(baseline.cache_hit_ratio_overall ?? 0)}`,
    );
  }
}

function fmt(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}
