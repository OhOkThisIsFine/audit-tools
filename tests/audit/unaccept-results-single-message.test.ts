// N2 (A2 re-review F6-2): the "unaccept-results requires --work-item … or
// --all" argument-validation message existed as TWO copies — one in the
// command, one in `dropAcceptedResults` — free to drift independently. The
// boundary is the validator; the command now parses argv only. Pins: (1) the
// refusal fires THROUGH the command path with the boundary's message, and
// (2) the statement exists exactly once in the source tree.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const REQUIREMENT = /requires --work-item <id> \(repeatable\) or --all/u;

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? listTypeScriptFiles(path)
        : entry.name.endsWith(".ts")
          ? [path]
          : [];
    }),
  );
  return files.flat();
}

describe("contract:unaccept-results-argument-rule-has-one-copy", () => {
  it("refuses a selector-less invocation through the command, with the boundary's message", async () => {
    const { cmdUnacceptResults } = await import(
      "../../src/audit/cli/unacceptResultsCommand.js"
    );
    const { materializeReviewRun } = await import(
      "../../src/audit/cli/reviewRun.js"
    );
    const root = await mkdtemp(join(tmpdir(), "audit-unaccept-nargs-"));
    cleanupRoots.push(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    // Materialize the review-run manifest so the command gets past run
    // resolution — the refusal under test must come from the ARGUMENT rule,
    // not from a missing-manifest error ahead of it.
    await materializeReviewRun({
      root,
      artifactsDir,
      bundle: {},
      obligationId: null,
    });

    await expect(
      cmdUnacceptResults(["--root", root, "--artifacts-dir", artifactsDir]),
    ).rejects.toThrow(REQUIREMENT);
  });

  it("states the requirement exactly once across the source tree", async () => {
    const srcDir = join(import.meta.dirname, "..", "..", "src");
    const holders: string[] = [];
    for (const file of await listTypeScriptFiles(srcDir)) {
      const text = await readFile(file, "utf8");
      if (REQUIREMENT.test(text)) holders.push(file);
    }
    expect(
      holders,
      "the unaccept-results argument rule must be stated in exactly one module",
    ).toHaveLength(1);
    expect(holders[0]).toMatch(/hostHandoff\.ts$/u);
  });
});
