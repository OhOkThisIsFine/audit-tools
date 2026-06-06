import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Lightweight, deterministic detection of a repository's house style so the
 * remediator's worker prompts can say "match the surrounding code" with
 * specifics (formatter, linter, test framework, module style, and a sampled
 * snippet). Best-effort and side-effect-free: every probe is guarded and an
 * undetected field is simply omitted. Phase 7A.
 */

export interface RepoConventions {
  formatter?: string;
  linter?: string;
  test_framework?: string;
  module_style?: "esm" | "commonjs";
  indentation?: string;
  quote_style?: "single" | "double";
  /** A short excerpt from a representative source file. */
  sample_snippet?: string;
}

const SAMPLE_DIRECTORIES = ["src", "lib", "app", "."] as const;
const SAMPLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".py", ".go"] as const;
const SAMPLE_MAX_LINES = 24;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function hasDependency(pkg: Record<string, unknown> | undefined, name: string): boolean {
  if (!pkg) return false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && name in (deps as object)) {
      return true;
    }
  }
  return false;
}

function detectNodeConventions(
  root: string,
  pkg: Record<string, unknown>,
  conventions: RepoConventions,
): void {
  conventions.module_style = pkg.type === "module" ? "esm" : "commonjs";

  if (
    hasDependency(pkg, "prettier") ||
    ["", ".json", ".js", ".cjs", ".yaml", ".yml"].some((extension) =>
      existsSync(join(root, `.prettierrc${extension}`)),
    )
  ) {
    conventions.formatter = "prettier";
  }
  if (
    hasDependency(pkg, "eslint") ||
    [".eslintrc", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs"].some(
      (file) => existsSync(join(root, file)),
    )
  ) {
    conventions.linter = "eslint";
  } else if (hasDependency(pkg, "biome") || hasDependency(pkg, "@biomejs/biome")) {
    conventions.linter = "biome";
  }

  for (const framework of ["vitest", "jest", "mocha", "ava"]) {
    if (hasDependency(pkg, framework)) {
      conventions.test_framework = framework;
      break;
    }
  }
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const testScript = typeof scripts?.test === "string" ? scripts.test : "";
  if (!conventions.test_framework && /node\s+--test|node:test/.test(testScript)) {
    conventions.test_framework = "node:test";
  }
}

function detectPythonConventions(
  root: string,
  conventions: RepoConventions,
): void {
  const pyproject = readText(join(root, "pyproject.toml")) ?? "";
  if (/\[tool\.black\]/.test(pyproject)) conventions.formatter = "black";
  else if (/\[tool\.ruff(?:\.format)?\]/.test(pyproject)) conventions.formatter = "ruff";

  if (/\[tool\.ruff\b/.test(pyproject)) conventions.linter = "ruff";
  else if (existsSync(join(root, ".flake8")) || /\[tool\.flake8\]/.test(pyproject))
    conventions.linter = "flake8";

  if (
    /\[tool\.pytest/.test(pyproject) ||
    existsSync(join(root, "pytest.ini")) ||
    existsSync(join(root, "conftest.py"))
  ) {
    conventions.test_framework = "pytest";
  }
}

/** Find one representative source file and sample its leading lines. */
function sampleSourceFile(root: string): string | undefined {
  for (const directory of SAMPLE_DIRECTORIES) {
    const absolute = directory === "." ? root : join(root, directory);
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      continue;
    }
    const match = entries
      .filter((name) =>
        SAMPLE_EXTENSIONS.some((extension) => name.endsWith(extension)),
      )
      .filter((name) => !/\.(test|spec|d)\./.test(name))
      .sort()[0];
    if (match) {
      const content = readText(join(absolute, match));
      if (content) {
        return content.split(/\r?\n/).slice(0, SAMPLE_MAX_LINES).join("\n");
      }
    }
  }
  return undefined;
}

function detectStyleFromSnippet(snippet: string, conventions: RepoConventions): void {
  const lines = snippet.split(/\r?\n/);
  const indented = lines.filter((line) => /^\s+\S/.test(line));
  if (indented.some((line) => line.startsWith("\t"))) {
    conventions.indentation = "tabs";
  } else {
    const widths = indented
      .map((line) => line.match(/^ +/)?.[0].length ?? 0)
      .filter((width) => width > 0);
    if (widths.length > 0) {
      conventions.indentation = `${Math.min(...widths)} spaces`;
    }
  }

  // Raw character counts across the whole snippet (includes comments, JSDoc, HTML attributes).
  const rawSingleQuoteCount = (snippet.match(/'/g) ?? []).length;
  const rawDoubleQuoteCount = (snippet.match(/"/g) ?? []).length;
  if (rawSingleQuoteCount > 0 || rawDoubleQuoteCount > 0) {
    conventions.quote_style = rawSingleQuoteCount >= rawDoubleQuoteCount ? "single" : "double";
  }
}

export function detectRepoConventions(root: string): RepoConventions {
  const conventions: RepoConventions = {};
  const pkg = readJson(join(root, "package.json"));
  if (pkg) {
    detectNodeConventions(root, pkg, conventions);
  }
  if (
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "pytest.ini")) ||
    existsSync(join(root, "setup.py"))
  ) {
    detectPythonConventions(root, conventions);
  }

  const snippet = sampleSourceFile(root);
  if (snippet) {
    conventions.sample_snippet = snippet;
    detectStyleFromSnippet(snippet, conventions);
  }

  return conventions;
}

/** Render a prompt block from detected conventions, or "" if nothing detected. */
export function formatRepoConventions(conventions: RepoConventions): string {
  const lines: string[] = [];
  if (conventions.formatter) lines.push(`- Formatter: ${conventions.formatter}`);
  if (conventions.linter) lines.push(`- Linter: ${conventions.linter}`);
  if (conventions.test_framework)
    lines.push(`- Test framework: ${conventions.test_framework}`);
  if (conventions.module_style)
    lines.push(`- Module style: ${conventions.module_style}`);
  if (conventions.indentation)
    lines.push(`- Indentation: ${conventions.indentation}`);
  if (conventions.quote_style)
    lines.push(`- String quotes: ${conventions.quote_style}`);

  if (lines.length === 0 && !conventions.sample_snippet) {
    return "";
  }

  let block = "REPOSITORY CONVENTIONS (match the surrounding code):\n";
  if (lines.length > 0) block += `${lines.join("\n")}\n`;
  if (conventions.sample_snippet) {
    block += `\nRepresentative house-style snippet:\n\`\`\`\n${conventions.sample_snippet}\n\`\`\`\n`;
  }
  return block.trim();
}
