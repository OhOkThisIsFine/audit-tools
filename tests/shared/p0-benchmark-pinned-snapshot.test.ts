import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { parse as parseYaml } from "yaml";
import { materializePinnedPrimary, removePinnedPrimary } from "../../benchmarks/p0/runner.mjs";

function git(cwd: string, ...args: string[]) {
  return spawnSyncHidden("git", args, { cwd, encoding: "utf8" });
}

describe("P0 pinned primary snapshot", () => {
  test("checks out the requested commit instead of copying the dirty source", async () => {
    const repo = mkdtempSync(join(tmpdir(), "p0-source-"));
    const destination = join(mkdtempSync(join(tmpdir(), "p0-destination-")), "checkout");
    try {
      writeFileSync(join(repo, "tracked.txt"), "pinned");
      for (const args of [["init"], ["config", "user.email", "p0@test.invalid"], ["config", "user.name", "P0 Test"], ["add", "tracked.txt"], ["commit", "-m", "fixture"]]) {
        expect(git(repo, ...args).status).toBe(0);
      }
      const sha = git(repo, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(repo, "tracked.txt"), "dirty");

      await materializePinnedPrimary({ repoRoot: repo, commit: sha, destination });
      expect(git(destination, "rev-parse", "HEAD").stdout.trim()).toBe(sha);
      expect(readFileSync(join(destination, "tracked.txt"), "utf8")).toBe("pinned");
      expect(git(destination, "status", "--porcelain").stdout.trim()).toBe("");
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("dirty");
      await expect(materializePinnedPrimary({ repoRoot: repo, commit: "0".repeat(40), destination: `${destination}-missing` })).rejects.toThrow();
    } finally {
      await removePinnedPrimary?.({ repoRoot: repo, destination }).catch(() => undefined);
      rmSync(repo, { recursive: true, force: true });
      rmSync(resolve(destination, ".."), { recursive: true, force: true });
    }
  });

  test("primary execution path uses pinned materialization", () => {
    const source = readFileSync(resolve("benchmarks/p0/runner.mjs"), "utf8");
    expect((source.match(/materializePinnedPrimary/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).not.toMatch(/request\.snapshot\s*===\s*["']held-out["'][\s\S]{0,300}process\.cwd\(\)[\s\S]{0,300}cpSync/);
  });

  test("CI suite-running jobs fetch full history for pinned benchmark commits", () => {
    let found = 0;
    for (const workflowPath of [".github/workflows/audit-code-test-suite.yml", ".github/workflows/publish-package.yml"]) {
      const workflow = parseYaml(readFileSync(resolve(workflowPath), "utf8"));
      for (const job of Object.values(workflow.jobs ?? {}) as Array<{ steps?: Array<Record<string, unknown>> }>) {
        const steps = job.steps ?? [];
        if (!steps.some((step) => typeof step.run === "string" && step.run.includes("run-vitest-gate.mjs"))) continue;
        found += 1;
        const checkout = steps.find((step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"));
        expect(checkout).toBeDefined();
        const depth = (checkout?.with as Record<string, unknown> | undefined)?.["fetch-depth"];
        expect(depth === 0 || depth === "0").toBe(true);
      }
    }
    expect(found).toBeGreaterThanOrEqual(2);
  });
});
