import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { loadRemediateSessionConfig } = await import(
  "../../src/remediate/steps/sessionConfigLoad.js"
);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "remediate-intent-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeCanonical(value: unknown): Promise<void> {
  const directory = join(root, ".audit-tools", "audit");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "session-config.json"),
    JSON.stringify(value),
    "utf8",
  );
}

describe("loadRemediateSessionConfig", () => {
  test("absence returns the fixed provider-neutral defaults", async () => {
    await expect(loadRemediateSessionConfig({ root })).resolves.toEqual({
      status: "not_configured",
      intent: { review_mode: "attended", observability: "standard" },
    });
  });

  test("loads only the canonical intent path", async () => {
    await writeCanonical({ review_mode: "autonomous" });
    await writeFile(
      join(root, "session-config.json"),
      JSON.stringify({ review_mode: "attended" }),
      "utf8",
    );

    await expect(loadRemediateSessionConfig({ root })).resolves.toEqual({
      status: "configured",
      intent: { review_mode: "autonomous", observability: "standard" },
    });
  });

  test("a present invalid intent fails closed with the canonical path", async () => {
    await writeCanonical({ provider: "codex" });
    await expect(loadRemediateSessionConfig({ root })).rejects.toThrow(
      /\.audit-tools[\\/]audit[\\/]session-config\.json/i,
    );
  });
});
