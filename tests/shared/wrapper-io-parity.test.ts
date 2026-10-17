import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as audit from "../../wrapper/audit-code-wrapper-io.mjs";
import * as remediate from "../../wrapper/remediate-code-wrapper-io.mjs";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wrapper-io-parity-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const commonExports = ["fileExists", "newestMtimeMs", "readJson", "readTextIfExists", "writeGeneratedJson", "writeGeneratedMarkdown", "writeManagedMarkdown", "writeMergedGeneratedJson"];
const facades = [{ name: "audit", io: audit }, { name: "remediate", io: remediate }];

describe.each(facades)("$name wrapper IO", ({ name, io }) => {
  const start = `<!-- ${name}-code:begin -->`;
  const end = `<!-- ${name}-code:end -->`;
  const block = `${start}\nnew café\n${end}`;
  const oldBlock = `${start}\nold\n${end}`;

  it("preserves its named export surface", () => {
    const extras = name === "audit" ? ["writeGeneratedBinary"] : ["INSTALL_MARKER_START", "INSTALL_MARKER_END"];
    expect(Object.keys(io).sort()).toEqual([...commonExports, ...extras].sort());
    expect(remediate.INSTALL_MARKER_START).toBe("<!-- remediate-code:begin -->");
    expect(remediate.INSTALL_MARKER_END).toBe("<!-- remediate-code:end -->");
  });

  it("preserves missing-file and read/parse catch boundaries", async () => {
    const root = await fixture();
    const path = join(root, "missing.json");
    expect(await io.fileExists(path)).toBe(false);
    expect(await io.fileExists(root)).toBe(true);
    expect(await io.readTextIfExists(path)).toBeNull();
    await expect(io.readJson(path, "config")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(io.newestMtimeMs(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "{bad");
    await expect(io.readJson(path, "config")).rejects.toThrow(/^config is not valid JSON: /);
    await writeFile(path, '"café"');
    expect(await io.readJson(path, "config")).toBe("café");
    expect(await io.readTextIfExists(path)).toBe('"café"');
  });

  it("writes exact text and JSON bytes with created/updated receipts", async () => {
    const root = await fixture();
    const path = join(root, "nested", "generated");
    for (const [index, text] of ["café\r\nraw", ""].entries()) {
      expect(await io.writeGeneratedMarkdown(path, text)).toEqual({ path, mode: index ? "updated" : "created" });
      expect(await readFile(path, "utf8")).toBe(text);
    }
    const jsonPath = join(root, "json", "config.json");
    for (const [index, value] of [{ z: "é", a: [1, null] }, { next: true }].entries()) {
      expect(await io.writeGeneratedJson(jsonPath, value)).toEqual({ path: jsonPath, mode: index ? "updated" : "created" });
      expect(await readFile(jsonPath, "utf8")).toBe(JSON.stringify(value, null, 2) + "\n");
    }
  });

  it.each(["{bad", "null", "[]", '"text"', "1", "false"])("refuses existing invalid object %s without overwrite or callback", async (text) => {
    const path = join(await fixture(), "config.json");
    await writeFile(path, text);
    let calls = 0;
    const promise = io.writeMergedGeneratedJson(path, "config", () => { calls++; return {}; });
    await expect(promise).rejects.toThrow(text === "{bad" ? /^config exists but is not valid JSON: / : "config must be a JSON object when it already exists.");
    expect(calls).toBe(0);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("merges once, preserving unrelated keys, insertion order, and receipts", async () => {
    const path = join(await fixture(), "nested", "config.json");
    let calls = 0;
    expect(await io.writeMergedGeneratedJson(path, "config", (existing: Record<string, unknown>) => {
      calls++; expect(existing).toEqual({}); return { unrelated: { keep: true }, managed: "old", last: 3 };
    })).toEqual({ path, mode: "created" });
    expect(await io.writeMergedGeneratedJson(path, "config", (existing: Record<string, unknown>) => {
      calls++; return { ...existing, managed: "new" };
    })).toEqual({ path, mode: "updated" });
    expect(calls).toBe(2);
    expect(await readFile(path, "utf8")).toBe('{\n  "unrelated": {\n    "keep": true\n  },\n  "managed": "new",\n  "last": 3\n}\n');
  });

  it("keeps mkdir before buildValue and serialization before write", async () => {
    const root = await fixture();
    const parent = join(root, "nested");
    const path = join(parent, "config.json");
    const error = new Error("callback failure");
    await expect(io.writeMergedGeneratedJson(path, "config", () => { throw error; })).rejects.toBe(error);
    expect((await stat(parent)).isDirectory()).toBe(true);
    expect(await io.fileExists(path)).toBe(false);
    await writeFile(path, '{"keep":true}');
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    await expect(io.writeMergedGeneratedJson(path, "config", () => cycle)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe('{"keep":true}');
  });

  it("finds recursive newest mtime including directories", async () => {
    const root = await fixture();
    const dir = join(root, "nested");
    const file = join(dir, "file");
    await mkdir(dir); await writeFile(file, "x");
    await utimes(root, 100, 100); await utimes(dir, 200, 200); await utimes(file, 300, 300);
    expect(await io.newestMtimeMs(file)).toBe((await stat(file)).mtimeMs);
    expect(await io.newestMtimeMs(root)).toBe((await stat(file)).mtimeMs);
    await utimes(dir, 400, 400);
    expect(await io.newestMtimeMs(root)).toBe((await stat(dir)).mtimeMs);
  });

  it.skipIf(process.platform === "win32")("preserves root symlink following and child symlink exclusion", async () => {
    const root = await fixture();
    const tree = join(root, "tree"); const target = join(root, "target");
    await mkdir(tree); await writeFile(target, "before");
    const link = join(tree, "link"); await symlink(target, link);
    await utimes(target, 500, 500); await utimes(tree, 100, 100);
    expect(await io.newestMtimeMs(tree)).toBe((await stat(tree)).mtimeMs);
    expect(await io.newestMtimeMs(link)).toBe((await stat(target)).mtimeMs);
    expect(await io.writeGeneratedMarkdown(link, "after")).toEqual({ path: link, mode: "updated" });
    expect(await readFile(target, "utf8")).toBe("after");
  });

  it.each([
    ["missing", undefined, (b: string) => `${b}\n`],
    ["empty", "", (b: string) => `${b}\n`],
    ["whitespace", " \r\n\t", (b: string) => `${b}\n`],
    ["append", "intro\r\n\r\n", (b: string) => `intro\n\n${b}\n`],
    ["replace", `intro\r\n${oldBlock.replace(/\n/g, "\r\n")}\r\ntail`, (b: string) => `intro\n${b}\ntail`],
  ] as const)("manages %s Markdown and remains idempotent", async (_label, existing, expected) => {
    const path = join(await fixture(), "nested", "AGENTS.md");
    if (existing !== undefined) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, existing); }
    expect(await io.writeManagedMarkdown(path, block)).toEqual({ path, mode: existing === undefined ? "created" : "updated" });
    expect(await readFile(path, "utf8")).toBe(expected(block));
    expect(await io.writeManagedMarkdown(path, block)).toEqual({ path, mode: "updated" });
    expect(await readFile(path, "utf8")).toBe(expected(block));
  });

  it("retains replacement-string dollar semantics and only replaces the first matching block", async () => {
    const path = join(await fixture(), "AGENTS.md");
    const before = `intro\n${oldBlock}\n${oldBlock}\ntail`;
    const replacement = `${start}\n$$ $& $\` $'\n${end}`;
    await writeFile(path, before);
    await io.writeManagedMarkdown(path, replacement);
    expect(await readFile(path, "utf8")).toBe(before.replace(new RegExp(`${start}[\\s\\S]*?${end}`, "u"), replacement));
  });
});

it("keeps both products' managed blocks together in one AGENTS.md", async () => {
  const path = join(await fixture(), "AGENTS.md");
  const blocks = ["audit", "remediate"].map((name) => `<!-- ${name}-code:begin -->\n${name}\n<!-- ${name}-code:end -->`);
  await audit.writeManagedMarkdown(path, blocks[0]);
  await remediate.writeManagedMarkdown(path, blocks[1]);
  const expected = `${blocks[0]}\n\n${blocks[1]}\n`;
  expect(await readFile(path, "utf8")).toBe(expected);
  await audit.writeManagedMarkdown(path, blocks[0]); await remediate.writeManagedMarkdown(path, blocks[1]);
  expect(await readFile(path, "utf8")).toBe(expected);
});

it("keeps binary writes audit-only and byte exact", async () => {
  const path = join(await fixture(), "nested", "binary");
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  expect(await audit.writeGeneratedBinary(path, bytes)).toEqual({ path, mode: "created" });
  expect(await audit.writeGeneratedBinary(path, bytes)).toEqual({ path, mode: "updated" });
  expect(await readFile(path)).toEqual(bytes);
});
