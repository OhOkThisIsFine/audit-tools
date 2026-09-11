import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every classified ingest issue must be durably recorded BEFORE any exit path
 * out of `buildImplementDispatchStep`.
 *
 * The defect. The per-issue `runLogger.event` loop used to sit next to the
 * prompt that renders the same issues — that is, BELOW the `state_changed` early
 * return. So it ran only when NOTHING was accepted. On a partial batch, where
 * the host submitted several results and some were rejected, `state_changed` is
 * true, the call transitions, and every rejection was lost: not logged, not
 * rendered, not carried. The one path where a host most needs to hear that part
 * of its work was refused was the path that said nothing at all.
 *
 * SOURCE-TEXT, deliberately, for the same reason as the host-ingest phase
 * boundary guard beside it: a behavioural test can observe that a log line was
 * written on one particular fixture, but it cannot express "before every exit".
 * Ordering within a function is syntactically visible and behaviourally
 * invisible, so the property is stated where it can actually be checked.
 *
 * ⚠ This is a FLOOR, not a proof. It pins the ordering that was wrong. It does
 * not prove that some future third exit path is also covered — if one is added
 * above the log loop, extend this guard rather than assume it.
 */
const SOURCE = fileURLToPath(
  new URL("../../src/remediate/steps/nextStep.ts", import.meta.url),
);

function bodyOfBuildImplementDispatchStep(): string[] {
  const lines = readFileSync(SOURCE, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.includes("async function buildImplementDispatchStep("),
  );
  expect(start, "nextStep.ts declares buildImplementDispatchStep").toBeGreaterThan(-1);

  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const character of lines[index]!) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}") {
        depth -= 1;
      }
    }
    if (opened && depth === 0) return lines.slice(start, index + 1);
  }
  throw new Error("buildImplementDispatchStep body did not close");
}

describe("host ingest issues are recorded before any exit path", () => {
  it("logs every classified issue before the state_changed early return", () => {
    const body = bodyOfBuildImplementDispatchStep();

    const logIndex = body.findIndex((line) => line.includes("host_ingest_issue"));
    const earlyReturnIndex = body.findIndex((line) =>
      line.includes("if (ingested.state_changed)"),
    );

    expect(logIndex, "the ingest-issue log line exists").toBeGreaterThan(-1);
    expect(earlyReturnIndex, "the state_changed early return exists").toBeGreaterThan(-1);
    expect(
      logIndex,
      "every classified ingest issue must be logged BEFORE the state_changed early " +
        "return; below it, a partial batch transitions and every rejection is lost",
    ).toBeLessThan(earlyReturnIndex);
  });

  // Position alone is not the property. A log loop that sits early but is
  // wrapped in `if (!ingested.state_changed)` reproduces the exact defect while
  // satisfying an ordering check, so the guard must also see that the loop is
  // UNCONDITIONAL. Top-level statements in this function body are indented two
  // spaces; anything nested in a conditional is indented further.
  it("logs unconditionally, not inside a branch that reproduces the defect", () => {
    const body = bodyOfBuildImplementDispatchStep();
    const loopIndex = body.findIndex((line) =>
      line.includes("for (const issue of ingested.issues)"),
    );
    expect(loopIndex, "the ingest-issue loop exists").toBeGreaterThan(-1);

    const indent = body[loopIndex]!.match(/^\s*/)![0].length;
    expect(
      indent,
      "the ingest-issue loop must be a top-level statement of the function; " +
        "nesting it in a branch is how the issues were lost on a partial batch",
    ).toBe(2);
  });

  it("records the issue exactly once, so there is one home for the fact", () => {
    const body = bodyOfBuildImplementDispatchStep();
    const occurrences = body.filter((line) => line.includes("host_ingest_issue"));
    expect(occurrences.length).toBe(1);
  });

  it("still renders the issues on the re-emit path", () => {
    // The durable half moving earlier must not cost the rendered half, which is
    // what the host reads when nothing was accepted.
    //
    // The render now lives in `remediationResultDiagnostics` — it grew a
    // missing/rejected split, which is more than this function should carry —
    // so this asserts the PROPERTY (the step's prompt is fed the diagnostics)
    // rather than the heading's presence in this one function's body. Pinning
    // the heading here made a correct extraction read as a regression.
    const body = bodyOfBuildImplementDispatchStep().join("\n");
    expect(body).toContain("remediationResultDiagnostics(ingested)");
    const helper = readFileSync(SOURCE, "utf8");
    expect(helper).toContain("## Result status requiring attention");
    // Both sections the host needs to tell patience from a repair.
    expect(helper).toContain("## Results not yet written");
  });
});
