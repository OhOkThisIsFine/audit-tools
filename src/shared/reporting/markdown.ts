// sites-pinned: tests/remediate/reviewGate.test.ts, tests/remediate/clarification-round-contract.test.ts, tests/remediate/dropped-findings-record.test.ts
/** Format identifiers in their supplied order for Markdown prompts and diagnostics. */
export function backtickList(values: readonly string[]): string {
  return values.map(value => `\`${value}\``).join(", ");
}
