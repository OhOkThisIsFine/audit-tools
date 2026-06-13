import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Single project-command discovery shared by both orchestrators. Before
// Phase 0 the auditor (`discoverRuntimeValidationCommand`) and the remediator
// (inline in `plan.ts`) each detected the test command separately, and only
// the auditor understood Go and Python. `discoverProjectCommands` unifies them
// and returns argv arrays so callers never re-parse a command string.

export interface ProjectCommands {
  test?: string[];
  e2e?: string[];
  build?: string[];
  lint?: string[];
}

// npm script names, in preference order, for each command role.
//
// Ordering is significant: pickScript() returns the FIRST match, so entries
// earlier in the list win over later ones.
//
// PLACEMENT RULE (applies to every list below):
//   1. Generic / widely-adopted names first.
//   2. Framework-specific or rarely-used names last.
//
// E2E_SCRIPT_NAMES: generic/framework-neutral names appear first (e.g.
// "test:e2e") so that a project using a standard naming convention is
// discovered before a framework-specific alias. Framework-specific runner
// names ("cypress:run", "playwright", "playwright:test") come last because
// they are only present when a project has opted into that particular runner.
//
// LINT_SCRIPT_NAMES: "lint" (standard) precedes "lint:check" (less common).
//
// When adding a new entry: verify that it is more generic than the entry
// immediately after it and more specific than the entry immediately before it.
// The ordering is regression-tested in tests/maintainability-split-rules.test.mjs.

/** E2E script names in discovery preference order (most generic first). */
const E2E_SCRIPT_NAMES: readonly string[] = [
  // --- generic / framework-neutral ---
  "e2e",
  "test:e2e",
  "test:e2e:run",
  "test:integration",
  // --- framework-specific ---
  "cypress:run",
  "playwright",
  "playwright:test",
];

const BUILD_SCRIPT_NAMES: readonly string[] = ["build"];

/** Lint script names in discovery preference order (most generic first). */
const LINT_SCRIPT_NAMES: readonly string[] = [
  // --- generic / standard ---
  "lint",
  // --- variants / less common ---
  "lint:check",
];

function readPackageScripts(root: string): Record<string, string> | null {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return parsed && typeof parsed === "object" && parsed.scripts
      ? parsed.scripts
      : {};
  } catch {
    // Unreadable / malformed package.json: treat as a non-Node project.
    return null;
  }
}

function pickScript(
  scripts: Record<string, string>,
  names: readonly string[],
): string[] | undefined {
  for (const name of names) {
    if (scripts[name] && scripts[name].trim().length > 0) {
      return ["npm", "run", name];
    }
  }
  return undefined;
}

/**
 * Discover the test/e2e/build/lint commands for a repository as argv arrays.
 *
 * Node detection (package.json) takes precedence for e2e/build/lint. The test
 * command prefers `npm test`, but — matching the auditor's prior behavior —
 * falls through to Go (`go test ./...`) then Python (`python -m pytest`) when
 * package.json has no usable `test` script or is absent. Absent roles are
 * omitted from the result.
 */
export function discoverProjectCommands(root: string): ProjectCommands {
  const result: ProjectCommands = {};
  const scripts = readPackageScripts(root);

  if (scripts) {
    const testScript = scripts.test?.trim();
    if (testScript && !/no test specified/i.test(testScript)) {
      result.test = ["npm", "test"];
    }
    const e2e = pickScript(scripts, E2E_SCRIPT_NAMES);
    if (e2e) result.e2e = e2e;
    const build = pickScript(scripts, BUILD_SCRIPT_NAMES);
    if (build) result.build = build;
    const lint = pickScript(scripts, LINT_SCRIPT_NAMES);
    if (lint) result.lint = lint;
  }

  if (!result.test) {
    if (existsSync(join(root, "go.mod"))) {
      result.test = ["go", "test", "./..."];
      if (!result.build) result.build = ["go", "build", "./..."];
    } else if (
      existsSync(join(root, "pyproject.toml")) ||
      existsSync(join(root, "pytest.ini"))
    ) {
      result.test = ["python", "-m", "pytest"];
    }
  }

  return result;
}
