// Design-gate red test for the charter-layer redesign (spec/conceptual-design-review-design.md
// §"The estimator charters", step 1; decision record docs/reviews/charter-redesign-feedback-2026-09-15.md).
//
// A blind lane submits ONE goal DAG: nodes with a lane-minted local `node_id`, edges meaning
// `from` SERVES `to` with their own provenance, and `files` OPTIONAL (the Stated lane cites
// provenance only). Today `CharterSubmissionSchema` is a flat node list with `files.min(1)`,
// no `node_id`, and no `edges` — so this parse fails until the redesign lands.
import { test, expect, describe } from "vitest";
import { CharterSubmissionSchema } from "../../src/shared/decompose/charterExtraction.js";

describe("charter lane submission — one goal DAG per lane (redesign step 1)", () => {
  test("a Stated-lane DAG with edges and a provenance-only node parses", () => {
    const result = CharterSubmissionSchema.safeParse({
      kind: "stated",
      nodes: [
        {
          node_id: "trustworthy-audits",
          purpose: "Audit findings stay trustworthy even when the host agent is weak",
          provenance: [{ kind: "doc", ref: "docs/project-philosophy.md#Product", quote: "trustworthy even when the host agent is weak" }],
          confidence: "high",
        },
        {
          node_id: "quota-fairness",
          purpose: "Independent audit workers share provider quotas without starving security checks",
          provenance: [{ kind: "doc", ref: "docs/dispatch.md:12", quote: "no lens is starved" }],
          confidence: "medium",
        },
      ],
      edges: [
        {
          from: "quota-fairness",
          to: "trustworthy-audits",
          provenance: [{ kind: "doc", ref: "docs/dispatch.md:14", quote: "so that every lens completes" }],
        },
      ],
    });
    expect(result.success, JSON.stringify(result.success ? null : result.error.issues)).toBe(true);
  });
});
