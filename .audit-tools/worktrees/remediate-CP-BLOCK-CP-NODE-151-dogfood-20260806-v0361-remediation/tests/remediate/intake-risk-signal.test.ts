/**
 * Self-scaling pipeline, slice 2 — the shared intake risk/complexity signal.
 *
 * One signal, computed cheaply at intake from intake-available data only
 * (affected_files + a deterministic configurable path-risk pattern set + intent),
 * fail-closed (uncertain ⇒ more scrutiny), re-assessable upward only via
 * escalate-on-evidence, and persisted once per run (idempotent so an escalation
 * is never clobbered). No dial consumes it yet — this is the source of truth.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeIntakeRiskSignal,
  escalateRiskSignal,
  decompositionRiskEvidence,
  ensureIntakeRiskSignal,
  readIntakeRiskSignal,
  writeIntakeRiskSignal,
  maxRiskTier,
  type IntakeRiskSignal,
} from "../../src/remediate/riskSignal.js";

describe("computeIntakeRiskSignal", () => {
  it("rates a localized, benign single-file change as low", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["fix a typo in the report header"],
    });
    expect(sig.tier).toBe("low");
    expect(sig.inputs.file_count).toBe(1);
    expect(sig.inputs.matched_path_risks).toEqual([]);
    expect(sig.escalated).toBe(false);
  });

  it("rates a change touching a risk subsystem as high", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/steps/dispatch.ts"],
      goals: ["adjust wave scheduling"],
    });
    expect(sig.tier).toBe("high");
    expect(sig.inputs.matched_path_risks).toContain("dispatch");
  });

  it("treats Windows backslash paths the same as forward-slash", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["src\\shared\\quota\\scheduler.ts"],
      goals: ["x"],
    });
    expect(sig.tier).toBe("high");
    // both the quota and shared-core and concurrency families can match — at least one risk family present
    expect(sig.inputs.matched_path_risks.length).toBeGreaterThan(0);
  });

  it("bumps to medium on intent-risk keywords alone", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["harden the auth token refresh against a security issue"],
    });
    expect(sig.tier).toBe("medium");
    expect(sig.inputs.matched_intent_risks).toContain("security");
  });

  it("bumps on file-count breadth thresholds", () => {
    const six = computeIntakeRiskSignal({
      affectedFiles: Array.from({ length: 6 }, (_, i) => `src/remediate/reporting/r${i}.ts`),
      goals: ["x"],
    });
    expect(six.tier).toBe("medium");

    const fifteen = computeIntakeRiskSignal({
      affectedFiles: Array.from({ length: 15 }, (_, i) => `src/remediate/reporting/r${i}.ts`),
      goals: ["x"],
    });
    expect(fifteen.tier).toBe("high");
  });

  it("deduplicates affected files before counting", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["a.ts", "./a.ts", "a.ts"],
      goals: ["x"],
    });
    expect(sig.inputs.file_count).toBe(1);
  });

  it("fails closed to high when there is nothing to assess", () => {
    const sig = computeIntakeRiskSignal({ affectedFiles: [], goals: [] });
    expect(sig.tier).toBe("high");
    expect(sig.escalated).toBe(false);
  });

  it("honors a configurable path-risk pattern set", () => {
    const sig = computeIntakeRiskSignal({
      affectedFiles: ["lib/payments/charge.ts"],
      goals: ["x"],
      config: { pathRiskPatterns: [{ label: "payments", pattern: /payments/i }] },
    });
    expect(sig.tier).toBe("high");
    expect(sig.inputs.matched_path_risks).toEqual(["payments"]);
  });
});

describe("escalateRiskSignal", () => {
  it("raises the tier and appends rationale, marking escalated", () => {
    const base = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["typo"],
    });
    expect(base.tier).toBe("low");
    const raised = escalateRiskSignal(base, {
      tier: "high",
      reason: "decomposition surfaced a cross-module seam",
    });
    expect(raised.tier).toBe("high");
    expect(raised.escalated).toBe(true);
    expect(raised.rationale.at(-1)).toContain("cross-module seam");
  });

  it("never lowers the tier and returns the same reference when no raise", () => {
    const base: IntakeRiskSignal = {
      schema_version: "remediate-code-intake-risk-signal/v1alpha1",
      tier: "high",
      rationale: ["risky"],
      inputs: { file_count: 1, matched_path_risks: ["dispatch"], matched_intent_risks: [] },
      escalated: false,
    };
    const same = escalateRiskSignal(base, { tier: "low", reason: "trivial detail" });
    expect(same).toBe(base);
    expect(same.tier).toBe("high");
  });
});

describe("decompositionRiskEvidence (slice 4 — optimistic-start escalate-on-evidence)", () => {
  it("returns undefined for a single, benign module (no escalation)", () => {
    const ev = decompositionRiskEvidence({
      moduleCount: 1,
      fileScopes: ["src/remediate/reporting/render.ts"],
    });
    expect(ev).toBeUndefined();
  });

  it("escalates to medium when decomposition produces more than one module", () => {
    const ev = decompositionRiskEvidence({
      moduleCount: 3,
      fileScopes: ["src/remediate/reporting/a.ts", "src/remediate/reporting/b.ts"],
    });
    expect(ev?.tier).toBe("medium");
    expect(ev?.reason).toContain("3 modules");
  });

  it("escalates to high when a module file_scope touches a risk subsystem", () => {
    const ev = decompositionRiskEvidence({
      moduleCount: 1,
      fileScopes: ["src/remediate/steps/dispatch.ts"],
    });
    expect(ev?.tier).toBe("high");
    expect(ev?.reason).toContain("dispatch");
  });

  it("prefers the high path-risk verdict over the medium module-count verdict", () => {
    const ev = decompositionRiskEvidence({
      moduleCount: 4,
      fileScopes: ["src/shared/quota/scheduler.ts", "src/remediate/reporting/r.ts"],
    });
    expect(ev?.tier).toBe("high");
  });

  it("honors a configurable path-risk pattern set", () => {
    const ev = decompositionRiskEvidence({
      moduleCount: 1,
      fileScopes: ["lib/payments/charge.ts"],
      config: { pathRiskPatterns: [{ label: "payments", pattern: /payments/i }] },
    });
    expect(ev?.tier).toBe("high");
    expect(ev?.reason).toContain("payments");
  });

  it("composes with escalateRiskSignal to raise a low intake signal, convergently", () => {
    const base = computeIntakeRiskSignal({
      affectedFiles: ["src/remediate/reporting/render.ts"],
      goals: ["small refactor"],
    });
    expect(base.tier).toBe("low");
    const ev = decompositionRiskEvidence({
      moduleCount: 2,
      fileScopes: ["src/remediate/reporting/a.ts", "src/remediate/reporting/b.ts"],
    });
    const raised = escalateRiskSignal(base, ev!);
    expect(raised.tier).toBe("medium");
    expect(raised.escalated).toBe(true);
    // Re-applying the same evidence is a no-op (convergent — no duplicate rationale).
    const again = escalateRiskSignal(raised, ev!);
    expect(again).toBe(raised);
  });
});

describe("maxRiskTier", () => {
  it("picks the higher tier", () => {
    expect(maxRiskTier("low", "high")).toBe("high");
    expect(maxRiskTier("medium", "low")).toBe("medium");
  });
});

describe("ensureIntakeRiskSignal (idempotent persistence)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "risk-signal-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("computes and persists on first call, reads back identically", async () => {
    const artifactsDir = join(root, ".audit-tools", "remediation");
    const first = await ensureIntakeRiskSignal(artifactsDir, () => ({
      affectedFiles: ["src/remediate/steps/dispatch.ts"],
      goals: ["scheduling"],
    }));
    expect(first.tier).toBe("high");
    const onDisk = await readIntakeRiskSignal(artifactsDir);
    expect(onDisk).toEqual(first);
  });

  it("invokes the lazy input provider only when it actually computes", async () => {
    const artifactsDir = join(root, ".audit-tools", "remediation");
    let calls = 0;
    const provider = () => {
      calls += 1;
      return { affectedFiles: ["a.ts"], goals: ["x"] };
    };
    await ensureIntakeRiskSignal(artifactsDir, provider);
    await ensureIntakeRiskSignal(artifactsDir, provider);
    expect(calls).toBe(1); // second call short-circuits on the persisted file
  });

  it("never clobbers a persisted (e.g. escalated) signal on a later call", async () => {
    const artifactsDir = join(root, ".audit-tools", "remediation");
    // Persist an escalated high-tier signal first.
    const escalated = escalateRiskSignal(
      computeIntakeRiskSignal({ affectedFiles: ["a.ts"], goals: ["typo"] }),
      { tier: "high", reason: "a verify failed" },
    );
    await writeIntakeRiskSignal(artifactsDir, escalated);

    // A later ensure call with low-risk inputs must NOT recompute over it.
    const effective = await ensureIntakeRiskSignal(artifactsDir, () => ({
      affectedFiles: ["a.ts"],
      goals: ["typo"],
    }));
    expect(effective.tier).toBe("high");
    expect(effective.escalated).toBe(true);
  });
});
