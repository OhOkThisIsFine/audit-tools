/**
 * Contract: analyzer consent authorizes ONE run and is never a persisted
 * capability.
 *
 * A grant rides `AcquisitionEngineOptions` / `ExternalAcquisitionAdvanceOptions`
 * in memory as the scoped {@link AnalyzerConsentTokenGrant} and is consumed by
 * `admitSpawn`; a decline rides the same options' in-flight `analyzerConsent`
 * map for the rest of the run. The two artifacts a run may durably write in
 * that neighborhood are the canonical repository session intent
 * (`.audit-tools/audit/session-config.json`) and the durable analyzer policy
 * (`.audit-tools/audit/analyzer-policy.json`). This suite pins the guarantee
 * the code provides TODAY:
 *
 * - BOTH persisted schemas are strict and admit no token-shaped field;
 * - the analyzer-policy schema has NO consent shape at all — neither a grant
 *   nor a decline is representable in it (packet 5 / O07: the retired
 *   `persistAnalyzerConsent` is gone);
 * - the store re-validates on WRITE (so nothing consent-shaped can be merged
 *   in through the mutate path) and strips a LEGACY `analyzer_consent` key on
 *   READ (so a policy file left by an older release loads — preserving its
 *   unrelated `analyzers` choices — while its consent can neither authorize
 *   nor veto the new run).
 *
 * Adding a token- or consent-shaped field to either persisted schema turns
 * this suite red.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AnalyzerPolicySchema,
  SessionIntentV1Schema,
  getAnalyzerPolicyPath,
  loadAnalyzerPolicy,
  persistAnalyzerSettings,
} from "audit-tools/shared";

/**
 * Every spelling a future field addition would plausibly use. A persisted schema
 * key matching this shape is a token becoming durable.
 */
const TOKEN_KEY_PATTERN = /token|secret|credential/iu;

const TOKEN_KEY_SPELLINGS = [
  "consentToken",
  "consent_token",
  "acquisitionConsentToken",
  "acquisition_consent_token",
  "token",
] as const;

function schemaKeys(schema: {
  readonly shape: Record<string, unknown>;
}): string[] {
  return Object.keys(schema.shape);
}

async function makeRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "consent-token-persist-"));
}

describe("persisted schemas admit no acquisition consent token", () => {
  it("the analyzer-policy schema's key set is token-free", () => {
    const keys = schemaKeys(AnalyzerPolicySchema);
    expect(keys).not.toHaveLength(0);
    for (const key of keys) {
      expect(key).not.toMatch(TOKEN_KEY_PATTERN);
    }
  });

  it("the session-intent schema's key set is token-free", () => {
    const keys = schemaKeys(SessionIntentV1Schema);
    expect(keys).not.toHaveLength(0);
    for (const key of keys) {
      expect(key).not.toMatch(TOKEN_KEY_PATTERN);
    }
  });

  it.each(TOKEN_KEY_SPELLINGS)(
    "the analyzer-policy schema rejects a %s field",
    (key) => {
      const parsed = AnalyzerPolicySchema.safeParse({
        analyzers: { eslint: "permanent" },
        [key]: "tok",
      });
      expect(parsed.success).toBe(false);
    },
  );

  it.each(TOKEN_KEY_SPELLINGS)(
    "the session-intent schema rejects a %s field",
    (key) => {
      const parsed = SessionIntentV1Schema.safeParse({
        review_mode: "attended",
        [key]: "tok",
      });
      expect(parsed.success).toBe(false);
    },
  );
});

describe("the analyzer-policy store never lets consent become durable", () => {
  it("persists settings without any token-shaped key", async () => {
    const root = await makeRoot();
    await persistAnalyzerSettings(root, { eslint: "permanent" });

    const raw = await readFile(getAnalyzerPolicyPath(root), "utf8");
    expect(raw).not.toMatch(TOKEN_KEY_PATTERN);

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(key).not.toMatch(TOKEN_KEY_PATTERN);
    }
    expect(parsed).toEqual({
      analyzers: { eslint: "permanent" },
    });
  });

  it("fails closed on a policy artifact that already carries a token", async () => {
    const root = await makeRoot();
    const policyPath = getAnalyzerPolicyPath(root);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({
        analyzers: { eslint: "permanent" },
        consentToken: "tok",
      }),
      "utf8",
    );

    await expect(loadAnalyzerPolicy(root)).rejects.toThrow(/consentToken/u);
  });
});

/**
 * The sibling guarantee, and the one an operator's egress exposure actually
 * rests on: a consent decision — grant OR decline — is not durable either.
 *
 * A decline vetoes spawns and a grant admits them, but both bind the run that
 * was asked (packet 5 / O07). A durable decline vetoes runs whose operator
 * never saw the offer; a durable grant keeps granting itself to runs whose
 * operator never saw the offer, which for a network-egress analyzer converts
 * one consent into standing consent.
 *
 * That rule is enforced by the ABSENCE of a shape: the analyzer-policy schema
 * has no consent field, so neither decision is representable in it. A legacy
 * `analyzer_consent` key left by an older release is stripped on READ — the
 * file loads, the unrelated settings survive, and the consent authorizes
 * nothing and vetoes nothing.
 */
describe("a consent decision is not durable either", () => {
  it("the analyzer-policy schema has no consent shape to be written into", () => {
    for (const decisions of [
      { eslint: "declined" },
      { eslint: "granted" },
    ]) {
      const parsed = AnalyzerPolicySchema.safeParse({
        analyzer_consent: decisions,
      });
      expect(parsed.success).toBe(false);
    }
    expect(schemaKeys(AnalyzerPolicySchema)).not.toContain("analyzer_consent");
  });

  it("a legacy analyzer_consent key loads but is stripped, never enforced", async () => {
    const root = await makeRoot();
    const policyPath = getAnalyzerPolicyPath(root);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({
        analyzers: { eslint: "permanent" },
        analyzer_consent: { knip: "declined", semgrep: "declined" },
      }),
      "utf8",
    );

    const policy = await loadAnalyzerPolicy(root);
    // Unrelated analyzer configuration survives the tolerant read ...
    expect(policy).toEqual({ analyzers: { eslint: "permanent" } });
    // ... while the legacy consent authorizes nothing and vetoes nothing.
    expect("analyzer_consent" in policy).toBe(false);
  });

  it("a legacy granted decision loads but is stripped, never enforced", async () => {
    const root = await makeRoot();
    const policyPath = getAnalyzerPolicyPath(root);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({ analyzer_consent: { eslint: "granted" } }),
      "utf8",
    );

    const policy = await loadAnalyzerPolicy(root);
    expect(policy).toEqual({});
  });
});
