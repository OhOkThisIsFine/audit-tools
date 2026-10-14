import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileHidden } from "../helpers/spawn.mjs";
import { hashContent, normalizeRepoPath, readRecursiveTrackedPaths } from "audit-tools/shared";
import { probeScopeIndexKey, probeScopeIndexKeyCached } from "../../src/audit/orchestrator/scopeIndexBaseline.js";
import type { ScopeIndexMemo } from "../../src/audit/orchestrator/scopeIndexBaseline.js";
import { git, gitAvailable, submoduleRepo } from "./helpers/submoduleRepo.mjs";

const { buildFileDisposition } = await import("../../src/audit/extractors/disposition.js");
const { enumerateTrackedFilePaths } = await import(
  "../../src/shared/validation/findingGrounding.js"
);

/** Real-index coverage for the shared authority and its domain adapters. */

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) {
    await disposers.pop()!();
  }
});

/** The real-submodule fixture, disposed in `afterEach`. */
async function makeSubmoduleRepo(): Promise<string> {
  const fixture = await submoduleRepo();
  disposers.push(fixture.dispose);
  return fixture.root;
}

const hasGit = await gitAvailable();
const maybe = hasGit ? describe : describe.skip;

maybe("the tracked corpus recurses into first-party submodules (one shared authority)", () => {
  it("grounding enumerates paths INSIDE a first-party submodule", async () => {
    const root = await makeSubmoduleRepo();
    const tracked = await enumerateTrackedFilePaths(root);
    expect([...tracked]).toContain("sub/a.ts");
  });

  it("the disposition does NOT exclude a submodule file as untracked", async () => {
    const root = await makeSubmoduleRepo();
    const disposition = await buildFileDisposition(
      {
        repository: { name: "submodule-fixture" },
        generated_at: "2026-09-10T00:00:00.000Z",
        files: [
          { path: "b.ts", language: "typescript", size_bytes: 22 },
          { path: "sub/a.ts", language: "typescript", size_bytes: 21 },
        ],
      },
      { root },
    );

    const inner = disposition.files.find((file) => file.path === "sub/a.ts");
    // The rule must be APPLIED (not clean-fallback-skipped) — otherwise this
    // test would pass on a git failure and prove nothing.
    expect(disposition.untracked?.applied).toBe(true);
    expect(disposition.untracked?.ignored_count).toBe(0);
    expect(inner?.status).toBe("included");
    expect(disposition.files.find((file) => file.path === "b.ts")?.status).toBe("included");
  });

  it("an actually-untracked sibling is still excluded (the rule still bites)", async () => {
    const root = await makeSubmoduleRepo();
    await writeFile(join(root, "litter.ts"), "export const litter = 1;\n");
    const disposition = await buildFileDisposition(
      {
        repository: { name: "submodule-fixture" },
        generated_at: "2026-09-10T00:00:00.000Z",
        files: [
          { path: "b.ts", language: "typescript", size_bytes: 22 },
          { path: "sub/a.ts", language: "typescript", size_bytes: 21 },
          { path: "litter.ts", language: "typescript", size_bytes: 27 },
        ],
      },
      { root },
    );
    const litter = disposition.files.find((file) => file.path === "litter.ts");
    expect(litter?.status).not.toBe("included");
  });
});

maybe("recursive corpus parity across all three adapters", () => {
  for (const state of ["populated", "nested", "uninitialized"] as const) {
    it(`matches the actual recursive command for ${state} submodules`, async () => {
      const root = await makeSubmoduleRepo();
      if (state === "nested") {
        const sub = join(root, "sub");
        await git(sub, ["config", "user.email", "t@example.invalid"]);
        await git(sub, ["config", "user.name", "t"]);
        await git(sub, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", join(root, "..", "inner"), "nested"]);
        await git(sub, ["commit", "-qm", "nested submodule"]);
        await git(root, ["add", "sub"]);
        await git(root, ["commit", "-qm", "update submodule"]);
      }
      if (state === "uninitialized") await git(root, ["submodule", "deinit", "-f", "--", "sub"]);
      // The wrapper has no Node execFile custom-promisify hook. Capture the
      // callback's stdout explicitly rather than assuming a { stdout } result.
      const stdout = await new Promise<string>((resolve, reject) => {
        execFileHidden("git", ["ls-files", "-z", "--recurse-submodules"],
          { cwd: root, encoding: "utf8", windowsHide: true },
          (error, output) => error ? reject(error) : resolve(output));
      });
      expect(typeof stdout).toBe("string");
      expect(stdout.endsWith("\0")).toBe(true);
      const paths = stdout.split("\0").filter(Boolean);
      expect(paths).toContain("b.ts");
      if (state === "nested") expect(paths).toContain("sub/nested/a.ts");
      if (state === "populated") expect(paths).toContain("sub/a.ts");
      expect(await readRecursiveTrackedPaths(root)).toEqual({ ok: true, paths });
      expect([...await enumerateTrackedFilePaths(root)]).toEqual([...new Set(paths.map((p) => p.replace(/\\/g, "/")))]);
      const candidates = [...new Set([...paths.filter((p) => p.endsWith(".ts")), "sub/a.ts", "missing.ts"])];
      const tracked = new Set(paths.map(normalizeRepoPath));
      expect(await probeScopeIndexKey(root, candidates)).toBe(hashContent(candidates.map(normalizeRepoPath).filter((p) => tracked.has(p)).sort().join("\n")));
      const disposition = await buildFileDisposition({
        repository: { name: "recursive-parity" }, generated_at: "2026-10-14T00:00:00.000Z",
        files: candidates.map((path) => ({ path, language: "typescript", size_bytes: 10 })),
      }, { root });
      expect(disposition.untracked).toEqual({ applied: true, ignored_count: candidates.filter((p) => !tracked.has(normalizeRepoPath(p))).length });
      for (const file of disposition.files) {
        expect(file.status).toBe(tracked.has(normalizeRepoPath(file.path)) ? "included" : "excluded");
      }
    });
  }

  it("keeps a submodule index-only move stable within the memo and fresh next fold", async () => {
    const root = await makeSubmoduleRepo();
    const memo: ScopeIndexMemo = {};
    const candidates = ["b.ts", "sub/a.ts"];
    const before = await probeScopeIndexKeyCached(memo, root, candidates);
    expect(before).toBe(hashContent("b.ts\nsub/a.ts"));
    await git(join(root, "sub"), ["rm", "--cached", "a.ts"]);
    expect(await probeScopeIndexKeyCached(memo, root, candidates)).toBe(before);
    expect(await probeScopeIndexKeyCached({}, root, candidates)).toBe(hashContent("b.ts"));
  });
});
