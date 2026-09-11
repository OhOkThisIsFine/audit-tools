import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitAvailable, submoduleRepo } from "./helpers/submoduleRepo.mjs";

const { buildFileDisposition } = await import("../../src/audit/extractors/disposition.js");
const { enumerateTrackedFilePaths } = await import(
  "../../src/shared/validation/findingGrounding.js"
);

/**
 * `--recurse-submodules` is ONE atomic pair: the audit disposition's untracked
 * rule and the citation-grounding corpus must agree about what "tracked" means,
 * or a finding grounds against a file the disposition excluded from scope.
 *
 * Both sides read the one git enumeration. A parent-only `ls-files` lists just
 * the gitlink for a first-party submodule (`sub`), so every file INSIDE one
 * looks absent from the index — i.e. untracked, i.e. excludable scope litter —
 * while a citation naming it would be read as ungrounded (or, before the pair
 * was aligned, grounded while out of scope). Either half alone is a silent
 * scope change for a repo with first-party submodules.
 *
 * This is a BEHAVIOURAL test against a real submodule, not a source-text grep:
 * the failure mode is the git invocation's flag, so only a real index can
 * distinguish the two. Skipped (with the reason stated) when `git` cannot be
 * run at all — the same clean-fallback posture both call sites take.
 */

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

maybe("the tracked corpus recurses into first-party submodules (one atomic pair)", () => {
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
    // The gitlink itself is tracked too, so it is not litter either.
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
