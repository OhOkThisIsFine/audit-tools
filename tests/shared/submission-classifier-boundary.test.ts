import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readSubmissionDocument } from "../../src/shared/submission/submissionClassifier.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readSource(source: string) {
  const root = await mkdtemp(join(tmpdir(), "submission-classifier-boundary-"));
  roots.push(root);
  const path = join(root, "submission.json");
  await writeFile(path, source, "utf8");
  return readSubmissionDocument(path);
}

describe("readSubmissionDocument encoding boundary", () => {
  it("accepts exactly one leading Unicode byte-order mark before valid JSON", async () => {
    await expect(readSource("\uFEFF{\"accepted\":true}"))
      .resolves.toEqual({ kind: "value", value: { accepted: true } });
  });

  it("retains the original leading marker bytes and escaped marker data", async () => {
    const source = "\uFEFF{\"text\":\"\\uFEFF\"}";
    const root = await mkdtemp(join(tmpdir(), "submission-classifier-bytes-"));
    roots.push(root);
    const path = join(root, "submission.json");
    await writeFile(path, source, "utf8");

    await expect(readSubmissionDocument(path)).resolves.toEqual({
      kind: "value",
      value: { text: "\uFEFF" },
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("rejects interior, repeated, or trailing byte-order marks instead of stripping them globally", async () => {
    await expect(readSource("\uFEFF\uFEFF{\"accepted\":true}"))
      .resolves.toMatchObject({ kind: "malformed" });
    await expect(readSource("{\"accepted\"\uFEFF:true}"))
      .resolves.toMatchObject({ kind: "malformed" });
    await expect(readSource("{\"accepted\":true}\uFEFF"))
      .resolves.toMatchObject({ kind: "malformed" });
  });

  it("still classifies genuinely malformed JSON as malformed", async () => {
    await expect(readSource("\uFEFF{not-json"))
      .resolves.toMatchObject({ kind: "malformed" });
  });
});
