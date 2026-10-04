// A blind charter lane DECLARES its inputs, and the lane gate checks the
// declaration. Since #14 a charter step also carries a scoped-inspection
// workload; a prompt sentence alone kept blind readers apart from it. The
// separation is now a property of the submission: `inputs` must name exactly
// the lane's own evidence packet.
import { describe, expect, it } from "vitest";
import { charterLaneSchema } from "../../src/audit/cli/laneValidators.js";
import { charterExtractionPacketFilename } from "../../src/audit/cli/laneSubmissions.js";

const repoFiles = new Set(["src/a.ts"]);
const dag = {
  nodes: [
    {
      node_id: "top",
      purpose: "keep every promise the service gives a customer",
      provenance: [{ kind: "code", ref: "src/a.ts#Top", quote: "class Top {" }],
      confidence: "high",
    },
  ],
  edges: [],
};
const ownPacket = (kind: "stated" | "structural" | "revealed") =>
  `/repo/.audit-tools/audit/lane-assets/${charterExtractionPacketFilename(kind)}`;

describe("charter blind-lane inputs declaration", () => {
  it("refuses a submission with no inputs declaration", () => {
    expect(charterLaneSchema(repoFiles, "structural").safeParse(dag).success).toBe(false);
  });

  it("refuses an empty inputs declaration", () => {
    expect(charterLaneSchema(repoFiles, "structural").safeParse({ ...dag, inputs: [] }).success).toBe(false);
  });

  it("refuses a declaration that names the scoped-inspection workload", () => {
    const parsed = charterLaneSchema(repoFiles, "structural").safeParse({
      ...dag,
      inputs: [ownPacket("structural"), "/repo/.audit-tools/audit/dispatch/host-workload.json"],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses another lane's packet", () => {
    expect(
      charterLaneSchema(repoFiles, "structural").safeParse({ ...dag, inputs: [ownPacket("revealed")] }).success,
    ).toBe(false);
  });

  it("accepts a declaration naming exactly the lane's own packet", () => {
    const parsed = charterLaneSchema(repoFiles, "structural").safeParse({
      ...dag,
      inputs: [ownPacket("structural").replaceAll("/", "\\")],
    });
    expect(parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe("");
  });
});
