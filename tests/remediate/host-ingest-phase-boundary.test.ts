import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The host ingest is three phases over one read-mostly context: validate the
 * whole bundle, verify each item, commit the accepted verdicts. Only the LAST
 * one writes state.
 *
 * Stating that in prose is what the repository bans wherever a property can be
 * guaranteed mechanically, and this one can: a write to the state clone is
 * syntactically recognizable. The failure it guards is not hypothetical
 * bookkeeping — the phases were separated precisely because they were
 * interleaved, and a verification path that resumes writing re-creates the
 * shape whose per-item ordering the split had to neutralize.
 *
 * SOURCE-TEXT, deliberately. A behavioural test cannot see WHERE a write
 * happened, only that state changed, so it cannot express this property at all.
 * The same reasoning already stands behind the ingestion-check drift test,
 * which scans this file's `check:` literals.
 */
const SOURCE = fileURLToPath(
  new URL("../../src/remediate/steps/dispatch/hostHandoff.ts", import.meta.url),
);

/**
 * An assignment to a member of the state clone, or to an `item` bound out of
 * it, or a `delete` of either. `item` is only ever bound from
 * `nextState.items[...]` in this file, which the second assertion below pins.
 */
const STATE_WRITE =
  /(^\s*(?:nextState|item)\.[A-Za-z_$][\w$]*\s*(?:\?\?)?=(?!=))|(^\s*delete\s+(?:nextState|item)\.)/;

/** The body of a top-level function, by brace balance from its declaration. */
function functionBody(lines: readonly string[], name: string): {
  readonly startLine: number;
  readonly body: readonly string[];
} {
  const start = lines.findIndex((line) => line.includes(`function ${name}(`));
  expect(start, `hostHandoff.ts declares ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]!) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") depth -= 1;
    }
    if (opened && depth === 0) {
      return { startLine: start + 1, body: lines.slice(start, index + 1) };
    }
  }
  throw new Error(`unterminated function ${name}`);
}

describe("the remediation host ingest keeps its three phases separable", () => {
  const lines = readFileSync(SOURCE, "utf8").split("\n");

  it("writes state ONLY from the commit phase", () => {
    for (const phase of [
      "validateHostResultBundle",
      "executeHostVerificationReruns",
    ]) {
      const { startLine, body } = functionBody(lines, phase);
      const writes = body
        .map((line, offset) => ({ line, at: startLine + offset }))
        .filter((entry) => STATE_WRITE.test(entry.line))
        .map((entry) => `${entry.at}: ${entry.line.trim()}`);
      expect(
        writes,
        `${phase} must not write state — move the write into commitRemediationStateUpdates ` +
          "and carry what it needs on the verdict",
      ).toEqual([]);
    }
  });

  it("keeps the state writes in the commit phase rather than losing them", () => {
    // The counterweight. Without it the first assertion is satisfied by a
    // refactor that deletes the mutation outright, which is the fail-open
    // direction on a boundary whose whole job is to record acceptances.
    const { body } = functionBody(lines, "commitRemediationStateUpdates");
    const writes = body.filter((line) => STATE_WRITE.test(line));
    expect(writes.length).toBeGreaterThanOrEqual(15);
  });

  it("binds `item` inside the phases only out of the state clone", () => {
    // The first assertion recognizes `item.` writes as state writes. That is
    // only sound while every `item` INSIDE THE THREE PHASES is an alias into
    // `nextState.items`; one bound from anything else would let a real state
    // write hide, or a harmless local read as one, with no test noticing.
    //
    // Scoped to the phases deliberately. Elsewhere in this file `item` is a
    // plain local — `parseCurrentState` binds one out of a raw record it is
    // validating — and those functions hold no state clone to write to.
    const phases = [
      "validateHostResultBundle",
      "executeHostVerificationReruns",
      "commitRemediationStateUpdates",
    ];
    let bindings = 0;
    for (const phase of phases) {
      const { startLine, body } = functionBody(lines, phase);
      body.forEach((line, offset) => {
        if (!/^\s*const item\b/.test(line)) return;
        bindings += 1;
        expect(
          line.trim(),
          `${phase} line ${startLine + offset} binds \`item\` from something other than the state clone`,
        ).toMatch(/^const item = nextState\.items\[/);
      });
    }
    expect(bindings, "the phases bind `item` at all").toBeGreaterThan(0);
  });
});
