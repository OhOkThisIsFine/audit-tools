import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { finalizeProviderLaunchResult } = await import(
  "../../src/shared/dispatch/providerLaunchFinalize.ts"
);

/**
 * Slice A2 (backlog HIGH, 2026-07-11 live run) — the ACTUAL crash-avoidance
 * point: before this fix, a worker whose stderr carried a credit-exhaustion
 * message fell through `detectRateLimitFromChannel` (isRateLimited: false,
 * unrecognized) to "worker wrote no result at ..." → a raw, unclassified
 * `error` outcome the caller had no signal for — "the worker AND the
 * dispatcher both die with a raw API error" per the backlog. Now it must
 * classify as a distinct, non-crashing `credit_exhausted` outcome.
 */

function basePacket() {
  return { id: "p1", payload: {}, estimatedTokens: 100, complexity: 0.5 };
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "launch-finalize-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("finalizeProviderLaunchResult: credit-exhaustion stderr classifies as credit_exhausted, never falls through to a raw error", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json"); // never written — worker died before writing
    await writeFile(
      stderrPath,
      "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.",
      "utf8",
    );
    await writeFile(stdoutPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "openai-compatible",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim-deep",
      },
    );

    expect(result.outcome).toBe("credit_exhausted");
    expect(result.creditExhaustion?.channel).toBe("error");
    expect(result.creditExhaustion?.rawMatch).toContain("credit balance is too low");
  });
});

test("finalizeProviderLaunchResult: credit exhaustion is checked BEFORE rate-limit — never misclassified as a resettable rate_limited", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // The OpenAI-compatible structured error code (a strong, unambiguous
    // credit-exhaustion signal) — must win over any generic "quota" text
    // sniffing that could otherwise pull this toward rate_limited.
    await writeFile(
      stderrPath,
      JSON.stringify({
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
        },
      }),
      "utf8",
    );
    await writeFile(stdoutPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "openai-compatible",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim-deep",
      },
    );

    expect(result.outcome).toBe("credit_exhausted");
    expect(result.outcome).not.toBe("rate_limited");
  });
});

test("finalizeProviderLaunchResult: an ordinary 429 on stderr still classifies as rate_limited (unaffected by the new check)", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    await writeFile(stderrPath, "429 Too Many Requests", "utf8");
    await writeFile(stdoutPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "openai-compatible",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim-deep",
      },
    );

    expect(result.outcome).toBe("rate_limited");
  });
});

test("finalizeProviderLaunchResult: credit-exhaustion reported on stdout (some providers write status there) also classifies, not just stderr", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    await writeFile(stderrPath, "", "utf8");
    await writeFile(stdoutPath, "insufficient credits to complete this request", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "openai-compatible",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim-deep",
      },
    );

    expect(result.outcome).toBe("credit_exhausted");
    expect(result.creditExhaustion?.channel).toBe("status");
  });
});

test("finalizeProviderLaunchResult: a healthy result file quoting a credit-exhaustion string is NEVER reclassified (CE-003 channel isolation)", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    await writeFile(stderrPath, "", "utf8");
    await writeFile(stdoutPath, "", "utf8");
    // The RESULT content legitimately quotes the string (e.g. an AuditResult
    // finding describing this exact bug) — must never be scanned/consumed.
    await writeFile(
      resultPath,
      JSON.stringify([{ finding: "Your credit balance is too low to access the Claude API." }]),
      "utf8",
    );

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "openai-compatible",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim-deep",
      },
    );

    expect(result.outcome).toBe("success");
  });
});
