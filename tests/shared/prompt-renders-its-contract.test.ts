import { describe, expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { CharterProvenanceSchema } from "../../src/shared/types/charter.js";

// P40 (nightly 2026-08-22). A generated prompt states its output contract as a
// hand-typed literal beside a separately hand-written validator, and the two
// drift: a worker that obeys the prompt produces a submission the tool rejects.
// Measured cost: one charter submission quarantined after a 34-minute lane run.
//
// Two pins, two shapes:
// - the charter provenance pin is BEHAVIORAL — it renders the lane prompt and
//   holds exhaustiveness/closedness of the RENDERED text (the render itself
//   derives the list from CharterProvenanceSchema, so a schema enum change
//   flows into the prompt and this pin follows it);
// - the excluded_scope pin is a SOURCE scan of the remediate template literal.
//
// Deliberately SHAPE rules, not a field-set reconciliation: a field-set test is
// red on 15 correct contract-pipeline sketches, because `created_at` is stamped
// tool-side ("the host has no clock") and the prompts omit it correctly.
const FAILURE_SIGNATURE =
  "contract:a-prompt-renders-its-contract-from-the-contract:not-yet-satisfied";

/** Smallest bundle the lane renderer accepts — only `consensus` is read. */
function bundle(): ArtifactBundle {
  return {
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: ["call_import"],
      consensus: [],
      contested: [],
      findings: [],
    },
  };
}

describe(FAILURE_SIGNATURE, () => {
  it("renders the charter provenance enum exhaustively, never as an open list", () => {
    const prompt = renderCharterKindLanePrompt(bundle(), {
      kind: "stated",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    // The rendered alternation IS the schema's option list, in schema order.
    const alternation = CharterProvenanceSchema.shape.kind.options.join("|");
    expect(
      prompt,
      "the lane prompt must show a provenance example derived from the schema",
    ).toContain(`"provenance": [{ "kind": "${alternation}"`);

    // The enum is CLOSED. An alternation that trails off invites a coined
    // member — which is exactly what quarantined the structural lane's run.
    expect(
      prompt,
      "a closed enum must not be rendered as an open alternation ending in '...'",
    ).not.toMatch(/\|\s*\.\.\./u);

    // Every member the validator accepts must appear, so the rendered list is
    // never smaller than what ingestion enforces.
    for (const member of CharterProvenanceSchema.shape.kind.options) {
      expect(
        prompt,
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
