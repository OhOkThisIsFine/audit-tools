// Pure TypeScript-AST helpers shared by the `scripts/` code generators.
//
// This is a LEAF module on purpose. `generatedArtifacts.mjs` is the other shared
// generator substrate, but it is imported by every generator, and putting a
// `typescript` import there would load the ~8MB compiler for the ones that only
// render. A generator that parses TypeScript imports this; one that does not,
// does not pay for it.

import ts from "typescript";

/** Strip `as const` / `satisfies T` / parentheses down to the underlying literal. */
export function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}
