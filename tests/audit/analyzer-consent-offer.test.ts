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
import { commitFold, createFoldTransaction } from "../../src/audit/cli/foldTransaction.js";
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFile as writeFileSyncCb,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  pendingAnalyzerConsent,
} from "../../src/audit/orchestrator/hostInputPause.js";
import type { AnalyzerConsentTokenGrant, FileDispositionStatus } from "audit-tools/shared";
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
const { writeFixtureRepo } = await import("./helpers/fixture.mjs");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const { runSyntaxResolutionExecutor } = await import(
  "../../src/audit/orchestrator/syntaxResolutionExecutor.js"
);
const writeFileAsync = promisify(writeFileSyncCb);

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

  it("a per-run SCOPED grant naming every applicable candidate empties the offer", () => {
    const root = nodeRepo();
    const base = pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true });
    expect(base.length).toBeGreaterThan(0);
    // Typed {@link AnalyzerConsentTokenGrant}, never a bare string: the grant
    // names EXACTLY the candidates it admits.
    const grant: AnalyzerConsentTokenGrant = {
      value: "tok-123",
      tools: base.map((c) => c.id),
    };
    expect(
      pendingAnalyzerConsent({
        root,
        externalAcquisitionEnabled: true,
        acquisitionConsentToken: grant,
      }),
    ).toEqual([]);
  });

  it("a PARTIAL grant leaves every unnamed candidate owed — scope never widens to the run", () => {
    const root = nodeRepo();
    const base = pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true });
    const named = base[0]!.id;
    const after = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
      acquisitionConsentToken: { value: "tok-part", tools: [named] },
    });
    expect(after.map((c) => c.id)).not.toContain(named);
    // Every candidate OUTSIDE the grant's `tools` is still owed its offer.
    expect(after.map((c) => c.id).sort()).toEqual(
      base.slice(1).map((c) => c.id).sort(),
    );
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

    await persistAnalyzerConsent(root, { knip: "declined" });
    const cfg = JSON.parse(
      readFileSync(getAnalyzerPolicyPath(root), "utf8"),
    ) as {
      analyzer_consent?: Record<string, string>;
      external_acquisition?: unknown;
    };
    expect(cfg.analyzer_consent).toEqual({ knip: "declined" });
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
    expect(prompt).toContain(
      "`declined` persists across runs; `granted` covers this run only, and the next run re-offers.",
    );
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
    // Held so a test can observe BOTH halves of the split: what the gate
    // persisted, and what it folded into this run's consent token.
    const externalAcquisition: {
      enabled: boolean;
      consentToken?: { value: string; tools: readonly string[] };
    } = { enabled: true };
    return {
      artifactsDir,
      externalAcquisition,
      // One gate turn, INCLUDING the fold's commit half: a consumed
      // submission's deletion and its accepted ledger event land at the
      // commit, not inside the handler (CX-02 persist-once).
      run: async () => {
        const tx = createFoldTransaction();
        const branch = await handleAnalyzerConsentBranch(
          { root, artifactsDir, externalAcquisition } as never,
          {} as never,
          { status: "active", obligations: [] } as never,
          { value: undefined },
          tx,
        );
        await commitFold(artifactsDir, {}, tx);
        return branch;
      },
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
    const { artifactsDir, externalAcquisition, run } = await driveConsentGate(root);
    plant(artifactsDir, { eslint: "granted", knip: "maybe" });

    expect((await run()).action).toBe("continue");

    // The grant IS applied — to this run, via the scoped consent token, which is
    // the only channel a grant travels on. It must NOT reach the durable policy:
    // a standing grant would keep admitting eslint for operators who never saw
    // the offer.
    expect(externalAcquisition.consentToken?.tools).toEqual(["eslint"]);
    expect(externalAcquisition.consentToken?.value).toBeTruthy();

    const policy = JSON.parse(readFileSync(getAnalyzerPolicyPath(root), "utf8")) as {
      analyzer_consent?: Record<string, string>;
    };
    expect(
      policy.analyzer_consent ?? {},
      "a grant must leave nothing durable behind",
    ).toEqual({});

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

/**
 * CP-NODE-5 — the decline-first LOCAL-tooling veto (formatters, syntax
 * resolvers) must fire through the PRODUCTION dispatch, not only at an
 * executor's direct seam. The first review found it dead in production: the
 * runner accepted `analyzerConsent` but `EXECUTOR_RUNNERS.auto_fix_executor`
 * dispatched with no third argument, so `admitLocalSpawn` always admitted.
 * These tests reach the veto THROUGH `advanceAudit` — the same path a real
 * `audit-code next-step` run takes — so unwiring the dispatch fails here.
 */
describe("the local-tooling decline veto fires through the production dispatch", () => {
  const bundleWith = (paths: string[]) => ({
    file_disposition: {
      files: paths.map((path): { path: string; status: FileDispositionStatus } => ({
        path,
        status: "included",
      })),
    },
  });

  interface AutoFixesApplied {
    executed_tools: string[];
    failed_tools: string[];
    tool_timings: unknown[];
    timestamp: string;
  }

  it("a recorded prettier decline refuses every auto-fix spawn through advanceAudit", async () => {
    await withTempDir("consent-veto-", async (root: string) => {
      await writeFixtureRepo(root);
      await writeFileAsync(join(root, ".prettierrc.json"), "{}\n");
      // The durable policy is where a real run's decisions live; the
      // production dispatch reads them out of the loaded policy via the
      // advance options.
      await persistAnalyzerConsent(root, { prettier: "declined" });
      const policy = await loadAnalyzerPolicy(root);
      expect(policy.analyzer_consent?.prettier).toBe("declined");

      const result = await advanceAudit(bundleWith([
        "src/api/auth.ts",
        "infra/deploy.yml",
      ]), {
        root,
        preferredExecutor: "auto_fix_executor",
        externalAcquisition: {
          enabled: true,
          analyzers: policy.analyzers,
          analyzerConsent: policy.analyzer_consent,
        },
      });

      expect(result.selected_executor).toBe("auto_fix_executor");
      const applied = result.updated_bundle
        .auto_fixes_applied as AutoFixesApplied;
      expect(applied.executed_tools, "a declined formatter never executes").toEqual([]);
      expect(applied.failed_tools, "a refusal is not a formatter failure").toEqual([]);
      expect(applied.tool_timings).toEqual([]);
    });
  });

  it("without the decline the same run still attempts the formatter (veto is decision-driven)", async () => {
    await withTempDir("consent-no-veto-", async (root: string) => {
      await writeFixtureRepo(root);
      await writeFileAsync(join(root, ".prettierrc.json"), "{}\n");
      // A repo-local prettier entrypoint so the repo-local arm (the first
      // candidate) is resolvable without any real npm install.
      const binDir = join(root, "node_modules", "prettier", "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "prettier.cjs"), "");

      const result = await advanceAudit(bundleWith(["src/api/auth.ts"]), {
        root,
        preferredExecutor: "auto_fix_executor",
      });

      const applied = result.updated_bundle
        .auto_fixes_applied as AutoFixesApplied;
      // No recorded decision ⇒ admission proceeds. Whether prettier itself
      // succeeds or fails on this machine is not the assertion; that it was
      // ATTEMPTED is.
      const attempted =
        applied.executed_tools.includes("prettier") ||
        applied.failed_tools.includes("prettier");
      expect(attempted, "no decline ⇒ prettier must be attempted").toBeTruthy();
    });
  });

  it("a recorded eslint decline surfaces as skipped coverage, never resolved:true", async () => {
    await withTempDir("consent-syntax-", async (root: string) => {
      await writeFixtureRepo(root);
      // Flat config — the only form the runnable gate accepts.
      await writeFileAsync(join(root, "eslint.config.js"), "module.exports = [];\n");
      await persistAnalyzerConsent(root, { eslint: "declined" });
      const policy = await loadAnalyzerPolicy(root);

      const result = await runSyntaxResolutionExecutor(
        bundleWith(["src/api/auth.ts"]),
        root,
        { analyzerConsent: policy.analyzer_consent },
      );

      const statuses =
        result.updated.external_analyzer_results?.find(
          (r) => r.tool === "syntax_resolution_executor",
        )?.tool_statuses ?? [];
      const eslintStatus = statuses.find((s) => s.tool === "eslint");
      expect(eslintStatus, "eslint status must be recorded").toBeTruthy();
      expect(eslintStatus!.resolved).toBe(false);
      expect(eslintStatus!.status).toBe("skipped");
      expect(eslintStatus!.error).toContain("declined");
    });
  });
});
