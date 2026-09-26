/**
 * Packet 4: an explicitly named reviewer set chooses deep review when the
 * operator leaves depth unspecified. The broader selection/provenance contract
 * is covered by conceptual-review-selection.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import {
  prepareConceptualDispatch,
  resolveConceptualReviewSettings,
} from "../../src/audit/cli/conceptualDispatch.js";

const CONFIRMED_AT = "2026-09-19T00:00:00Z";

function bundleWithReview(review: Record<string, unknown>): ArtifactBundle {
  return {
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: CONFIRMED_AT,
      confirmed_by: "host",
      scope_summary: "src only",
      intent_summary: "full audit",
      design_review: { answered_at: CONFIRMED_AT, ...review },
    },
  } as ArtifactBundle;
}

describe("bound conceptual review selection", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  async function artifactsDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "packet-4-named-"));
    cleanups.push(root);
    const dir = join(root, ".audit-tools", "audit");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("a named list without depth dispatches exactly the named deep-review lanes on resume", async () => {
    const dir = await artifactsDir();
    const bundle = bundleWithReview({ perspectives: ["Minimalist", "Adversary"] });
    const firstSettings = resolveConceptualReviewSettings(bundle);
    expect(firstSettings.conceptual_depth).toBe("deep");
    expect(firstSettings.perspectives).toEqual(["Minimalist", "Adversary"]);
    expect(firstSettings.reuse_notice).toContain("conceptual depth deep");

    const first = await prepareConceptualDispatch({ artifactsDir: dir, bundle, settings: firstSettings });
    expect(first.deep).toBe(true);
    const manifest = JSON.parse(await readFile(first.artifactPaths.conceptual_round_manifest, "utf8"));
    expect(manifest.perspectives.map((p: { perspective: string }) => p.perspective)).toEqual([
      "Minimalist",
      "Adversary",
    ]);

    const resumedSettings = resolveConceptualReviewSettings(bundle);
    const resumed = await prepareConceptualDispatch({ artifactsDir: dir, bundle, settings: resumedSettings });
    expect(resumed.deep).toBe(true);
    expect(resumed.readPaths).toEqual(first.readPaths);
    expect(resumed.writePaths).toEqual(first.writePaths);
  });

  it("an explicit shallow depth wins while retaining the named choice", () => {
    const settings = resolveConceptualReviewSettings(
      bundleWithReview({ conceptual_depth: "shallow", perspectives: ["Adversary"] }),
    );
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toEqual(["Adversary"]);
  });

  it("a legacy count without depth keeps the shallow default", () => {
    const settings = resolveConceptualReviewSettings(bundleWithReview({ perspectives: 3 }));
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toBe(3);
  });
});
