import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureQuotaUnclassifiedFriction, stepBoundaryEventId } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

/**
 * Slice A2b (TIER 2 of the three-tier classifier) — the quota-unclassified
 * harvest mechanism. captureQuotaUnclassifiedFriction single-sources the
 * onQuotaUnclassified template both audit's rollingAuditDispatch.ts and
 * remediate's nextStep.ts fire, mirroring captureCreditExhaustionFriction's
 * pattern (tests/shared/credit-exhaustion-friction.test.mjs). The distinguishing
 * requirement here: the note must carry the VERBATIM (secret-scrubbed) provider
 * message, not just a short matched substring, so an operator can author a new
 * precise pattern from it.
 */

async function readRecord(dir, runId) {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
}

async function waitForFrictionCount(dir, runId, count, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      const raw = await readRecord(dir, runId);
      if (raw.frictions.length >= count) return raw;
    } catch {
      // File not written yet — keep polling.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} friction record(s) in ${dir}/${runId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("captureQuotaUnclassifiedFriction records a quota_unclassified fact naming the pool + the VERBATIM message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-unclassified-"));
  try {
    captureQuotaUnclassifiedFriction(
      dir,
      "run-1",
      { poolId: "nim-deep", text: "Upstream billing service rejected this request unexpectedly." },
      "audit-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    expect(raw.frictions.length).toBe(1);
    const [item] = raw.frictions;
    expect(item.id).toBe(stepBoundaryEventId("quota_unclassified", "run-1", "nim-deep"));
    expect(item.note).toContain('pool "nim-deep"');
    expect(item.note).toContain("matched NO known pattern");
    expect(item.note).toContain("NOT permanently excluded");
    expect(item.note).toContain("Upstream billing service rejected this request unexpectedly.");
    expect(item.severity).toBe("high");
    // tool_should_decide — the tool could not confidently classify this; the
    // operator must review + potentially teach errorParsing.ts a new pattern.
    expect(item.frictionCategory).toBe("tool_should_decide");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureQuotaUnclassifiedFriction scrubs a bare *_KEY env value that is NOT sk-prefixed (adversarial-review gap: NIM_KEY + nvapi-)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-unclassified-scrub-"));
  // The env-name regex used to require literal "API" before "KEY", and the shape
  // backstop only matched sk-… — so a plausible NVIDIA config (NIM_KEY holding an
  // nvapi-… value) leaked in full. This asserts BOTH gaps are closed: the value is
  // caught by the widened env-name segment match, independent of the sk-/nvapi- shape.
  const priorKey = process.env.NIM_KEY;
  process.env.NIM_KEY = "nvapi-QZ9x7Kv2LmN4pR8sT1uW3yA5bC6dE7fG8hJ0kL2mN4pQ6rS8tU0";
  try {
    captureQuotaUnclassifiedFriction(
      dir,
      "run-1",
      {
        poolId: "nim-pool",
        text: `Rejected: request carried key ${process.env.NIM_KEY} which is over your quota.`,
      },
      "audit-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    const note = raw.frictions[0].note;
    expect(note).not.toContain(process.env.NIM_KEY);
    expect(note).not.toContain("nvapi-QZ9x7Kv2LmN4pR8sT1uW3yA5bC6dE7fG8hJ0kL2mN4pQ6rS8tU0");
    expect(note).toContain("[REDACTED]");
    // Surrounding non-secret context preserved for pattern authoring.
    expect(note).toContain("Rejected: request carried key");
    expect(note).toContain("which is over your quota");
  } finally {
    if (priorKey === undefined) delete process.env.NIM_KEY;
    else process.env.NIM_KEY = priorKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureQuotaUnclassifiedFriction scrubs shape-based secrets NOT in this process env (ghp_, JWT, nvapi-, key=value)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-unclassified-shape-"));
  try {
    const gh = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF123-_ghiJKLmno";
    const nvapi = "nvapi-Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm6Ll5";
    captureQuotaUnclassifiedFriction(
      dir,
      "run-1",
      {
        poolId: "p",
        text: `429 too many requests. token=${gh} jwt ${jwt} key ${nvapi} api_key=Sup3rSecretValue123`,
      },
      "audit-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    const note = raw.frictions[0].note;
    for (const secret of [gh, jwt, nvapi, "Sup3rSecretValue123"]) {
      expect(note, secret).not.toContain(secret);
    }
    expect(note).toContain("[REDACTED]");
    // The quota-relevant phrasing survives for pattern authoring.
    expect(note).toContain("429 too many requests");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureQuotaUnclassifiedFriction scrubs a Bearer token even when it is not a currently-set env var", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-unclassified-bearer-"));
  try {
    captureQuotaUnclassifiedFriction(
      dir,
      "run-1",
      {
        poolId: "nim-pool",
        text: "403 rejected — Bearer abcdefghij1234567890 is over quota",
      },
      "remediate-code",
    );
    const raw = await waitForFrictionCount(dir, "run-1", 1);
    const note = raw.frictions[0].note;
    expect(note).not.toContain("abcdefghij1234567890");
    expect(note).toContain("Bearer [REDACTED]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureQuotaUnclassifiedFriction from audit-code and remediate-code use the identical template (differ only by source tool)", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "quota-unclassified-audit-"));
  const dirR = await mkdtemp(join(tmpdir(), "quota-unclassified-remediate-"));
  try {
    const info = { poolId: "shared-pool", text: "unrecognized quota-shaped rejection" };
    captureQuotaUnclassifiedFriction(dirA, "run-x", info, "audit-code");
    captureQuotaUnclassifiedFriction(dirR, "run-x", info, "remediate-code");

    const rawA = await waitForFrictionCount(dirA, "run-x", 1);
    const rawR = await waitForFrictionCount(dirR, "run-x", 1);
    expect(rawA.frictions[0].note).toBe(rawR.frictions[0].note);
    expect(rawA.frictions[0].severity).toBe(rawR.frictions[0].severity);
    expect(rawA.tool).toBe("audit-code");
    expect(rawR.tool).toBe("remediate-code");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirR, { recursive: true, force: true });
  }
});

test("captureQuotaUnclassifiedFriction is fire-and-forget: returns void synchronously, never a Promise", () => {
  const result = captureQuotaUnclassifiedFriction(
    "\0not-a-dir",
    "run-1",
    { poolId: "p", text: "x" },
    "remediate-code",
  );
  expect(result).toBeUndefined();
});
