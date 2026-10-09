import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { prepareConceptualDispatch } from "../../src/audit/cli/conceptualDispatch.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("deep conceptual dispatch preserves required independence", () => {
  it("never advertises self-review or degraded fallback and agrees with bound lanes on unavailable review", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "deep-guidance-"));
    roots.push(artifactsDir);
    const dispatch = await prepareConceptualDispatch({ artifactsDir, sourceRoot: artifactsDir, bundle: {} as ArtifactBundle, settings: { conceptual_depth: "deep", perspectives: 2 } });
    const text = dispatch.instructionLines.join("\n");
    expect(text).not.toMatch(/sequentially yourself|execute it yourself|explicitly-degraded fallback/);
    expect(text).toContain("sequentially in independent contexts");
    expect(text).toContain("When all 2 perspectives have written their findings");
    expect(text).toContain("unavailable declaration");
    expect(text).toContain("pause");
    for (const key of ["conceptual_perspective_1_prompt", "conceptual_judge_prompt"]) {
      const lane = await readFile(dispatch.artifactPaths[key]!, "utf8");
      expect(lane).toContain("return an unavailable declaration");
      expect(lane).toContain("degraded or unavailable cannot satisfy it");
    }
  });
});
