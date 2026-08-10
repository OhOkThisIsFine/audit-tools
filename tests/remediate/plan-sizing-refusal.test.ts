import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import type { Finding } from "../../src/remediate/state/types.js";
import { scratchDir } from "../helpers/scratch.js";

// ── The invariant ────────────────────────────────────────────────────────────
//
// `handlePendingExtractedPlan` recovers from a bad extracted plan by DELETING
// `extracted-plan.json` and asking the host to re-extract. That recovery is
// correct for exactly one class of failure: the plan itself is unusable
// (unparseable, or every finding grounded away). It wrapped the whole join —
// sizing, dirty-snapshot, coverage-ledger build, state persistence — so any
// failure in any of them destroyed the extracted plan and reported it as
// corruption.
//
// `resolvePlanContextBudget` is the sharp case. Its refusal is documented as a
// RESUMABLE pause ("report the limits, or configure block_quota"), but it threw
// into that catch: the plan was deleted, the operator was told the file was
// corrupt, and — because re-extraction cannot change the host's declared window —
// the next step reproduced it exactly. A deterministic loop that eats work on
// every lap.
//
// These tests pin the two halves apart: a sizing refusal must SURVIVE with its
// own message, and the genuine unusable-plan recovery must still delete.

const TEST_DIR = scratchDir(".test-plan-sizing-refusal");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");
const EXTRACTED_PLAN = join(ARTIFACTS_DIR, "extracted-plan.json");

function mkFinding(id: string, files: string[]): Finding {
  return {
    id,
    title: `Finding ${id}`,
    category: "General",
    severity: "medium",
    confidence: "high",
    lens: "correctness",
    summary: `Summary for ${id}.`,
    affected_files: files.map((path) => ({ path })),
    evidence: files.map((path) => `${path}:1 — cited`),
  } as Finding;
}

async function rmWithRetry(path: string, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" || i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

/**
 * The declared window, as `session-config.json` spells it. Passing a HALF pair
 * (context with no output reservation) is what drives `resolvePlanContextBudget`
 * to its refusal: `resolveContextBudget` requires both sides and returns null
 * otherwise. Every sibling suite declares the complete pair here — which is why
 * the refusal has had no coverage at all.
 */
async function writeSessionConfig(blockQuota: Record<string, number>): Promise<void> {
  await writeFile(
    join(TEST_DIR, "session-config.json"),
    JSON.stringify({ block_quota: blockQuota }),
    "utf8",
  );
}

async function writeIntentCheckpoint(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    }),
    "utf8",
  );
}

async function writeExtractedPlan(findings: Finding[]): Promise<void> {
  await writeFile(
    EXTRACTED_PLAN,
    JSON.stringify({
      plan_id: "PLAN-SIZING",
      findings,
      blocks: [
        {
          block_id: "B-001",
          items: findings.map((f) => f.id),
          parallel_safe: true,
        },
      ],
    }),
    "utf8",
  );
}

beforeEach(async () => {
  await rmWithRetry(TEST_DIR);
  await mkdir(join(TEST_DIR, "src"), { recursive: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(TEST_DIR, "src", "real.ts"), "line1\nline2\nline3\n", "utf8");
  await writeIntentCheckpoint();
});

afterEach(async () => {
  await rmWithRetry(TEST_DIR);
});

describe("extracted-plan join — a sizing refusal is not plan corruption", () => {
  it("keeps extracted-plan.json when no sizing window is declared", async () => {
    // Identical to the passing case below except for the missing output
    // reservation, so the refusal is the only variable.
    await writeSessionConfig({ context_tokens: 200_000 });
    await writeExtractedPlan([mkFinding("F-OK", ["src/real.ts"])]);

    await expect(
      decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true }),
    ).rejects.toThrow(/context and output token limits are unknown/);

    expect(
      existsSync(EXTRACTED_PLAN),
      "a resumable sizing refusal must not destroy the extracted plan — re-extraction cannot change the declared window, so deleting it loses work on every lap of a deterministic loop",
    ).toBe(true);
  });

  it("still deletes extracted-plan.json when the plan itself is unusable", async () => {
    // The recovery this catch exists for: every cited path is phantom, so no
    // finding survives grounding and re-extraction genuinely is the remedy.
    await writeSessionConfig({ context_tokens: 200_000, reserved_output_tokens: 8_000 });
    await writeExtractedPlan([mkFinding("F-PHANTOM", ["void/x.ts"])]);

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    expect(
      existsSync(EXTRACTED_PLAN),
      "an ungroundable plan is the case the discard-and-re-extract recovery is for",
    ).toBe(false);
  });

  it("still deletes extracted-plan.json when the plan does not normalize", async () => {
    await writeSessionConfig({ context_tokens: 200_000, reserved_output_tokens: 8_000 });
    await writeFile(EXTRACTED_PLAN, JSON.stringify(["not", "an", "object"]), "utf8");

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    expect(existsSync(EXTRACTED_PLAN)).toBe(false);
  });

  it("sizes normally once a window is declared, proving the refusal is the only difference", async () => {
    await writeSessionConfig({ context_tokens: 200_000, reserved_output_tokens: 8_000 });
    await writeExtractedPlan([mkFinding("F-OK", ["src/real.ts"])]);

    await decideNextStep({ root: TEST_DIR, hostCanDispatchSubagents: true });

    const state = JSON.parse(await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"));
    expect(state.plan.findings.map((f: Finding) => f.id)).toEqual(["F-OK"]);
    expect(existsSync(EXTRACTED_PLAN)).toBe(true);
  });
});
