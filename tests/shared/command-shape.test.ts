import { describe, expect, test } from "vitest";

import {
  commandLeavesDeclaredShape,
  partitionCommandsByDeclaredShape,
} from "../../src/shared/tooling/commandShape.js";

// ---------------------------------------------------------------------------
// CP-NODE-28 / SEC-305e7ec5 — direct tests pinning THE declared
// single-invocation command shape. The gate's contract is stated by its
// tests: declared-shape conformance accepted, deviation refused.
//
// `commandLeavesDeclaredShape(command) === true` means REFUSE. Contract:
// `'` backslash caret percent dollar backtick and every control character
// are refused in EVERY position (quoted or not); chaining / redirection /
// grouping (`&|;<>()`) is refused OUTSIDE double quotes; an unterminated
// double quote is itself a refusal. Double quotes hide enclosed
// metacharacters — the one construct both shells agree on.
// ---------------------------------------------------------------------------

describe("commandLeavesDeclaredShape — accepted (keeps the declared shape)", () => {
  test("plain invocations are admitted", () => {
    expect(commandLeavesDeclaredShape("npm run build")).toBe(false);
    expect(commandLeavesDeclaredShape("npx vitest run tests/shared")).toBe(false);
    expect(commandLeavesDeclaredShape("node dist/bin.js next-step --input report.md")).toBe(false);
  });

  test("double quotes hide metacharacters", () => {
    // Parens INSIDE quotes are an ordinary invocation, not a subshell.
    expect(commandLeavesDeclaredShape('node -e "process.exit(0)"')).toBe(false);
    expect(commandLeavesDeclaredShape('echo "a & b"')).toBe(false);
    expect(commandLeavesDeclaredShape('vitest run --testNamePattern="alpha|beta"')).toBe(false);
    expect(commandLeavesDeclaredShape('echo "redirect > stays literal"')).toBe(false);
  });
});

describe("commandLeavesDeclaredShape — refused (leaves the declared shape)", () => {
  test("chaining outside quotes", () => {
    expect(commandLeavesDeclaredShape("npm run build && npm test")).toBe(true);
    expect(commandLeavesDeclaredShape("npm run build & npm test")).toBe(true);
    expect(commandLeavesDeclaredShape("a | b")).toBe(true);
    expect(commandLeavesDeclaredShape("a ; b")).toBe(true);
    expect(commandLeavesDeclaredShape('echo "closed" & whoami')).toBe(true);
  });

  test("redirection outside quotes", () => {
    expect(commandLeavesDeclaredShape("npm test > out.log")).toBe(true);
    expect(commandLeavesDeclaredShape("npm test 2>&1")).toBe(true);
    expect(commandLeavesDeclaredShape("npm test < fixtures/input.json")).toBe(true);
  });

  test("grouping / subshelling outside quotes", () => {
    expect(commandLeavesDeclaredShape("(npm test)")).toBe(true);
    expect(commandLeavesDeclaredShape("npm run (build)")).toBe(true);
  });

  test("unconditionally refused — quoted or not", () => {
    // Per-shell escape/expansion characters de-sync quote state under one of
    // the two `shell: true` grammars, so they are refused in EVERY position.
    expect(commandLeavesDeclaredShape("echo $HOME")).toBe(true);
    expect(commandLeavesDeclaredShape('echo "$HOME"')).toBe(true);
    expect(commandLeavesDeclaredShape("echo %PATH%")).toBe(true);
    expect(commandLeavesDeclaredShape('echo "%PATH%"')).toBe(true);
    expect(commandLeavesDeclaredShape("echo `id`")).toBe(true);
    expect(commandLeavesDeclaredShape('echo "backtick ` inside"')).toBe(true);
    expect(commandLeavesDeclaredShape("echo 'single-quoted & live'")).toBe(true);
    expect(commandLeavesDeclaredShape("echo a\\b")).toBe(true);
    expect(commandLeavesDeclaredShape("npx tool ^ continue")).toBe(true);
    // Control characters: LF truncates a cmd.exe double-quoted command and CR
    // is deleted outright — what runs is not what was scanned.
    expect(commandLeavesDeclaredShape("npm test\necho pwned")).toBe(true);
    expect(commandLeavesDeclaredShape("npm test\recho pwned")).toBe(true);
  });

  test("an unterminated double quote is itself a refusal", () => {
    // The remainder cannot be classified, so it cannot be admitted.
    expect(commandLeavesDeclaredShape('node -e "process.exit(0)')).toBe(true);
    expect(commandLeavesDeclaredShape('echo "open')).toBe(true);
  });
});

describe("partitionCommandsByDeclaredShape", () => {
  const describeRefusal = (kind: "empty" | "leaves-shape", raw: unknown): string =>
    kind === "empty" ? `empty command (${String(raw)})` : `leaves declared shape: ${String(raw)}`;

  test("splits an admitted majority from refusal lines, order preserved", () => {
    const { commands, refusals } = partitionCommandsByDeclaredShape(
      ["npm run build", "a && b", "npx vitest run tests/shared"],
      describeRefusal,
    );
    expect(commands).toEqual(["npm run build", "npx vitest run tests/shared"]);
    expect(refusals).toEqual(["leaves declared shape: a && b"]);
  });

  test("trims admitted entries; blank and non-string entries are refused as empty", () => {
    const { commands, refusals } = partitionCommandsByDeclaredShape(
      ["  npm run check  ", "", "   ", undefined as unknown as string],
      describeRefusal,
    );
    expect(commands).toEqual(["npm run check"]);
    expect(refusals).toEqual([
      "empty command ()",
      "empty command (   )",
      "empty command (undefined)",
    ]);
  });

  test("all-admitted and all-refused are both representable", () => {
    expect(partitionCommandsByDeclaredShape(["npm test"], describeRefusal)).toEqual({
      commands: ["npm test"],
      refusals: [],
    });
    expect(partitionCommandsByDeclaredShape(["a > b"], describeRefusal)).toEqual({
      commands: [],
      refusals: ["leaves declared shape: a > b"],
    });
  });

  test("describeRefusal owns the vocabulary — the module only decides", () => {
    const custom = (): string => "block contract invalid";
    expect(partitionCommandsByDeclaredShape(["", "a | b"], custom).refusals).toEqual([
      "block contract invalid",
      "block contract invalid",
    ]);
  });
});
