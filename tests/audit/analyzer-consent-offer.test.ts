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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pendingAnalyzerConsent } from "../../src/audit/orchestrator/hostInputPause.js";
import { handleAnalyzerConsentBranch } from "../../src/audit/cli/nextStepHelpers.js";
import {
  GATE_LANES,
  laneSubmissionPath,
} from "../../src/audit/cli/laneSubmissions.js";
import { readSubmissionLedger } from "../../src/shared/submission/submissionLedger.js";
import {
  getAnalyzerPolicyPath,
  loadAnalyzerPolicy,
  persistAnalyzerConsent,
} from "../../src/shared/analyzerPolicy.js";
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
  it("merges decisions into analyzer-policy.json without changing session intent", async () => {
    const root = tempDir("consent-cfg-");
    const auditDir = join(root, ".audit-tools", "audit");
    const sessionConfigPath = join(auditDir, "session-config.json");
    const sessionConfigBytes = '{"review_mode":"autonomous"}\n';
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(sessionConfigPath, sessionConfigBytes, "utf8");

    await persistAnalyzerConsent(root, { eslint: "granted" });
    await persistAnalyzerConsent(root, { knip: "declined" });
    const cfg = JSON.parse(
      readFileSync(getAnalyzerPolicyPath(root), "utf8"),
    ) as {
      analyzer_consent?: Record<string, string>;
      external_acquisition?: unknown;
    };
    expect(cfg.analyzer_consent).toEqual({ eslint: "granted", knip: "declined" });
    expect(JSON.stringify(cfg)).not.toContain("consent_token");
    expect(readFileSync(sessionConfigPath, "utf8")).toBe(sessionConfigBytes);
  });

  it("rejects a persisted consent token as an unknown policy capability", async () => {
    const root = tempDir("consent-token-cfg-");
    const policyPath = getAnalyzerPolicyPath(root);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        analyzer_consent: { eslint: "granted" },
        external_acquisition: { consent_token: "must-not-persist" },
      }),
      "utf8",
    );

    await expect(loadAnalyzerPolicy(root)).rejects.toThrow(
      /analyzer-policy\.json/i,
    );
  });
});

describe("renderAnalyzerConsentPrompt — tool-rendered offer", () => {
  it("carries purpose, the gating reason, the decisions path, and the mechanism", () => {
    const eslint = EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "eslint")!;
    const prompt = renderAnalyzerConsentPrompt({
      pending: [eslint],
      decisionsPath: "X:/artifacts/submissions/0000000000000000000000000000000000000000000000000000000000000000.json",
      continueCommand: "audit-code next-step",
    });
    expect(prompt).toContain("`eslint`");
    expect(prompt).toContain(eslint.purpose!);
    expect(prompt).toContain("config can execute repo code");
    expect(prompt).toContain("X:/artifacts/submissions/0000000000000000000000000000000000000000000000000000000000000000.json");
    expect(prompt).toContain('"eslint": "granted"');
    expect(prompt).toContain("audit-code next-step");
  });
});

describe("the consent gate refuses a submission it understands nothing in", () => {
  /** Plant a decisions submission at the consent lane's tool-owned bound path. */
  const plant = (artifactsDir: string, body: unknown): string => {
    const path = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_consent);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body), "utf8");
    return path;
  };

  const driveConsentGate = async (root: string) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    mkdirSync(artifactsDir, { recursive: true });
    return {
      artifactsDir,
      run: () =>
        handleAnalyzerConsentBranch(
          {
            root,
            artifactsDir,
            externalAcquisition: { enabled: true },
          },
          {} as never,
          { status: "active", obligations: [] } as never,
          { value: undefined },
        ),
    };
  };

  it("zero recognized values: quarantined and recorded rejected, never accepted-and-deleted", async () => {
    const root = nodeRepo();
    const { artifactsDir, run } = await driveConsentGate(root);
    // The whole submission answers in a vocabulary the gate does not know.
    const planted = plant(artifactsDir, { eslint: "yes", knip: "maybe" });

    const branch = await run();
    expect(branch.action).toBe("continue");

    // The bytes survive: moved to quarantine, never unlinked-and-forgotten.
    expect(existsSync(planted), "the refused submission must leave its bound path").toBe(
      false,
    );
    const quarantined = readdirSync(join(artifactsDir, "quarantine"));
    expect(quarantined.some((name) => name.startsWith(GATE_LANES.analyzer_consent))).toBe(
      true,
    );

    const events = await readSubmissionLedger(artifactsDir);
    const outcomes = events.filter((event) => event.kind !== "expected");
    expect(outcomes.map((event) => event.kind)).toEqual(["rejected"]);
    expect(outcomes[0]!.issue_code).toBe("submission_contract_invalid");

    // ...and the gate re-asks rather than treating an unusable answer as done.
    const reEmit = await run();
    expect(reEmit.action).toBe("return");
  });

  it("partial recognition still applies the real decisions, naming the ignored keys on the record", async () => {
    const root = nodeRepo();
    const { artifactsDir, run } = await driveConsentGate(root);
    plant(artifactsDir, { eslint: "granted", knip: "maybe" });

    expect((await run()).action).toBe("continue");

    const policy = JSON.parse(readFileSync(getAnalyzerPolicyPath(root), "utf8")) as {
      analyzer_consent?: Record<string, string>;
    };
    expect(policy.analyzer_consent).toEqual({ eslint: "granted" });

    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (event) => event.kind === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.message, "the dropped key is on the record, not only on stderr")
      .toContain("knip");
  });
});

describe("candidate registry contract", () => {
  it("every registered candidate carries a purpose line for the offer", () => {
    for (const c of EXTERNAL_ANALYZER_CANDIDATES) {
      expect(c.purpose, `${c.id} must carry a purpose line`).toBeTruthy();
    }
  });
});
