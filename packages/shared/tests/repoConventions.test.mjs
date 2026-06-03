import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { detectRepoConventions, formatRepoConventions } = await import(
  "../src/tooling/repoConventions.ts"
);

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "repo-conventions-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detects node conventions: prettier, eslint, vitest, esm", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        type: "module",
        devDependencies: { prettier: "^3", eslint: "^9", vitest: "^2" },
      }),
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "index.ts"),
      "export function hello() {\n  return 'hi';\n}\n",
    );

    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.formatter, "prettier");
    assert.equal(conventions.linter, "eslint");
    assert.equal(conventions.test_framework, "vitest");
    assert.equal(conventions.module_style, "esm");
    assert.equal(conventions.indentation, "2 spaces");
    assert.equal(conventions.quote_style, "single");
    assert.ok(conventions.sample_snippet?.includes("export function hello"));

    const block = formatRepoConventions(conventions);
    assert.match(block, /match the surrounding code/);
    assert.match(block, /Formatter: prettier/);
  });
});

test("detects commonjs module style without type:module", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.module_style, "commonjs");
  });
});

test("detects python conventions: black, ruff, pytest", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "pyproject.toml"),
      [
        "[tool.black]",
        "line-length = 88",
        "",
        "[tool.ruff]",
        "select = ['E']",
        "",
        "[tool.pytest.ini_options]",
        "testpaths = ['tests']",
      ].join("\n"),
    );
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.py"), "def hello():\n    return 1\n");

    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.formatter, "black");
    assert.equal(conventions.linter, "ruff");
    assert.equal(conventions.test_framework, "pytest");
    assert.equal(conventions.indentation, "4 spaces");
  });
});

test("returns an empty object and empty block for a bare directory", async () => {
  await withTempDir(async (dir) => {
    const conventions = detectRepoConventions(dir);
    assert.deepEqual(conventions, {});
    assert.equal(formatRepoConventions(conventions), "");
  });
});
