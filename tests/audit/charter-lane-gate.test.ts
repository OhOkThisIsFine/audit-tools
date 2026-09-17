// The charter-extraction LANE GATE — what `charterLaneSchema` accepts from a
// blind lane, and what it refuses.
//
// Owner review of prompt 8 (2026-09-17, docs/reviews/prompt-refinement-2026-09-13.md):
// the submission carries NO `kind`. Each lane writes its own file at a lane-bound
// path (`charter_extraction_<kind>`), the gate recovers the kind from the lane id,
// and the merge stamps it. Asking the lane to restate it only ever let the lane
// check itself, so the field and its purity refinement are both gone.
//
// The SECOND rule the owner asked for — a citation must carry the text it
// quotes — lands in TWO places, each at the boundary that owns it. This gate owns
// the case that is unverifiable by construction: a ref that names a SPAN inside
// its file (a `#symbol` anchor or a line suffix) and carries no quote. It
// deliberately accepts a quoteless BARE path, because `charterPackets.ts` delivers
// some files to the structural lane as a path in the file tree with no excerpt at
// all, and for those the bare path is the lane's only honest citation
// (`citationGrounding.ts` says so; `tests/shared/citation-grounding.test.ts` pins
// it). Telling that case from a lane that declined to copy an excerpt it WAS
// handed needs the packet manifest, which this gate does not hold, so that half
// lives in `checkLaneCitations`.
import { describe, it, expect } from "vitest";
import { charterLaneSchema } from "../../src/audit/cli/laneValidators.js";

const repoFiles = new Set(["src/a.ts", "docs/goals.md"]);

function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: "top",
    purpose: "keep every promise the service gives a customer",
    provenance: [
      { kind: "code", ref: "src/a.ts#Top", quote: "class Top {" },
    ],
    confidence: "high",
    ...over,
  };
}

describe("charterLaneSchema — the lane submission carries no `kind`", () => {
  it("accepts a submission with nodes and edges only", () => {
    const parsed = charterLaneSchema(repoFiles).safeParse({
      nodes: [node(), node({ node_id: "leaf" })],
      edges: [
        {
          from: "leaf",
          to: "top",
          provenance: [
            { kind: "code", ref: "src/a.ts#serve", quote: "function serve(" },
          ],
        },
      ],
    });
    expect(
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
      "obedience must be SUFFICIENT — the prompt asks for nodes and edges only",
    ).toBe("");
  });

  it("refuses a submission that still states its own kind, by name", () => {
    // Strict, so the retired field is refused LOUDLY rather than ignored. A
    // silently accepted `kind` would leave two answers to "which lane is this",
    // and the tool's answer is the bound path.
    const parsed = charterLaneSchema(repoFiles).safeParse({
      kind: "stated",
      nodes: [node()],
    });
    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toContain("kind");
  });

  it("still refuses a node citing a file outside the repo, and names the file", () => {
    // The scope-grounding refinement is the one rule that survived the `kind`
    // removal. Without this the first test could pass against a schema whose
    // superRefine was dropped with the parameter it used to take.
    const parsed = charterLaneSchema(repoFiles).safeParse({
      nodes: [node({ files: ["src/a.ts", "src/gone.ts"] })],
    });
    expect(parsed.success).toBe(false);
    const message = parsed.success
      ? ""
      : parsed.error.issues.map((i) => i.message).join("; ");
    expect(message).toContain("src/gone.ts");
  });
});

describe("charterLaneSchema — a span citation must carry its quote", () => {
  function issuesFor(provenance: Record<string, unknown>[]): string {
    const parsed = charterLaneSchema(repoFiles).safeParse({
      nodes: [node({ provenance })],
    });
    return parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; ");
  }

  it("refuses a `#symbol` anchor with no quote, and names the ref", () => {
    expect(issuesFor([{ kind: "code", ref: "src/a.ts#Top" }])).toContain(
      'citation "src/a.ts#Top" names a span',
    );
  });

  it("refuses a LINE-suffixed ref with no quote", () => {
    // The prompt forbids a line number outright, so this form should never
    // arrive. It is refused anyway: a rule that reads the grammar must cover
    // every form the grammar parses, not only the form the prompt teaches.
    expect(issuesFor([{ kind: "code", ref: "src/a.ts:12-19" }])).toContain(
      "names a span",
    );
    expect(issuesFor([{ kind: "code", ref: "src/a.ts:12" }])).toContain(
      "names a span",
    );
  });

  it("refuses an EMPTY quote the same as a missing one", () => {
    expect(issuesFor([{ kind: "code", ref: "src/a.ts#Top", quote: "   " }])).toContain(
      "names a span",
    );
  });

  it("accepts a quoteless BARE path — the packet may have delivered it as a tree entry alone", () => {
    expect(issuesFor([{ kind: "code", ref: "src/a.ts" }])).toBe("");
  });

  it("leaves a non-path provenance kind alone, anchor or not", () => {
    // `intent_checkpoint`, `user_feedback` and `inferred` name no repository
    // path, so the span grammar does not apply and a quote cannot be demanded.
    expect(
      issuesFor([
        { kind: "intent_checkpoint", ref: "intent_checkpoint#scope_summary" },
        { kind: "user_feedback", ref: "session-2026-09-17#turn-4" },
        { kind: "inferred", ref: "no-single-source" },
      ]),
    ).toBe("");
  });

  it("checks EDGE provenance too, not nodes alone", () => {
    // An edge carries the same provenance array and the same claim. Checking
    // nodes only would leave half the citations in a submission unchecked.
    const parsed = charterLaneSchema(repoFiles).safeParse({
      nodes: [node()],
      edges: [
        {
          from: "top",
          to: "top",
          provenance: [{ kind: "code", ref: "src/a.ts#serve" }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.success ? undefined : parsed.error.issues[0];
    expect(issue?.path.join("."), "the issue must point at the EDGE").toBe(
      "edges.0.provenance.0.quote",
    );
  });
});
