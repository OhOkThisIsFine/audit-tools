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

test("detectStyleFromSnippet: more single-quotes resolves to quote_style single", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // More single-quotes: const x = 'hi'; // it's
    await writeFile(join(dir, "src", "index.ts"), "const x = 'hi'; // it's\n");
    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.quote_style, "single");
  });
});

test("detectStyleFromSnippet: more double-quotes resolves to quote_style double", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // More double-quotes: const x = "hi"; // say "hello"
    await writeFile(join(dir, "src", "index.ts"), 'const x = "hi"; // say "hello"\n');
    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.quote_style, "double");
  });
});

test("detectStyleFromSnippet: equal quote counts tiebreaks to single", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // One single, one double — equal counts → tiebreak to single
    await writeFile(join(dir, "src", "index.ts"), "const a = 'x'; const b = \"y\";\n");
    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.quote_style, "single");
  });
});

test("formatRepoConventions — omits sample_snippet by default", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const conventions = detectRepoConventions(dir);
    assert.ok(conventions.sample_snippet, "sample_snippet should be detected");

    const block = formatRepoConventions(conventions);
    assert.ok(
      !block.includes("Representative house-style snippet"),
      "snippet header must not appear without includeSnippet",
    );
    assert.ok(!block.includes("```"), "code fence must not appear without includeSnippet");
  });
});

test("formatRepoConventions — includes sample_snippet when includeSnippet:true", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const conventions = detectRepoConventions(dir);
    assert.ok(conventions.sample_snippet, "sample_snippet should be detected");

    const block = formatRepoConventions(conventions, { includeSnippet: true });
    assert.ok(
      block.includes("Representative house-style snippet"),
      "snippet header must appear with includeSnippet:true",
    );
    assert.ok(block.includes("```"), "code fence must appear with includeSnippet:true");
    assert.ok(block.includes("export const x = 1"), "snippet content must be present");
  });
});

test("detectStyleFromSnippet: no quote characters leaves quote_style undefined", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // No quotes at all
    await writeFile(join(dir, "src", "index.ts"), "const x = 1 + 2;\n");
    const conventions = detectRepoConventions(dir);
    assert.equal(conventions.quote_style, undefined);
  });
});
