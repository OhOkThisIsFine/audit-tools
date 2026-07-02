/**
 * Regression tests for maintainability findings:
 *
 *   MNT-20d66e48 — freeFormIntentInterpreter vs clauseInterpreter split rules differ intentionally
 *   MNT-ccdc8329 — quoteForCmd (argv-parser) vs quoteForShellInterpreterCmd (shell-interpreter) have distinct behavior
 *   MNT-58bc56f9 — E2E_SCRIPT_NAMES / LINT_SCRIPT_NAMES: generic names precede framework-specific ones
 */

import { test, expect } from "vitest";

// ── MNT-20d66e48: intentional split-rule difference ─────────────────────────

test("MNT-20d66e48: freeFormIntentInterpreter splits on commas; clauseInterpreter does not", async () => {
  const { interpretFreeFormIntent } = await import("../../src/shared/intent/freeFormIntentInterpreter.ts");
  const { decomposeIntent } = await import("../../src/shared/intent/clauseInterpreter.ts");

  // A comma-separated list: freeFormIntentInterpreter SHOULD split this into
  // multiple clauses (comma is a separator there).
  const input = "security, performance, maintainability";

  const freeFormResult = interpretFreeFormIntent(input);
  // freeFormIntentInterpreter splits on commas → should see at least 2 clause results
  const encodedLenses = Object.keys(freeFormResult.lensWeights);
  expect(encodedLenses.length >= 2, `expected ≥2 encoded lenses from comma-split, got ${encodedLenses.length}: ${encodedLenses.join(", ")}`).toBeTruthy();

  // clauseInterpreter does NOT split on commas → the whole string is one clause
  const clauses = decomposeIntent(input);
  expect(clauses.length, `clauseInterpreter should NOT split on commas; expected 1 clause, got ${clauses.length}: ${clauses.map((c) => c.text).join(" | ")}`).toBe(1);
});

test("MNT-20d66e48: comma-within-clause preserved by clauseInterpreter", async () => {
  const { decomposeIntent } = await import("../../src/shared/intent/clauseInterpreter.ts");

  // A clause with an internal comma that must not be split
  const input = "focus on modules A, B, and C";
  const clauses = decomposeIntent(input);
  // "and" is a split token — this will produce 2 clauses: "focus on modules A, B," and "C"
  // but importantly the comma between "A" and "B" must not create a standalone "B" clause
  const texts = clauses.map((c) => c.text);
  expect(!texts.some((t) => t === "B"), `comma should not split 'A, B, and C' into standalone 'B' clause; got: ${texts.join(" | ")}`).toBeTruthy();
});

// ── MNT-ccdc8329: quoteForCmd vs quoteForShellInterpreterCmd distinct behavior ─

test("MNT-ccdc8329: quoteForCmd uses double-quote doubling (argv-parser context)", async () => {
  const { quoteForCmd } = await import("../../src/shared/tooling/exec.ts");

  // Argv-parser context: internal " is doubled to ""
  expect(quoteForCmd('say "hello"')).toBe('"say ""hello"""');
  expect(quoteForCmd("a b")).toBe('"a b"');
  expect(quoteForCmd("plain")).toBe("plain");
  expect(quoteForCmd("")).toBe('""');
});

test("MNT-ccdc8329: quoteForShellInterpreterCmd uses caret-escaping (shell-interpreter context)", async () => {
  const { quoteForShellInterpreterCmd } = await import("../../src/shared/tooling/exec.ts");

  // Shell-interpreter context: " is caret-escaped to ^"
  const result = quoteForShellInterpreterCmd('say "hello"');
  expect(result.includes("^"), `expected caret-escaping in shell-interpreter context, got: ${result}`).toBeTruthy();
  // Safe tokens pass through unquoted
  expect(quoteForShellInterpreterCmd("plain")).toBe("plain");
  expect(quoteForShellInterpreterCmd("node.exe")).toBe("node.exe");
});

test("MNT-ccdc8329: quoteForCmd and quoteForShellInterpreterCmd produce different output for quotes", async () => {
  const { quoteForCmd, quoteForShellInterpreterCmd } = await import("../../src/shared/tooling/exec.ts");

  const token = 'arg"with"quotes';
  const cmdResult = quoteForCmd(token);
  const shellResult = quoteForShellInterpreterCmd(token);

  expect(cmdResult, `quoteForCmd and quoteForShellInterpreterCmd must produce different output for '${token}'`).not.toBe(shellResult);
  // quoteForCmd doubles the quote; quoteForShellInterpreterCmd caret-escapes it
  expect(cmdResult.includes('""'), `quoteForCmd should double quotes, got: ${cmdResult}`).toBeTruthy();
  expect(shellResult.includes("^"), `quoteForShellInterpreterCmd should caret-escape, got: ${shellResult}`).toBeTruthy();
});

// ── MNT-58bc56f9: E2E ordering — generic before framework-specific ───────────

test("MNT-58bc56f9: discoverProjectCommands prefers generic e2e script names over framework-specific ones", async () => {
  const { discoverProjectCommands } = await import("../../src/shared/tooling/testCommand.ts");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "mnt-58bc56f9-"));
  try {
    // Package with both a generic and a framework-specific e2e script
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "jest",
          "test:e2e": "jest --testPathPattern=e2e",
          "cypress:run": "cypress run",
        },
      }),
      "utf8",
    );
    const commands = discoverProjectCommands(dir);
    expect(commands.e2e, "e2e command should be discovered").toBeTruthy();
    expect(commands.e2e, `expected generic 'test:e2e' to win over framework-specific 'cypress:run', got: ${JSON.stringify(commands.e2e)}`).toEqual(["npm", "run", "test:e2e"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MNT-58bc56f9: discoverProjectCommands prefers generic lint over lint:check", async () => {
  const { discoverProjectCommands } = await import("../../src/shared/tooling/testCommand.ts");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "mnt-58bc56f9-lint-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "jest",
          lint: "eslint .",
          "lint:check": "eslint . --max-warnings 0",
        },
      }),
      "utf8",
    );
    const commands = discoverProjectCommands(dir);
    expect(commands.lint, "lint command should be discovered").toBeTruthy();
    expect(commands.lint, `expected generic 'lint' to win over 'lint:check', got: ${JSON.stringify(commands.lint)}`).toEqual(["npm", "run", "lint"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
