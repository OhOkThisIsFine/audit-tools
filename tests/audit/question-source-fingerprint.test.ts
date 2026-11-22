import { expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildReviewQuestionPlan, reviewSourceScope } from "../../src/audit/orchestrator/questionPlanning.js";

it("distinguishes unavailable source from fingerprinted small entrypoints", () => {
  const missing = "src/unavailable.ts";
  const small = "src/tiny.ts";
  const bundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "fingerprints" }, generated_at: "x",
      files: [
        { path: missing, language: "typescript", size_bytes: 0 },
        { path: small, language: "typescript", size_bytes: 1, hash: "tiny-fingerprint" },
      ],
    },
    file_disposition: { files: [missing, small].map(path => ({ path, status: "included" })) },
    surface_manifest: { surfaces: [
      { id: "unavailable", kind: "interface", entrypoint: missing },
      { id: "small", kind: "interface", entrypoint: small },
    ] },
  };
  const scope = reviewSourceScope(bundle);
  expect(scope.allowedSourcePaths).toEqual([small]);
  expect(scope.sourceStatus(missing)).toMatch(/fingerprint/i);
  const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot" });
  expect(plan.omissions).toContainEqual(expect.objectContaining({
    surface_id: "unavailable", reason: expect.stringMatching(/fingerprint/i),
  }));
  expect(plan.questions.some(question => question.source_dependencies.some(dependency =>
    dependency.kind === "source" && dependency.key === small && dependency.fingerprint === "tiny-fingerprint",
  ))).toBe(true);
  expect(plan.questions.every(question => question.source_dependencies.every(dependency =>
    dependency.kind !== "source" || dependency.key !== missing,
  ))).toBe(true);
});
