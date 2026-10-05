import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileDecisionCleanup, readDecisionSnapshot, decisionContextDigest, type DecisionApplicationReceipt } from "../../src/remediate/state/decisionConsumption.js";
import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";
import type { RemediationState } from "../../src/remediate/state/store.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "decision-recovery-")); });
afterEach(async () => { vi.mocked(rename).mockRestore(); await rm(dir, { recursive: true, force: true }); });

async function fixture(): Promise<{ state: RemediationState; input: string; result: string; receipt: DecisionApplicationReceipt }> {
  const state: RemediationState = {
    status: "implementing", plan: canonicalPlanFixture({ units: [canonicalUnitFixture("F1")] }),
    items: { F1: { unit_id: "F1", status: "pending", rework_count: 1 } },
  };
  const input = join(dir, "triage_resolution.json");
  const result = join(dir, "old-result.json");
  await writeFile(input, '{"items":[{"unit_id":"F1","action":"retry"}]}');
  await writeFile(result, "old-result");
  const answer = (await readDecisionSnapshot(input))!;
  const oldResult = (await readDecisionSnapshot(result))!;
  const receipt: DecisionApplicationReceipt = {
    input: "triage_resolution.json", input_sha256: answer.sha256, input_identity_sha256: answer.identity_sha256,
    context_sha256: decisionContextDigest(state), run_id: state.plan!.plan_id,
    revision_sha256: state.plan!.review_revision_sha256, applied_at: new Date().toISOString(),
    retry_results: [{ path: "old-result.json", sha256: oldResult.sha256, identity_sha256: oldResult.identity_sha256 }],
    outcome: { resolved_at: new Date().toISOString(), items: [{ unit_id: "F1", action: "retried" }] },
  };
  state.decision_applications = [receipt];
  return { state, input, result, receipt };
}

describe("postcommit decision cleanup snapshots", () => {
  it.each(["answer", "result"])("preserves a replacement %s arriving immediately before staging", async subject => {
    const { state, input, result } = await fixture();
    const target = subject === "answer" ? input : result;
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let swapped = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (from === target && !swapped) { swapped = true; await writeFile(target, "replacement-evidence"); }
      return actual.rename(from, to);
    });
    await reconcileDecisionCleanup(state, dir);
    expect(swapped).toBe(true);
    expect(await readFile(target, "utf8")).toBe("replacement-evidence");
    expect(state.decision_applications![0]!.cleanup_complete).toBe(true);
  });

  it("recovers staged cleanup after a crash and preserves a newer live answer", async () => {
    const { state, input } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let interrupted = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to);
      if (from === input && !interrupted) { interrupted = true; throw new Error("crash after staging"); }
    });
    await expect(reconcileDecisionCleanup(state, dir)).rejects.toThrow("pending cleanup");
    await writeFile(input, "new-owner-answer");
    vi.mocked(rename).mockImplementation(actual.rename);
    await reconcileDecisionCleanup(state, dir);
    await reconcileDecisionCleanup(state, dir);
    expect(await readFile(input, "utf8")).toBe("new-owner-answer");
    expect(state.items!.F1!.rework_count).toBe(1);
    expect(JSON.parse(await readFile(join(dir, "triage-outcome.json"), "utf8")).items).toEqual([{ unit_id: "F1", action: "retried" }]);
  });

  it("recovers completed-receipt staging after restart without a live input", async () => {
    const { state, input, receipt } = await fixture();
    await reconcileDecisionCleanup(state, dir);
    const consumed = `${input}.consumed-${receipt.context_sha256}-${receipt.input_identity_sha256}`;
    await rename(consumed, input);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let interrupted = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      await actual.rename(from, to);
      if (from === input && !interrupted) { interrupted = true; throw new Error("crash during completed-receipt staging"); }
    });
    await expect(reconcileDecisionCleanup(state, dir)).rejects.toThrow("pending cleanup");
    await expect(readFile(input)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(dir, "state.json"), JSON.stringify(state));
    const restarted = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as RemediationState;
    vi.mocked(rename).mockImplementation(actual.rename);
    await reconcileDecisionCleanup(restarted, dir);
    const files = await actual.readdir(dir);
    expect(files.some(name => name.endsWith(".pending-cleanup"))).toBe(false);
    expect(restarted.items!.F1!.rework_count).toBe(1);
  });

  it("completed receipts do not consume a fresh byte-identical decision", async () => {
    const { state, input } = await fixture();
    const bytes = await readFile(input);
    await reconcileDecisionCleanup(state, dir);
    await writeFile(input, bytes);
    await reconcileDecisionCleanup(state, dir);
    expect(await readFile(input)).toEqual(bytes);
  });
});
