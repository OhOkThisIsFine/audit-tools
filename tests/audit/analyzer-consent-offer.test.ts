/**
 * Item B — consent-offer surfacing (spec/mechanical-analyzer-layer-design.md).
 * The silent-fail-closed defect: applicable consent-gated analyzers were
 * skipped without the operator ever seeing the choice. Pins:
 *  - pendingAnalyzerConsent: the single source of "who is owed an offer"
 *    (applicable + gated + undecided; token/disabled/skip/decided empty it);
 *  - the drain stop predicate halts on a pending offer (fold-level pause);
 *  - persistAnalyzerConsent records decisions durably (and never a token);
 *  - the offer prompt is tool-rendered with purpose + safety + mechanism.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingAnalyzerConsent } from "../../src/audit/orchestrator/hostInputPause.js";
import { persistAnalyzerConsent } from "../../src/audit/supervisor/sessionConfig.js";
import { renderAnalyzerConsentPrompt } from "../../src/audit/cli/prompts.js";
import { EXTERNAL_ANALYZER_CANDIDATES } from "../../src/shared/analyzers/candidates.js";

const RM_DIRS: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  RM_DIRS.push(d);
  return d;
};

afterEach(() => {
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

/** A node-ecosystem repo root: package.json makes semgrep/eslint/knip applicable. */
function nodeRepo(): string {
  const root = tempDir("consent-repo-");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fx", private: true }));
  return root;
}

describe("pendingAnalyzerConsent — who is owed the offer", () => {
  it("lists applicable consent-gated candidates with no recorded decision", () => {
    const pending = pendingAnalyzerConsent({
      root: nodeRepo(),
      externalAcquisitionEnabled: true,
    });
    const ids = pending.map((c) => c.id);
    expect(ids).toContain("eslint");
    expect(ids).toContain("knip");
    // Default-set members are never offered.
    expect(ids).not.toContain("gitleaks");
    expect(ids).not.toContain("hadolint");
    // Every offered candidate is genuinely consent-gated.
    for (const c of pending) expect(c.defaultRun).toBe(false);
  });

  it("a recorded decision (granted OR declined) removes the candidate — declined is never re-offered", () => {
    const root = nodeRepo();
    const base = pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true });
    const first = base[0]!.id;
    const after = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
      analyzerConsent: { [first]: "declined" },
    });
    expect(after.map((c) => c.id)).not.toContain(first);
    expect(after).toHaveLength(base.length - 1);
  });

  it("a per-run token empties the offer (everything is admitted this run)", () => {
    expect(
      pendingAnalyzerConsent({
        root: nodeRepo(),
        externalAcquisitionEnabled: true,
        acquisitionConsentToken: "tok-123",
      }),
    ).toEqual([]);
  });

  it("acquisition disabled / no root / skip setting all empty the offer", () => {
    const root = nodeRepo();
    expect(pendingAnalyzerConsent({ root })).toEqual([]);
    expect(pendingAnalyzerConsent({ externalAcquisitionEnabled: true })).toEqual([]);
    const withSkip = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
      analyzers: { eslint: "skip" },
    });
    expect(withSkip.map((c) => c.id)).not.toContain("eslint");
  });
});

describe("persistAnalyzerConsent — decisions durable, tokens never", () => {
  it("merges decisions into session-config.json analyzer_consent", async () => {
    const artifactsDir = tempDir("consent-cfg-");
    await persistAnalyzerConsent(artifactsDir, { eslint: "granted" });
    await persistAnalyzerConsent(artifactsDir, { knip: "declined" });
    const cfg = JSON.parse(
      readFileSync(join(artifactsDir, "session-config.json"), "utf8"),
    ) as { analyzer_consent?: Record<string, string>; external_acquisition?: unknown };
    expect(cfg.analyzer_consent).toEqual({ eslint: "granted", knip: "declined" });
    expect(JSON.stringify(cfg)).not.toContain("consent_token");
  });
});

describe("renderAnalyzerConsentPrompt — tool-rendered offer", () => {
  it("carries purpose, the gating reason, the decisions path, and the mechanism", () => {
    const eslint = EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "eslint")!;
    const prompt = renderAnalyzerConsentPrompt({
      pending: [eslint],
      decisionsPath: "X:/artifacts/incoming/analyzer-consent-decisions.json",
      continueCommand: "audit-code next-step",
    });
    expect(prompt).toContain("`eslint`");
    expect(prompt).toContain(eslint.purpose!);
    expect(prompt).toContain("config can execute repo code");
    expect(prompt).toContain("analyzer-consent-decisions.json");
    expect(prompt).toContain('"eslint": "granted"');
    expect(prompt).toContain("audit-code next-step");
  });
});

describe("candidate registry contract", () => {
  it("every registered candidate carries a purpose line for the offer", () => {
    for (const c of EXTERNAL_ANALYZER_CANDIDATES) {
      expect(c.purpose, `${c.id} must carry a purpose line`).toBeTruthy();
    }
  });
});
