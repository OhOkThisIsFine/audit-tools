/**
 * Item B — consent-offer surfacing (spec/mechanical-analyzer-layer-design.md),
 * under packet 5 / O07 per-run consent.
 * The silent-fail-closed defect: applicable consent-gated analyzers were
 * skipped without the operator ever seeing the choice. Pins:
 *  - pendingAnalyzerConsent: the single source of "who is owed an offer"
 *    (applicable + gated + undecided this run; token/disabled/skip/decided
 *    empty it);
 *  - the drain stop predicate halts on a pending offer (fold-level pause);
 *  - decisions are strictly per-run: NOTHING durable is written (grants ride
 *    the scoped token, declines ride the in-flight map), so the next run
 *    re-offers every candidate after either a grant or a decline;
 *  - a legacy `analyzer_consent` key in an old policy file is ignored — it can
 *    neither authorize nor veto the new run;
 *  - the offer prompt is tool-rendered with purpose + security risks + an
 *    explicit operator question and a strict value enum.
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

  it("a decision this run (decline OR scoped grant) removes the candidate — and the next run is asked again", () => {
    const root = nodeRepo();
    const base = pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true });
    const first = base[0]!.id;
    // Within the run, both answers suppress the re-offer: a decline rides the
    // in-flight map, a grant rides the scoped token.
    const declinedThisRun = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
      analyzerConsent: { [first]: "declined" },
    });
    expect(declinedThisRun.map((c) => c.id)).not.toContain(first);
    expect(declinedThisRun).toHaveLength(base.length - 1);
    const grantedThisRun = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
      acquisitionConsentToken: { value: "tok", tools: [first] },
    });
    expect(grantedThisRun.map((c) => c.id)).not.toContain(first);
    // The NEXT run starts with neither — every candidate is owed its offer
    // again, after either a grant or a decline.
    const nextRun = pendingAnalyzerConsent({ root, externalAcquisitionEnabled: true });
    expect(nextRun.map((c) => c.id).sort()).toEqual(
      base.map((c) => c.id).sort(),
    );
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

describe("consent decisions are per-run: nothing durable is written, tokens never", () => {
  it("answering the offer folds decisions into the run without touching the durable policy", async () => {
    // A node-ecosystem repo so consent-gated candidates are applicable and the
    // gate has an offer to answer.
    const root = nodeRepo();
    const auditDir = join(root, ".audit-tools", "audit");
    const sessionConfigPath = join(auditDir, "session-config.json");
    const sessionConfigBytes = '{"review_mode":"autonomous"}\n';
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(sessionConfigPath, sessionConfigBytes, "utf8");

    // Drive one gate turn answering "declined" for knip, through the same
    // production handler a real next-step fold uses.
    const artifactsDir = join(root, ".audit-tools", "audit");
    const consentPath = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_consent);
    mkdirSync(dirname(consentPath), { recursive: true });
    writeFileSync(consentPath, JSON.stringify({ knip: "declined" }), "utf8");
    const externalAcquisition: {
      enabled: boolean;
      analyzerConsent?: Record<string, "declined">;
      consentToken?: { value: string; tools: readonly string[] };
    } = { enabled: true };
    const tx = createFoldTransaction();
    const branch = await handleAnalyzerConsentBranch(
      { root, artifactsDir, externalAcquisition } as never,
      {} as never,
      { status: "active", obligations: [] } as never,
      { value: undefined },
      tx,
    );
    expect(branch.action).toBe("continue");

    // The decline vetoes knip for the rest of THIS run via the in-flight map.
    expect(externalAcquisition.analyzerConsent).toEqual({ knip: "declined" });
    expect(externalAcquisition.consentToken, "a decline mints no grant token").toBeUndefined();
    // ...and leaves nothing durable behind: no policy file, no session change.
    expect(existsSync(getAnalyzerPolicyPath(root)), "a per-run decision must not create the durable policy").toBe(false);
    expect(readFileSync(sessionConfigPath, "utf8")).toBe(sessionConfigBytes);
  });

  it("a legacy policy file carrying analyzer_consent loads but cannot authorize or veto", async () => {
    // A node-ecosystem repo (package.json makes eslint applicable) whose
    // policy file was written by an older release.
    const root = nodeRepo();
    const policyPath = getAnalyzerPolicyPath(root);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        analyzers: { typescript: "skip" },
        analyzer_consent: { eslint: "declined", knip: "declined" },
      }),
      "utf8",
    );

    // Loads (unrelated analyzer configuration is preserved) ...
    const policy = await loadAnalyzerPolicy(root);
    expect(policy.analyzers).toEqual({ typescript: "skip" });
    // ... but the legacy consent authorizes nothing and vetoes nothing: the
    // loaded policy carries no consent shape at all, so the new run re-offers
    // every applicable candidate.
    expect("analyzer_consent" in policy).toBe(false);
    expect(
      pendingAnalyzerConsent({
        root,
        externalAcquisitionEnabled: true,
        analyzers: policy.analyzers,
      }).map((c) => c.id),
    ).toContain("eslint");
  });

  it("the strict schema still rejects a persisted consent token as an unknown capability", async () => {
    const root = tempDir("consent-token-cfg-");
    const policyPath = getAnalyzerPolicyPath(root);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      JSON.stringify({
        analyzers: { eslint: "permanent" },
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
  it("carries purpose, the gating risks, the decisions path, the per-run mechanism, and the strict enum", () => {
    const eslint = EXTERNAL_ANALYZER_CANDIDATES.find((c) => c.id === "eslint")!;
    const prompt = renderAnalyzerConsentPrompt({
      pending: [eslint],
      decisionsPath: "X:/artifacts/submissions/0000000000000000000000000000000000000000000000000000000000000000.json",
      continueCommand: "audit-code next-step",
    });
    expect(prompt).toContain("`eslint`");
    expect(prompt).toContain(eslint.purpose!);
    expect(prompt).toContain("Arbitrary code execution during config evaluation");
    // Per-run ephemerality, stated outright — no durable decline.
    expect(prompt).toContain("strictly per-run and do not persist across runs");
    expect(prompt).toContain("the next run asks again");
    // The host is explicitly told to ASK, never to decide.
    expect(prompt).toContain("Ask the operator directly");
    expect(prompt).toContain("Do not make assumptions or answer on the operator's behalf");
    // Consent-gated runs are observe-only; source mutation is a separate opt-in.
    expect(prompt).toContain("never modify");
    expect(prompt).toContain("opt-in auto-fix");
    // Strict decision vocabulary.
    expect(prompt).toContain('`"granted"` or `"declined"`');
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
    // Held so a test can observe what the gate folded into this run: the
    // in-flight decline map and the scoped grant token. NOTHING is persisted —
    // per-run consent leaves no durable trace by design.
    const externalAcquisition: {
      enabled: boolean;
      analyzerConsent?: Record<string, "declined">;
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
    plant(artifactsDir, { eslint: "granted", knip: "declined", jscpd: "maybe" });

    expect((await run()).action).toBe("continue");

    // The grant IS applied — to this run, via the scoped consent token, which is
    // the only channel a grant travels on ...
    expect(externalAcquisition.consentToken?.tools).toEqual(["eslint"]);
    expect(externalAcquisition.consentToken?.value).toBeTruthy();
    // ... and the decline IS applied — to this run, via the in-flight map.
    expect(externalAcquisition.analyzerConsent).toEqual({ knip: "declined" });

    // NEITHER reaches durable storage: no policy file is created at all.
    expect(
      existsSync(getAnalyzerPolicyPath(root)),
      "grants and declines alike leave nothing durable behind",
    ).toBe(false);

    const accepted = (await readSubmissionLedger(artifactsDir)).filter(
      (event) => event.kind === "accepted",
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.message, "the dropped key is on the record, not only on stderr")
      .toContain("jscpd");
  });

  it("the next run re-offers after a decline: nothing decided carries over", async () => {
    const root = nodeRepo();
    const { artifactsDir, externalAcquisition, run } = await driveConsentGate(root);
    plant(artifactsDir, { knip: "declined" });
    expect((await run()).action).toBe("continue");
    expect(externalAcquisition.analyzerConsent).toEqual({ knip: "declined" });

    // A FRESH run starts with no in-flight decisions and no durable ones — the
    // same candidate is owed its offer again.
    const pending = pendingAnalyzerConsent({
      root,
      externalAcquisitionEnabled: true,
    });
    expect(pending.map((c) => c.id)).toContain("knip");

    // ... and committing the fold wrote no policy file that could veto it.
    expect(existsSync(getAnalyzerPolicyPath(root))).toBe(false);
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

  it("a this-run prettier decline refuses every auto-fix spawn through advanceAudit", async () => {
    await withTempDir("consent-veto-", async (root: string) => {
      await writeFixtureRepo(root);
      await writeFileAsync(join(root, ".prettierrc.json"), "{}\n");
      // The decline lives on the run's in-flight acquisition options — the
      // same channel a real fold folds the `analyzer_consent` lane into.
      // The run is OPTED IN to auto-fix so the refusal below proves the VETO,
      // not the packet-5 default-off gate.
      const result = await advanceAudit(bundleWith([
        "src/api/auth.ts",
        "infra/deploy.yml",
      ]), {
        root,
        preferredExecutor: "auto_fix_executor",
        autoFix: { enabled: true },
        externalAcquisition: {
          enabled: true,
          analyzerConsent: { prettier: "declined" },
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

  it("without the decline the same opted-in run still attempts the formatter (veto is decision-driven)", async () => {
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
        autoFix: { enabled: true },
      });

      const applied = result.updated_bundle
        .auto_fixes_applied as AutoFixesApplied;
      // No this-run decision ⇒ admission proceeds. Whether prettier itself
      // succeeds or fails on this machine is not the assertion; that it was
      // ATTEMPTED is.
      const attempted =
        applied.executed_tools.includes("prettier") ||
        applied.failed_tools.includes("prettier");
      expect(attempted, "no decline ⇒ prettier must be attempted").toBeTruthy();
    });
  });

  it("a this-run eslint decline surfaces as skipped coverage, never resolved:true", async () => {
    await withTempDir("consent-syntax-", async (root: string) => {
      await writeFixtureRepo(root);
      // Flat config — the only form the runnable gate accepts.
      await writeFileAsync(join(root, "eslint.config.js"), "module.exports = [];\n");

      const result = await runSyntaxResolutionExecutor(
        bundleWith(["src/api/auth.ts"]),
        root,
        { analyzerConsent: { eslint: "declined" } },
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
