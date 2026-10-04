import { expect, test } from "vitest";
import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { charterExtractionPacketFilename } from "../../src/audit/cli/laneSubmissions.js";
import { charterLaneSchema } from "../../src/audit/cli/laneValidators.js";

test("each charter example uses only its lane's evidence class and passes the real validator", () => {
  for (const kind of ["stated", "structural", "revealed"] as const) {
    const prompt = renderCharterKindLanePrompt({ kind, packetPath: `/repo/${charterExtractionPacketFilename(kind)}`, submissionPath: "/repo/result.json" });
    const example = JSON.parse(prompt.match(/```json\s*([\s\S]*?)```/)![1]!);
    expect(charterLaneSchema(new Set(["README.md", "src/scheduling/promise.ts", "src/scheduling/window.ts", "src/scheduling/fleet.ts"]), kind).safeParse(example).success).toBe(true);
    const citations = [...example.nodes, ...example.edges].flatMap((item: { provenance: Array<{ ref: string; quote: string }> }) => item.provenance);
    if (kind === "stated") expect(citations.every(citation => citation.ref === "README.md" && !citation.quote.includes("class "))).toBe(true);
    if (kind === "structural") expect(citations.every(citation => /^(class |import )/.test(citation.quote))).toBe(true);
    if (kind === "revealed") expect(citations.every(citation => /^(return |if )/.test(citation.quote))).toBe(true);
  }
});
