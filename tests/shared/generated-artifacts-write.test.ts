import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { runGeneratedArtifactCli } from "../../scripts/shared/generatedArtifacts.mjs";

const rename = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  renameSync: rename,
}));

test("a failed publish preserves the old generated page and cleans staging", () => {
  const root = mkdtempSync(join(tmpdir(), "generated-artifact-write-"));
  try {
    const file = join(root, "page.md");
    writeFileSync(file, "handwritten plus old block\n");
    rename.mockImplementationOnce((temp: string, target: string) => {
      expect(target).toBe(file);
      expect(dirname(temp)).toBe(root);
      expect(readFileSync(temp, "utf8")).toBe("handwritten plus updated block\n");
      expect(readFileSync(file, "utf8")).toBe("handwritten plus old block\n");
      throw new Error("injected replace failure");
    });
    expect(() => runGeneratedArtifactCli({
      repoRoot: root, files: [{ target: "page.md", next: "handwritten plus updated block\n" }],
      staleMessage: "", fixCommand: "", okMessage: "", argv: [],
    })).toThrow("injected replace failure");
    expect(readFileSync(file, "utf8")).toBe("handwritten plus old block\n");
    expect(readdirSync(root)).toEqual(["page.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unrecognized generator option cannot write the target", () => {
  const root = mkdtempSync(join(tmpdir(), "generated-artifact-option-"));
  try {
    const file = join(root, "page.md");
    writeFileSync(file, "original");
    expect(() => runGeneratedArtifactCli({
      repoRoot: root, files: [{ target: "page.md", next: "replacement" }],
      staleMessage: "", fixCommand: "", okMessage: "", argv: ["--chek"],
    })).toThrow(/--chek/);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readdirSync(root)).toEqual(["page.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
