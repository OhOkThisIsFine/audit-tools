// Packet 11 (prompt migrations — O03 P2). Pins the lane-specific charter
// examples against their real validator, the triage `halt` whole-run semantics
// and closed id set, the extracted-plan repair driver shape, and the
// analyzer-install decision-maker naming.
//
// Each pin is a REAL-validator render: an example the host copies must satisfy
// the schema the tool enforces (obedience has to be SUFFICIENT), and the lane's
// evidence channel must be the one its kind actually receives — never a
// shared code-looking example (P2.5).
import { describe, it, expect } from "vitest";

import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { CharterSubmissionSchema } from "../../src/shared/decompose/charterExtraction.js";
import { CharterProvenanceSchema } from "../../src/shared/types/charter.js";
import { renderAnalyzerInstallPrompt } from "../../src/audit/cli/prompts.js";
import { triagePrompt } from "../../src/remediate/steps/prompts.js";
import type { RemediationState } from "../../src/remediate/state/store.js";

function charterExample(kind: "stated" | "structural" | "revealed"): string {
  const prompt = renderCharterKindLanePrompt({
    kind,
    submissionPath: "x/submission.json",
    packetPath: "x/packet.json",
  });
  const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
  expect(fence, `${kind}: the lane prompt must carry a fenced JSON example`).not.toBeNull();
  return fence![1]!;
}

describe("packet 11: lane-specific charter examples are valid and channel-correct", () => {
  it("each lane's example satisfies CharterSubmissionSchema", () => {
    for (const kind of ["stated", "structural", "revealed"] as const) {
      const parsed = CharterSubmissionSchema.safeParse(JSON.parse(charterExample(kind)));
      expect(
        parsed.success ? null : parsed.error.issues,
        `${kind}: a submission copied verbatim must satisfy CharterSubmissionSchema`,
      ).toBeNull();
    }
  });

  it("stated cites doc/comment testimony only, never a code symbol or body", () => {
    const example = JSON.parse(charterExample("stated")) as {
      nodes: Array<{ provenance: Array<{ kind: string; ref: string; quote?: string }>; files?: string[] }>;
      edges: Array<{ provenance: Array<{ kind: string; ref: string; quote?: string }> }>;
    };
    // Stated lane omits `files` (scope follows testimony, not the file tree).
    for (const node of example.nodes) {
      expect(node.files, "stated example must not declare a files scope").toBeUndefined();
      for (const citation of node.provenance) {
        expect(citation.kind, "stated cites testimony").toMatch(/^(doc|comment)$/);
        // The doc citation names a doc, never a code symbol; the comment
        // citation may name the source file it was extracted from.
        if (citation.kind === "doc") {
          expect(citation.ref, "a doc citation names a doc, not a code symbol").not.toContain(".ts");
        }
      }
    }
    for (const edge of example.edges) {
      for (const citation of edge.provenance) {
        expect(citation.kind, "stated edge cites testimony").toBe("doc");
      }
    }
  });

  it("structural cites code declarations, revealed cites code behavior", () => {
    const structural = JSON.parse(charterExample("structural")) as {
      nodes: Array<{ files?: string[]; provenance: Array<{ kind: string; quote?: string }> }>;
    };
    const revealed = JSON.parse(charterExample("revealed")) as {
      nodes: Array<{ files?: string[]; provenance: Array<{ kind: string; quote?: string }> }>;
    };
    for (const node of structural.nodes) {
      expect(node.files?.length ?? 0, "structural example declares a files scope").toBeGreaterThan(0);
      for (const citation of node.provenance) {
        expect(citation.kind, "structural cites code declarations").toBe("code");
        expect(citation.quote, "structural quote is a declaration line").toMatch(/\b(class|interface|function|const|export)\b/);
      }
    }
    for (const node of revealed.nodes) {
      expect(node.files?.length ?? 0, "revealed example declares a files scope").toBeGreaterThan(0);
      for (const citation of node.provenance) {
        expect(citation.kind, "revealed cites code behavior").toBe("code");
        expect(citation.quote, "revealed quote is a behavior/body line").toMatch(/rebookOnMiss/);
      }
    }
  });

  it("every provenance kind in the example literal is schema-admissible", () => {
    const allowed = new Set(CharterProvenanceSchema.shape.kind.options);
    for (const kind of ["stated", "structural", "revealed"] as const) {
      const example = JSON.parse(charterExample(kind)) as {
        nodes: Array<{ provenance: Array<{ kind: string }> }>;
        edges: Array<{ provenance: Array<{ kind: string }> }>;
      };
      for (const node of example.nodes) {
        for (const citation of node.provenance) {
          expect(allowed, `${kind}: provenance kind '${citation.kind}'`).toContain(citation.kind);
        }
      }
    }
  });
});

describe("packet 11: analyzer-install prompt names the operator", () => {
  it("asks the operator to choose, never a bare choose", () => {
    const prompt = renderAnalyzerInstallPrompt({
      unresolved: [{ id: "eslint", spec: "eslint", supportedCount: 3 } as never],
      decisionsPath: "x/decisions.json",
      continueCommand: "audit-code next-step",
    });
    expect(prompt).toContain("Ask the operator");
    expect(prompt).toContain("Do not make package installation decisions");
    expect(prompt).toContain("without operator confirmation");
    // The closed choice set is rendered, never an open alternation.
    expect(prompt).toContain('`"ephemeral"` | `"permanent"` | `"skip"`');
    expect(prompt).not.toMatch(/\|\s*\.\.\./u);
  });
});

describe("packet 11: triage prompt states halt semantics and the closed id set", () => {
  function state(ids: string[], reasons: string[]): RemediationState {
    return {
      status: "waiting_for_triage",
      items: Object.fromEntries(
        ids.map((id, i) => [
          id,
          { finding_id: id, status: "blocked", failure_reason: reasons[i] },
        ]),
      ),
      plan: {
        findings: ids.map((id) => ({ id })),
      },
    } as unknown as RemediationState;
  }

  it("explains halt stops the WHOLE run and omitted items stay unresolved", () => {
    const prompt = triagePrompt(state(["F-1", "F-2"], ["a", "b"]), "x/triage_resolution.json");
    expect(prompt).toContain("stops the WHOLE run");
    expect(prompt).toContain("abandoned");
    expect(prompt).toContain("partial report");
    // Omitted items are re-presented, never silently dropped.
    expect(prompt).toContain("stays unresolved and is re-presented");
    expect(prompt).toContain("never silently dropped");
  });

  it("renders the closed set of blocked finding ids and uses a real id in the example", () => {
    const prompt = triagePrompt(state(["F-1", "F-2"], ["a", "b"]), "x/triage_resolution.json");
    expect(prompt).toContain("`F-1`, `F-2`");
    expect(prompt).toContain('"finding_id": "F-1"');
    // The example must not carry a `...` placeholder id.
    expect(prompt).not.toContain('"finding_id": "..."');
    expect(prompt).toContain("retry");
    expect(prompt).toContain("ignore");
    expect(prompt).toContain("halt");
  });
});
