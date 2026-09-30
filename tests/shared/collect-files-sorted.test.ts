import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectFilesSorted } from "../../src/shared/io/collectFilesSorted.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "audit-walk-"));
  roots.push(root);
  await mkdir(join(root, "z"));
  await writeFile(join(root, "z", "last.txt"), "last");
  await writeFile(join(root, "a.txt"), "first");
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("stable traversal preserves names and distinguishes missing-entry policy", async () => {
  const root = await fixture();
  expect(await collectFilesSorted(root)).toEqual([join(root, "a.txt"), join(root, "z", "last.txt")]);
  const missing = join(root, "missing");
  expect(await collectFilesSorted(missing, { onMissing: path => [`missing:${path}`] })).toEqual([`missing:${missing}`]);
  expect(await collectFilesSorted(missing, { onMissing: () => [] })).toEqual([]);
  await expect(collectFilesSorted(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(process.platform === "win32")("root links follow; descendant link policy and independent aliases remain distinct", async () => {
  const root = await fixture();
  const alias = root + "-alias";
  roots.push(alias);
  await symlink(root, alias, "dir");
  await symlink(join(root, "z"), join(root, "b-link"), "dir");
  await symlink(join(root, "z"), join(root, "c-link"), "dir");
  expect(await collectFilesSorted(alias)).toEqual([join(alias, "a.txt"), join(alias, "b-link"), join(alias, "c-link"), join(alias, "z", "last.txt")]);
  expect(await collectFilesSorted(root, { followSymlinks: true })).toEqual([join(root, "a.txt"), join(root, "b-link", "last.txt"), join(root, "c-link", "last.txt"), join(root, "z", "last.txt")]);
});

test.skipIf(process.platform === "win32")("a followed ancestor cycle refuses without dropping ordinary sibling aliases", async () => {
  const root = await fixture();
  await symlink(root, join(root, "z", "back"), "dir");
  await expect(collectFilesSorted(root, { followSymlinks: true })).rejects.toThrow(/symlink cycle/);
  expect(await collectFilesSorted(root)).toContain(join(root, "z", "back"));
});
