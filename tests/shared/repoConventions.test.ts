import { test, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepoConventions, formatRepoConventions } from "../../src/shared/tooling/repoConventions.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
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
    expect(conventions.formatter).toBe("prettier");
    expect(conventions.linter).toBe("eslint");
    expect(conventions.test_framework).toBe("vitest");
    expect(conventions.module_style).toBe("esm");
    expect(conventions.indentation).toBe("2 spaces");
    expect(conventions.quote_style).toBe("single");
    expect(conventions.sample_snippet?.includes("export function hello")).toBeTruthy();

    const block = formatRepoConventions(conventions);
    expect(block).toMatch(/match the surrounding code/);
    expect(block).toMatch(/Formatter: prettier/);
  });
});

test("detects commonjs module style without type:module", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const conventions = detectRepoConventions(dir);
    expect(conventions.module_style).toBe("commonjs");
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
    expect(conventions.formatter).toBe("black");
    expect(conventions.linter).toBe("ruff");
    expect(conventions.test_framework).toBe("pytest");
    expect(conventions.indentation).toBe("4 spaces");
  });
});

test.each([
  ['quoted headers', '[tool."black"]\nline-length = 88\n[tool."ruff"]\nline-length = 88\n[tool."pytest".ini_options]\ntestpaths = ["tests"]\n'],
  ['dotted keys', 'tool.black.line-length = 88\ntool.ruff.line-length = 88\ntool.pytest.ini_options.testpaths = ["tests"]\n'],
  ['inline tables', '[tool]\nblack = { line-length = 88 }\nruff = { line-length = 88 }\npytest = { ini_options = { testpaths = ["tests"] } }\n'],
])("detects Python tools declared using %s", async (_form, content) => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), content);
    expect(detectRepoConventions(dir)).toEqual({
      formatter: "black", linter: "ruff", test_framework: "pytest",
    });
  });
});

test.each([
  ['comments', '# [tool.black]\n# [tool.ruff]\n# [tool.pytest.ini_options]\n'],
  ['string contents', 'example = """\n[tool.black]\n[tool.ruff]\n[tool.pytest.ini_options]\n"""\n'],
  ['similarly named tools', '[tool.ruff-other]\n[tool.pytest_extra]\n'],
  ['non-table settings', '[tool]\nblack = "black"\nruff = true\nflake8 = ["flake8"]\npytest = 1\n'],
  ['TOML temporal scalars', '[tool]\nblack = 1979-05-27\nruff = 07:32:00\nflake8 = 1979-05-27T07:32:00\npytest = 1979-05-27T07:32:00Z\n'],
  ['arrays of tables', '[[tool.black]]\n[[tool.ruff]]\n[[tool.flake8]]\n[[tool.pytest]]\n'],
  ['malformed TOML', '[tool.black]\nline-length = = 88\n[tool.ruff]\n[tool.pytest.ini_options]\n'],
])("does not infer Python tools from %s", async (_form, content) => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), content);
    expect(detectRepoConventions(dir)).toEqual({});
  });
});

test.each(["pytest.ini", "conftest.py"])("Python %s fallback survives malformed TOML", async (pytestFile) => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), "[tool.ruff]\ninvalid = =\n");
    await writeFile(join(dir, ".flake8"), "[flake8]\n");
    await writeFile(join(dir, pytestFile), "");
    expect(detectRepoConventions(dir)).toEqual({ linter: "flake8", test_framework: "pytest" });
  });
});

test("inactive Python configuration does not override Node conventions", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", devDependencies: { prettier: "^3", eslint: "^9", vitest: "^2" } }));
    await writeFile(join(dir, "pyproject.toml"), '# [tool.black]\n# [tool.ruff]\n# [tool.pytest.ini_options]\n');
    expect(detectRepoConventions(dir)).toEqual({ formatter: "prettier", linter: "eslint", test_framework: "vitest", module_style: "esm" });
  });
});

