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

// Slice A2b (TIER 2, backlog HIGH) — the broad quota-suspicious pre-filter: a
// worker death whose text matches NEITHER precise pattern above (credit /
// rate-limit) but still smells quota-shaped must classify as the conservative
// `quota_unclassified` outcome, never fall through to a silent, unclassified
// `error`.

test("finalizeProviderLaunchResult: a quota-suspicious-but-unmatched stderr message classifies as quota_unclassified, not a raw error", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json"); // never written — worker died
    // Deliberately vendor prose that matches NEITHER CREDIT_EXHAUSTION_PATTERNS
    // nor ALL_RATE_LIMIT_PATTERNS precisely, but is still quota-shaped ("billing").
    await writeFile(
      stderrPath,
      "Upstream billing service rejected this request; account is over its configured cap.",
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

    expect(result.outcome).toBe("quota_unclassified");
    expect(result.outcome).not.toBe("error");
    expect(result.quotaUnclassified?.channel).toBe("error");
    expect(result.quotaUnclassified?.text).toContain("billing service rejected");
  });
});

test("finalizeProviderLaunchResult: quota_unclassified is checked AFTER credit/rate-limit — a precise match still wins", async () => {
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

    // "429 Too Many Requests" is ALSO quota-suspicious, but the precise
    // rate_limited classifier runs first and wins.
    expect(result.outcome).toBe("rate_limited");
  });
});

test("finalizeProviderLaunchResult: a clearly non-quota death still classifies as a raw error (TIER 2 does not over-fire)", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    await writeFile(stderrPath, "TypeError: cannot read property 'foo' of undefined", "utf8");
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

    expect(result.outcome).toBe("error");
    expect(result.quotaUnclassified).toBeUndefined();
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

// Unit A (2026-07-17): the not-accepted branch NOW classifies failure text,
// fixing the dogfood gap where nonzero-exit-code workers were never scanned.

test("finalizeProviderLaunchResult: not-accepted (exit ≠ 0) worker with 429 text now classifies as rate_limited, not silent error", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // Verbatim from the dogfood corpus (2026-07-16)
    await writeFile(
      stdoutPath,
      'API Error: Request rejected (429) · openai backend HTTP 429: {"status":429,"title":"Too Many Requests"}',
      "utf8",
    );
    await writeFile(stderrPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: false }, // exitCode=1: not-accepted
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
        poolId: "nim-pool",
      },
    );

    // Before fix: outcome: "error"
    // After fix: outcome: "rate_limited"
    expect(result.outcome).toBe("rate_limited");
    expect(result.rateLimit?.channel).toBe("status");
  });
});

test("finalizeProviderLaunchResult: not-accepted worker with model-unavailable (404) text classifies as model_unavailable", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // Verbatim from the dogfood corpus: "kimi-k2.6 may not exist"
    await writeFile(
      stdoutPath,
      "There's an issue with the selected model (nim/moonshotai/kimi-k2.6). It may not exist or you may not have access to it.",
      "utf8",
    );
    await writeFile(stderrPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: false }, // exit ≠ 0
      {
        packet: basePacket(),
        providerName: "kimi-provider",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "kimi-pool",
      },
    );

    expect(result.outcome).toBe("model_unavailable");
    expect(result.modelUnavailable?.channel).toBe("status");
    expect(result.modelUnavailable?.rawMatch).toBe("may not exist");
  });
});

test("finalizeProviderLaunchResult: not-accepted worker with request-too-large (413) text classifies as packet_too_large", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // Verbatim from the dogfood corpus: groq's 413 render
    await writeFile(
      stdoutPath,
      "Request too large (max 32MB). Try with a smaller file.",
      "utf8",
    );
    await writeFile(stderrPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: false },
      {
        packet: basePacket(),
        providerName: "groq",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "groq-pool",
      },
    );

    expect(result.outcome).toBe("packet_too_large");
    expect(result.packetTooLarge?.channel).toBe("status");
    expect(result.packetTooLarge?.rawMatch).toMatch(/request too large/i);
  });
});

test("finalizeProviderLaunchResult: order is load-bearing — request-too-large checked BEFORE rate-limit so 413+retry text cannot poison cooldown", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // F4 test: combined "413 ... retry" text
    await writeFile(
      stderrPath,
      "413 Payload too large. Retry after reducing size.",
      "utf8",
    );
    await writeFile(stdoutPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: false },
      {
        packet: basePacket(),
        providerName: "test-provider",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "test-pool",
      },
    );

    // MUST be packet_too_large, NOT rate_limited (the "retry" text must not win)
    expect(result.outcome).toBe("packet_too_large");
    expect(result.outcome).not.toBe("rate_limited");
  });
});

test("finalizeProviderLaunchResult: model-unavailable checked BEFORE rate-limit so a combined 404+retry text classifies correctly", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // Combined text: 404 + retry language
    await writeFile(
      stderrPath,
      "404: Model does not exist or you do not have access. Please retry after verifying the model name.",
      "utf8",
    );
    await writeFile(stdoutPath, "", "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: false },
      {
        packet: basePacket(),
        providerName: "test-provider",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "test-pool",
      },
    );

    // MUST be model_unavailable, NOT rate_limited
    expect(result.outcome).toBe("model_unavailable");
    expect(result.outcome).not.toBe("rate_limited");
  });
});

test("finalizeProviderLaunchResult: both not-accepted and accepted-but-no-result branches use same classifier so they cannot drift", async () => {
  // Test that the behavior is identical for the dogfood 429 case
  const testCase = async (acceptedFlag) => {
    return await withTmpDir(async (dir) => {
      const stderrPath = join(dir, "stderr.txt");
      const stdoutPath = join(dir, "stdout.txt");
      const resultPath = join(dir, "result.json");
      await writeFile(
        stdoutPath,
        'API Error: Request rejected (429) · openai backend HTTP 429: {"status":429}',
        "utf8",
      );
      await writeFile(stderrPath, "", "utf8");

      return await finalizeProviderLaunchResult(
        { accepted: acceptedFlag },
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
          poolId: "pool-1",
        },
      );
    });
  };

  const notAccepted = await testCase(false); // no result file, exit ≠ 0
  const acceptedNoResult = await testCase(true); // no result file, but process succeeded

  // Both must classify the same way
  expect(notAccepted.outcome).toBe("rate_limited");
  expect(acceptedNoResult.outcome).toBe("rate_limited");
});

test("finalizeProviderLaunchResult: an ACCEPTED launch with a LANDED result file is success even when stderr carries 429 text (deliberate 2026-07-17 change — completed work is never discarded)", async () => {
  await withTmpDir(async (dir) => {
    const stderrPath = join(dir, "stderr.txt");
    const stdoutPath = join(dir, "stdout.txt");
    const resultPath = join(dir, "result.json");
    // The worker retried through transient 429s (logged to stderr) and still
    // delivered a valid result — the result wins; re-queueing would re-run
    // completed work. Channel classification applies only to rejected /
    // no-result launches.
    await writeFile(stderrPath, "API Error: Request rejected (429) · retrying", "utf8");
    await writeFile(stdoutPath, "", "utf8");
    await writeFile(resultPath, JSON.stringify([{ ok: true }]), "utf8");

    const result = await finalizeProviderLaunchResult(
      { accepted: true },
      {
        packet: basePacket(),
        providerName: "claude-worker",
        entityLabel: "packet p1",
        resultPath,
        stdoutPath,
        stderrPath,
        artifactsDir: dir,
        runId: "run-1",
        packetId: "p1",
        poolId: "nim/z-ai/glm-5.2",
      },
    );

    expect(result.outcome).toBe("success");
  });
});
