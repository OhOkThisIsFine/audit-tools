import { describe, expect, it } from "vitest";

import { CharterProvenanceSchema } from "../../src/shared/types/charter.js";

// P40 (nightly 2026-08-22). A generated prompt states its output contract as a
// hand-typed literal beside a separately hand-written validator, and the two
// drift: a worker that obeys the prompt produces a submission the tool rejects.
// Measured cost: one charter submission quarantined after a 34-minute lane run.
//
// The audit finding contract already fixed this by RENDERING the contract from
// the schema ingestion enforces (findingContractPromptLines). These two pins
// hold the same property at the two sites that did not get that treatment.
//
// Deliberately SHAPE rules, not a field-set reconciliation: a field-set test is
// red on 15 correct contract-pipeline sketches, because `created_at` is stamped
// tool-side ("the host has no clock") and the prompts omit it correctly.
const FAILURE_SIGNATURE =
  "contract:a-prompt-renders-its-contract-from-the-contract:not-yet-satisfied";

describe(FAILURE_SIGNATURE, () => {
  it("renders the charter provenance enum exhaustively, never as an open list", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/audit/cli/charterExtractionPrompt.ts", "utf8"),
    );
    const line = source
      .split(String.fromCharCode(10))
      .find((entry) => entry.includes('"provenance"'));
    expect(line, "the lane prompt must show a provenance example").toBeDefined();

    // The enum is CLOSED. An alternation that trails off invites a coined
    // member — which is exactly what quarantined the structural lane's run.
    expect(
      line,
      "a closed enum must not be rendered as an open alternation ending in '...'",
    ).not.toMatch(/\|\s*\.\.\./u);

    // Every member the validator accepts must appear, so the rendered list is
    // derived from the schema rather than hand-kept beside it.
    for (const member of CharterProvenanceSchema.shape.kind.options) {
      expect(
        line,
        `the prompt must name provenance kind '${member}' — the validator accepts it ` +
          `and a prompt that omits it teaches a smaller contract than the tool enforces`,
      ).toContain(member);
    }
  });

  it("states the element shape of excluded_scope in the confirm-intent template", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/remediate/steps/nextStep.ts", "utf8"),
    );

    // Both branches of the confirm-intent prompt render this key. The fallback
    // branch already states {path, reason}; the pre-drafted branch — the common
    // path — renders a bare []. The reader (fileExclusionReason in
    // src/shared/intent/pathScope.ts) iterates it expecting objects.
    const renderings = [...source.matchAll(/^\s*"excluded_scope":\s*(.+)$/gmu)].map(
      (match) => match[1],
    );
    expect(
      renderings.length,
      "the confirm-intent template must render excluded_scope",
    ).toBeGreaterThan(0);

    for (const rendering of renderings) {
      expect(
        rendering,
        "every rendering of excluded_scope must state its element shape — a bare [] " +
          "teaches a shape the reader crashes on",
      ).toMatch(/path/u);
      expect(rendering, "and the reason field its reader requires").toMatch(/reason/u);
    }
  });
});
