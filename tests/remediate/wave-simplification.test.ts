import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2, REMEDIATION_HOST_SCOPE_SEMANTICS } from "../../src/remediate/state/types.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { bindWaveSimplification, completeWaveSimplification, pendingWaveSimplification, waveResponsePath } from "../../src/remediate/steps/waveSimplification.js";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";

for (const scenario of ["applied", "unrelated", "untested-owner", "merge-edit", "merge-clean"] as const) test("wave review preserves exact range: " + scenario, async () => {
  const root = await mkdtemp(join(tmpdir(), "remediation-wave-receipt-"));
  const artifactsDir = join(root, ".audit-tools");
  const git = (...args: string[]): string => {
    const result = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, String(result.stderr)).toBe(0);
    return String(result.stdout).trim();
  };
  const land = async (file: string, body: string) => {
    await writeFile(join(root, file), body);
    git("add", file);
    git("commit", "--no-gpg-sign", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  try {
    await mkdir(artifactsDir);
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "wave@example.invalid");
    await land(".gitignore", ".audit-tools/\n");
    const baseline = await land("check.cjs", "process.exit(require('node:fs').readFileSync('a.txt', 'utf8').includes('expected') ? 0 : 1);\n");
    const a = await land("a.txt", "original A\n");
    if (scenario === "merge-edit" || scenario === "merge-clean") git("checkout", "--detach", baseline);
    const b = await land("b.txt", "original B\n");
    if (scenario === "merge-edit" || scenario === "merge-clean") {
      git("checkout", "--detach", a);
      git("merge", "--no-gpg-sign", "--no-commit", "--no-ff", b);
      if (scenario === "merge-edit") await writeFile(join(root, "a.txt"), "different content in accepted file");
      git("add", "a.txt"); git("commit", "--no-gpg-sign", "-qm", "unverified merge edits");
    }
    const state: RemediationState = {
      status: "implementing", plan: canonicalPlanFixture({ units: [
        canonicalUnitFixture("A", { required_tests: [
          "node check.cjs",
        ] }),
        canonicalUnitFixture("B"),
      ] }),
      items: {
        A: { unit_id: "A", status: "resolved", host_landed_commit: a, host_landed_files: ["a.txt"] },
        B: { unit_id: "B", status: "resolved", host_landed_commit: b, host_landed_files: ["b.txt"] },
      },
      host_handoff: { contract_version: REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2, scope_semantics: REMEDIATION_HOST_SCOPE_SEMANTICS, run_id: "fixture", baseline_commit: baseline, workload_sha256: "9".repeat(64), work_item_ids: ["A", "B"] },
    };
    if (scenario === "unrelated") await land("outside.txt", "not reviewed\n");
    await bindWaveSimplification(root, state);
    const wave = pendingWaveSimplification(state)!;
    expect(wave.baseline).toBe(baseline);
    const response = waveResponsePath(artifactsDir, wave);
    const complete = () => completeWaveSimplification({ root, artifactsDir, state, wave });
    const respond = (disposition: string, commit?: string) => writeFile(response, JSON.stringify({
      receipt: wave.receipt, disposition, note: "Fixture disposition", ...(commit ? { commit } : {}),
    }));
    if (scenario === "unrelated" || scenario === "merge-edit") {
      expect(wave.problem).toMatch(scenario === "unrelated" ? /unrelated/ : /merged bytes/);
      expect(wave.files).toEqual([]);
      await respond("no_changes");
      expect(await complete()).toBe(wave.problem);
      await respond("unavailable");
      expect(await complete()).toBeUndefined();
      expect(wave.response?.disposition).toBe("unavailable");
    } else if (scenario === "untested-owner") {
      const untested = await land("b.txt", "simplified but no focused test\n");
      await respond("applied", untested);
      expect(await complete()).toMatch(/affected unit has no bound approved focused tests/);
      expect(pendingWaveSimplification(state)).toBe(wave);
      git("reset", "--hard", b);
      await respond("follow_up");
      expect(await complete()).toBeUndefined();
    } else {
      expect(wave.problem).toBeUndefined();
      expect(wave.files).toEqual(["a.txt", "b.txt"]);
      const retry = await land("a.txt", "wrong simplification\n");
      await respond("applied", retry);
      expect(await complete()).toMatch(/required focused test/);
      expect(pendingWaveSimplification(state)).toBe(wave);
      await writeFile(join(root, "a.txt"), "expected simplification\n");
      git("add", "a.txt"); git("commit", "--no-gpg-sign", "--amend", "-q", "--no-edit");
      const final = git("rev-parse", "HEAD");
      await respond("applied", final);
      expect(await complete()).toBeUndefined();
      expect(wave.response).toMatchObject({ disposition: "applied", commit: final });
      expect(wave.applied_files).toEqual(["a.txt"]);
    }
    expect(pendingWaveSimplification(state)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
