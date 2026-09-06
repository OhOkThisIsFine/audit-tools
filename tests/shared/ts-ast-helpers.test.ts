import { describe, it, expect } from "vitest";
import ts from "typescript";

const { unwrapExpression } = await import("../../scripts/shared/tsAstHelpers.mjs");

/**
 * The initializer of `export const X = <expr>` in a throwaway source file — the
 * exact shape every generator hands `unwrapExpression`.
 */
function initializerOf(source: string): ts.Expression {
  const file = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations[0];
    if (declaration?.initializer) return declaration.initializer;
  }
  throw new Error("fixture has no initializer");
}

describe("unwrapExpression", () => {
  it("peels `as const`", () => {
    const peeled = unwrapExpression(initializerOf('export const X = "a" as const;'));
    expect(ts.isStringLiteral(peeled)).toBe(true);
    expect((peeled as ts.StringLiteral).text).toBe("a");
  });

  it("peels `satisfies T`", () => {
    const peeled = unwrapExpression(initializerOf('export const X = "a" satisfies string;'));
    expect(ts.isStringLiteral(peeled)).toBe(true);
  });

  it("peels parentheses", () => {
    const peeled = unwrapExpression(initializerOf('export const X = ("a");'));
    expect(ts.isStringLiteral(peeled)).toBe(true);
  });

  it("peels all three nested together", () => {
    const peeled = unwrapExpression(
      initializerOf('export const X = (("a" as const) satisfies string) as const;'),
    );
    expect(ts.isStringLiteral(peeled)).toBe(true);
    expect((peeled as ts.StringLiteral).text).toBe("a");
  });

  it("returns a bare literal unchanged", () => {
    const node = initializerOf('export const X = ["a", "b"];');
    expect(unwrapExpression(node)).toBe(node);
  });

  // A DELIBERATE non-goal, not an omission. Peeling `x!` would silently widen
  // what every registry accepts and weaken the refuse-rather-than-guess contract
  // each generator promises in its refusal message. Widening it is a separate
  // change with its own registry fixtures.
  it("does NOT peel a non-null assertion", () => {
    const node = initializerOf("export const X = y!;");
    expect(ts.isNonNullExpression(node)).toBe(true);
    expect(unwrapExpression(node)).toBe(node);
  });
});