test("detects nested Ruff configuration and inline Flake8 tables", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "pyproject.toml"), '[tool.ruff.lint]\nselect = ["E"]\n[tool.flake8]\nmax-line-length = 88\n');
    expect(detectRepoConventions(dir)).toEqual({ formatter: "ruff", linter: "ruff" });
    await writeFile(join(dir, "pyproject.toml"), 'tool.flake8 = { max-line-length = 88 }\n');
    expect(detectRepoConventions(dir)).toEqual({ linter: "flake8" });
  });
});

test("returns an empty object and empty block for a bare directory", async () => {
  await withTempDir(async (dir) => {
    const conventions = detectRepoConventions(dir);
    expect(conventions).toEqual({});
    expect(formatRepoConventions(conventions)).toBe("");
  });
});

test("detectStyleFromSnippet: more single-quotes resolves to quote_style single", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // More single-quotes: const x = 'hi'; // it's
    await writeFile(join(dir, "src", "index.ts"), "const x = 'hi'; // it's\n");
    const conventions = detectRepoConventions(dir);
    expect(conventions.quote_style).toBe("single");
  });
});

test("detectStyleFromSnippet: more double-quotes resolves to quote_style double", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // More double-quotes: const x = "hi"; // say "hello"
    await writeFile(join(dir, "src", "index.ts"), 'const x = "hi"; // say "hello"\n');
    const conventions = detectRepoConventions(dir);
    expect(conventions.quote_style).toBe("double");
  });
});

test("detectStyleFromSnippet: equal quote counts tiebreaks to single", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // One single, one double — equal counts → tiebreak to single
    await writeFile(join(dir, "src", "index.ts"), "const a = 'x'; const b = \"y\";\n");
    const conventions = detectRepoConventions(dir);
    expect(conventions.quote_style).toBe("single");
  });
});

test("formatRepoConventions — omits sample_snippet by default", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const conventions = detectRepoConventions(dir);
    expect(conventions.sample_snippet, "sample_snippet should be detected").toBeTruthy();

    const block = formatRepoConventions(conventions);
    expect(!block.includes("Representative house-style snippet"), "snippet header must not appear without includeSnippet").toBeTruthy();
    expect(!block.includes("```"), "code fence must not appear without includeSnippet").toBeTruthy();
  });
});

test("formatRepoConventions — includes sample_snippet when includeSnippet:true", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n");

    const conventions = detectRepoConventions(dir);
    expect(conventions.sample_snippet, "sample_snippet should be detected").toBeTruthy();

    const block = formatRepoConventions(conventions, { includeSnippet: true });
    expect(block.includes("Representative house-style snippet"), "snippet header must appear with includeSnippet:true").toBeTruthy();
    expect(block.includes("```"), "code fence must appear with includeSnippet:true").toBeTruthy();
    expect(block.includes("export const x = 1"), "snippet content must be present").toBeTruthy();
  });
});

test("detectStyleFromSnippet: no quote characters leaves quote_style undefined", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // No quotes at all
    await writeFile(join(dir, "src", "index.ts"), "const x = 1 + 2;\n");
    const conventions = detectRepoConventions(dir);
    expect(conventions.quote_style).toBe(undefined);
  });
});

test("detectStyleFromSnippet: double-quoted HTML attrs in template literals do not skew to double (COR-a1786327)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    await mkdir(join(dir, "src"), { recursive: true });
    // File uses single-quote string literals throughout, but has a template literal
    // containing HTML with double-quoted attributes.  The raw-character approach would
    // see 4 double-quotes (class="foo" x2) vs 2 single-quotes and mis-detect as "double".
    // The scanner-aware approach skips content inside template literals.
    const src = [
      "const cls = 'primary';",
      "const html = `<div class=\"foo\"><span class=\"bar\">${cls}</span></div>`;",
    ].join("\n") + "\n";
    await writeFile(join(dir, "src", "index.ts"), src);
    const conventions = detectRepoConventions(dir);
    expect(conventions.quote_style).toBe("single");
  });
});
