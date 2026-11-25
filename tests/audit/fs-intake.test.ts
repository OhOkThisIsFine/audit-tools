import { test, onTestFinished, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = vi.hoisted(() => ({ unreadableDirectory: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      if (args[0] === failures.unreadableDirectory) throw Object.assign(new Error("synthetic denied read"), { code: "EACCES" });
      return await fs.readdir(...args);
    },
  };
});

const { buildRepoManifestFromFs } = await import("../../src/audit/extractors/fsIntake.js");

async function withTempRepo<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "audit-code-fs-intake-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("walk hashes oversized files without a skip warning", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "small.js"), "console.log('small');\n");
    await writeFile(join(root, "large.js"), "x".repeat(200));

    const warnings: string[] = [];
    const originalWarn = console.warn;
    onTestFinished(() => {
      console.warn = originalWarn;
    });
    console.warn = (...args) => warnings.push(args.join(" "));

    const manifest = await buildRepoManifestFromFs({
      root,
      max_file_size_bytes: 100,
      hash_files: true,
    });

    // The oversized file is still in the manifest
    const largeEntry = manifest.files.find((f) => f.path.includes("large.js"));
    expect(largeEntry, "oversized file should still be inventoried").toBeTruthy();
    expect(largeEntry!.hash, "oversized file should have a content hash").toMatch(/^[a-f0-9]{64}$/);

    // The small file is hashed normally
    const smallEntry = manifest.files.find((f) => f.path.includes("small.js"));
    expect(smallEntry, "small file should be inventoried").toBeTruthy();
    expect(smallEntry!.hash, "small file should have a hash").toBeTruthy();

    expect(warnings, "streamed files should not produce skip warnings").toEqual([]);
  });
});

test("walk logs a warning and continues when readdir throws", async () => {
  await withTempRepo(async (root) => {
    // Create a normal file at root level and a subdirectory
    await writeFile(join(root, "ok.js"), "export const x = 1;\n");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "nested.js"), "export const y = 2;\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    onTestFinished(() => {
      console.warn = originalWarn;
    });
    console.warn = (...args) => warnings.push(args.join(" "));

    const unreadable = join(root, "sub");
    failures.unreadableDirectory = unreadable;
    onTestFinished(() => { failures.unreadableDirectory = ""; });
    const manifest = await buildRepoManifestFromFs({ root });

    expect(manifest.files.map(file => file.path)).toEqual(["ok.js"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`skipping unreadable directory: ${unreadable} (synthetic denied read)`);
  });
});

test("walk inventories readable files without warnings", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "file-a.js"), "export const a = 1;\n");
    await writeFile(join(root, "file-b.js"), "export const b = 2;\n");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    onTestFinished(() => {
      console.warn = originalWarn;
    });
    console.warn = (...args) => warnings.push(args.join(" "));

    // Verify that a normal walk (no stat failures) produces all files without warnings.
    const manifest = await buildRepoManifestFromFs({ root });

    const entryA = manifest.files.find((f) => f.path.includes("file-a.js"));
    const entryB = manifest.files.find((f) => f.path.includes("file-b.js"));
    expect(entryA, "file-a.js should be in results").toBeTruthy();
    expect(entryB, "file-b.js should be in results").toBeTruthy();

    expect(warnings.filter((w) => w.includes("skipping unreadable file")).length, "no unreadable-file warnings expected for a clean walk").toBe(0);
  });
});


test("same-size changes above 1 MiB invalidate content identity and integrity", async () => {
  const { checkFileIntegrity } = await import("../../src/audit/orchestrator/fileIntegrity.js");
  await withTempRepo(async (root) => {
    const path = join(root, "large.ts");
    const size = 1024 * 1024 + 1;
    await writeFile(path, "a".repeat(size));
    const before = await buildRepoManifestFromFs({ root, hash_files: true });
    await writeFile(path, "b".repeat(size));
    const after = await buildRepoManifestFromFs({ root, hash_files: true });
    expect(before.files[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(after.files[0].hash).not.toBe(before.files[0].hash);
    const integrity = await checkFileIntegrity(root, before);
    expect(integrity.changed_files).toEqual(["large.ts"]);
    expect(integrity.is_clean).toBe(false);
  });
});


test("intake binds raw bytes while normalizing CRLF in text, in buffered and streaming modes", async () => {
  await withTempRepo(async root => {
    const lf = "export const value = 1;\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    await writeFile(join(root, "lf.ts"), lf);
    await writeFile(join(root, "crlf.ts"), crlf);
    await writeFile(join(root, "binary.png"), crlf);
    for (const max_file_size_bytes of [1, 1024]) {
      const manifest = await buildRepoManifestFromFs({ root, hash_files: true, max_file_size_bytes });
      const byPath = new Map(manifest.files.map(file => [file.path, file]));
      expect(byPath.get("lf.ts")?.hash).toBe(byPath.get("crlf.ts")?.normalized_hash);
      expect(byPath.get("lf.ts")?.hash).not.toBe(byPath.get("crlf.ts")?.hash);
      expect(byPath.get("binary.png")?.normalized_hash).toBeUndefined();
    }
  });
});
