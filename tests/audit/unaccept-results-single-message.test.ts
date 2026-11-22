import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { runCli } from "../../src/audit/cli.js";
import { captureConsole } from "./helpers/captureConsole.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each([false, true])("retired input commands leave archived or current question review unchanged: %s", async hasQuestionState => {
  const root = await mkdtemp(join(tmpdir(), "audit-retired-review-"));
  roots.push(root);
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(artifactsDir, { recursive: true });
  const state = hasQuestionState ? "review_plan.json" : "audit_tasks.json";
  const sentinel = "original bytes; not an invitation to parse or rewrite";
  await writeFile(join(artifactsDir, state), sentinel);
  const base = ["--root", root, "--artifacts-dir", artifactsDir];
  for (const args of [
    ["ingest-results", "--results", state],
    ["ingest-results", "--batch-results", artifactsDir],
    ["unaccept-results", "--all", "--run-id", "old-run"],
    ["plan", "--results", state],
    ["next-step", "--batch-results", artifactsDir],
    ["synthesize", "--updates", state],
  ]) {
    const result = await captureConsole(() => runCli([process.execPath, "cli.js", args[0]!, ...base, ...args.slice(1)]));
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown command|unsupported argument/iu);
  }
  expect(await readdir(artifactsDir)).toEqual([state]);
  expect(await readFile(join(artifactsDir, state), "utf8")).toBe(sentinel);
});
