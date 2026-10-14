import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileDisposition } from "audit-tools/shared";
import { scratchDir } from "../helpers/scratch.js";
import { buildDocsDigest } from "../../src/audit/extractors/docsDigest.js";
import { deriveCommentDecomposition, deriveDocGroups } from "../../src/audit/extractors/commentDecomposition.js";
import { DEFAULT_MAX_BYTES } from "../../src/audit/extractors/readFileText.js";

const root = scratchDir("bounded-reader-integration");
const codeFiles = ["alphaWidget.ts", "betaWidget.ts"];
const files = {
  "README.md": "\ufeff# Widgets\r\n\r\nalphaWidget.ts and betaWidget.ts belong together.\n",
  "alphaWidget.ts": "// See betaWidget.ts\nexport const a = 1;\n",
  "betaWidget.ts": "export const b = 2;\n",
};
const disposition = { files: [{ path: "README.md", status: "included" }] } as FileDisposition;
const injected = async (path: string) => files[path.slice(root.length + 1) as keyof typeof files];
beforeEach(async () => { await mkdir(root, { recursive: true }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("default readers preserve valid digest/comment/group output", async () => {
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const actual = await buildDocsDigest({ root, disposition });
  const expected = await buildDocsDigest({ root, disposition, readFileText: injected });
  expect({ ...actual, generated_at: "normalized" }).toEqual({ ...expected, generated_at: "normalized" });
  expect(actual.docs[0].title).toBe("Widgets");
  const comments = await deriveCommentDecomposition({ root, files: codeFiles });
  expect(comments).toEqual(await deriveCommentDecomposition({ root, files: codeFiles, readFileText: injected }));
  expect(comments.scannedFiles).toBe(2);
  expect(comments.edges).toHaveLength(1);
  const groups = await deriveDocGroups({ root, docFiles: ["README.md"], codeFiles });
  expect(groups).toEqual(await deriveDocGroups({ root, docFiles: ["README.md"], codeFiles, readFileText: injected }));
  expect(groups).toEqual([codeFiles]);
});

test("oversized default-reader documents and comments contribute no evidence", async () => {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content + " ".repeat(DEFAULT_MAX_BYTES + 1 - Buffer.byteLength(content)));
  }
  const digest = await buildDocsDigest({ root, disposition });
  expect(digest.docs).toEqual([]);
  expect(digest.omitted_paths).toBeUndefined();
  expect(await deriveCommentDecomposition({ root, files: codeFiles })).toEqual({ edges: [], scannedFiles: 0 });
  expect(await deriveDocGroups({ root, docFiles: ["README.md"], codeFiles })).toEqual([]);
});

test("injected readers bypass the default-reader byte policy", async () => {
  expect(await deriveCommentDecomposition({ root, files: codeFiles, readFileText: injected, maxBytes: 0 }))
    .toEqual(await deriveCommentDecomposition({ root, files: codeFiles, readFileText: injected }));
  expect(await deriveDocGroups({ root, docFiles: ["README.md"], codeFiles, readFileText: injected, maxBytes: 0 }))
    .toEqual([codeFiles]);
  const digest = await buildDocsDigest({ root, disposition, readFileText: async () => "# Injected\n" + "x".repeat(DEFAULT_MAX_BYTES + 1) });
  expect(digest.docs[0].title).toBe("Injected");
});
