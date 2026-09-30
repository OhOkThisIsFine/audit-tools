import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { discoverRepoRoot } from "../../wrapper/repo-root.mjs";
import { runEnsurePhase, withTempRepo } from "../../scripts/audit/smoke-audit-flow.mjs";
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import { runWrapper } from "./helpers/wrapper-harness.js";

test("the real smoke fixture owns its repository root even under another repository", async () => {
  await withTempRepo("audit-smoke-root-", async (root: string) => {
    // An ambient parent marker must not redirect ensure away from this fixture.
    // This marker is inside the helper-owned temporary tree, never the real /tmp.
    await mkdir(join(dirname(root), ".git"));
    expect(discoverRepoRoot(root)).toBe(root);
    expect(execFileSyncHidden("git", ["-C", root, "ls-files"], { encoding: "utf8" })
      .trim().split(/\r?\n/u)).toEqual([
      "infra/deploy.yml", "package.json", "src/api/auth.ts", "src/lib/session.ts",
    ]);
    await runEnsurePhase({
      root,
      auditCodeCommand: "audit-code",
      runCommand: async (_command: string, args: string[], options: { cwd?: string }) =>
        runWrapper(args, { cwd: options.cwd }),
      log: { step() {}, elapsed() {} },
    });
  });
}, HEAVY_AUDIT_TEST_TIMEOUT_MS);
