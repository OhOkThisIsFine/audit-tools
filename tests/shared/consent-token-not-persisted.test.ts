/**
 * Contract: an acquisition consent token authorizes ONE run and is never a
 * persisted capability.
 *
 * The token rides `AcquisitionEngineOptions` / `ExternalAcquisitionAdvanceOptions`
 * in memory and is consumed by `admitSpawn`. The two artifacts a run may durably
 * write in that neighborhood are the canonical repository session intent
 * (`.audit-tools/audit/session-config.json`) and the durable analyzer policy
 * (`.audit-tools/audit/analyzer-policy.json`). This suite pins the guarantee the
 * code provides TODAY: BOTH persisted schemas are strict and admit no
 * token-shaped field, the analyzer-policy store re-validates on WRITE (so a
 * token cannot be merged in through the mutate path), and the persisted bytes
 * carry decisions only.
 *
 * Adding a token-shaped field to either persisted schema turns this suite red.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AnalyzerPolicySchema,
  AnalyzerConsentDecisionSchema,
  SessionIntentV1Schema,
  getAnalyzerPolicyPath,
  loadAnalyzerPolicy,
  persistAnalyzerConsent,
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
        analyzer_consent: { eslint: "declined" },
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

describe("the analyzer-policy store never lets a token become durable", () => {
  it("persists decisions and settings without any token-shaped key", async () => {
    const root = await makeRoot();
    await persistAnalyzerSettings(root, { eslint: "permanent" });
    await persistAnalyzerConsent(root, { eslint: "declined" });

    const raw = await readFile(getAnalyzerPolicyPath(root), "utf8");
    expect(raw).not.toMatch(TOKEN_KEY_PATTERN);

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(key).not.toMatch(TOKEN_KEY_PATTERN);
    }
    expect(parsed).toEqual({
      analyzers: { eslint: "permanent" },
      analyzer_consent: { eslint: "declined" },
    });
  });

  it("fails closed on a policy artifact that already carries a token", async () => {
    const root = await makeRoot();
    const policyPath = getAnalyzerPolicyPath(root);
    await mkdir(dirname(policyPath), { recursive: true });
    await writeFile(
      policyPath,
      JSON.stringify({
        analyzer_consent: { eslint: "declined" },
        consentToken: "tok",
      }),
      "utf8",
    );

    await expect(loadAnalyzerPolicy(root)).rejects.toThrow(/consentToken/u);
  });
});

/**
 * The sibling guarantee, and the one an operator's egress exposure actually
 * rests on: a GRANT is not persistable either.
 *
 * A decline is durable — it vetoes every later spawn of that tool. A grant binds
 * the run that was asked (owner directive, 2026-08-21). A durable grant keeps
 * granting itself to runs whose operator never saw the offer, which for a
 * network-egress analyzer converts one consent into standing consent.
 *
 * That rule is enforced by the SCHEMA, not by a caller remembering it:
 * `AnalyzerConsentDecisionSchema` is a one-member enum, and the analyzer-policy
 * store re-validates on write. Re-widening it to accept "granted" turns this red.
 */
describe("a consent GRANT is not durable either", () => {
  it("refuses to persist a granted decision, and leaves the prior policy intact", async () => {
    const root = await makeRoot();
    await persistAnalyzerConsent(root, { knip: "declined" });

    await expect(
      // `as never` defeats the compile-time half deliberately: the point is that
      // the RUNTIME schema refuses it too, so a JS caller or a hand-edited
      // artifact cannot smuggle a standing grant in.
      persistAnalyzerConsent(root, { eslint: "granted" as never }),
    ).rejects.toThrow();

    const policy = await loadAnalyzerPolicy(root);
    expect(
      policy.analyzer_consent,
      "the refused write must not partially land",
    ).toEqual({ knip: "declined" });
  });

  it("the decision schema admits declines only", () => {
    expect(AnalyzerConsentDecisionSchema.safeParse("declined").success).toBe(true);
    expect(AnalyzerConsentDecisionSchema.safeParse("granted").success).toBe(false);
  });
});
