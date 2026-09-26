import { test, expect } from "vitest";
import type { AnalyzerSetting } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const {
  advanceAudit,
} = await import("../../src/audit/orchestrator/advance.js");
const { computeArtifactMetadata } = await import(
  "../../src/audit/orchestrator/artifactMetadata.js"
);
const { computeStaleArtifacts } = await import(
  "../../src/audit/orchestrator/staleness.js"
);
const { deriveAuditState } = await import(
  "../../src/audit/orchestrator/state.js"
);
const { EXECUTOR_RUNNERS } = await import(
  "../../src/audit/orchestrator/executorRunners.js"
);
const { buildAdvancedBundle } = await import("./helpers/advancedBundle.mjs");
const { writeFixtureRepo } = await import("./helpers/fixture.mjs");
const { withTempDir } = await import("./helpers/withTempDir.mjs");
const { CHARTER_REGISTER_SCHEMA_VERSION } = await import(
  "../../src/audit/types/charterRegister.js"
);
const { EMPTY_REGISTER_BODY } = await import(
  "../helpers/charterRegisterFixture.js"
);

const SKIP_ANALYZERS: Record<string, AnalyzerSetting> = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

/**
 * Drive the full bundle up to (not through) charter extraction, then inject a
 * charter register and churn the manifest OUT of the charter slice so the
 * deferral state exists: structure_decomposition is stale-and-pending across a
 * whole-hash edge, while charter_register's slice-projected edges are unmoved —
 * so the staleness walk DEFERS charter rather than staling it.
 *
 * Returns a bundle whose ONLY actionable obligation is the stale
 * structure_decomposition_current, with charter_register held back as deferred.
 */
async function makeDeferredDrainBundle(root: string): Promise<ArtifactBundle> {
  // Everything up to structure_decomposition is fresh; charter_register is
  // absent. This drives the REAL deterministic stages (structure, graph
  // enrichment, design assessment, structure decomposition, docs digest, the
  // intent checkpoint + baseline) so every obligation before charter is
  // satisfied and stale-free.
  const advanced = await buildAdvancedBundle(root, "charter_extraction_current");

  // Inject a charter register at a deep ceiling (so charter_extraction is
  // actually owed rather than omitted) and stamp metadata so the slice edges
  // against structure_decomposition / repo_manifest / graph_bundle are
  // recorded.
  const withCharter: ArtifactBundle = {
    ...advanced,
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-07-23T00:00:00Z",
      target: "charter",
      ceiling: { rung: "deep" },
      status: "omitted",
      ...EMPTY_REGISTER_BODY,
    },
  };
  const stamped = computeArtifactMetadata(withCharter, withCharter.artifact_metadata, [
    "charter_register.json",
  ]);
  expect(
    stamped.artifacts["charter_register.json"]!.dependency_slices![
      "structure_decomposition.json"
    ],
    "the fixture only exercises a deferral if the slice edge was recorded",
  ).toBeDefined();

  // Churn the manifest in a region the charter slice does not read (a non-member
  // file's hash) — this leaves structure_decomposition stale across its
  // whole-hash edge while the charter slice is unmoved.
  const files = [...(withCharter.repo_manifest?.files ?? [])];
  const churned: ArtifactBundle = {
    ...withCharter,
    repo_manifest: {
      ...withCharter.repo_manifest!,
      generated_at: "2026-07-23T00:00:01Z",
      files: files.map((file) =>
        file.path === "package.json"
          ? { ...file, hash: `${file.hash ?? "package"}--CHANGED` }
          : file,
      ),
    },
  };
  const manifest = computeArtifactMetadata(churned, stamped, ["repo_manifest.json"]);
  const bundle: ArtifactBundle = { ...churned, artifact_metadata: manifest };

  // PREMISE: the drain sees a deferral — structure_decomposition stale, charter
  // held back (not stale, not satisfied-as-clean).
  const state = deriveAuditState(bundle, { emitStaleness: false });
  expect(
    state.obligations.find((o) => o.id === "structure_decomposition_current")
      ?.state,
    "structure_decomposition must be the stale-and-pending upstream",
  ).toBe("stale");
  expect(
    computeStaleArtifacts(bundle, { emit: false }).deferred,
    "charter_register must be deferred, not staled",
  ).toContain("charter_register.json");

  return bundle;
}

/** Swap in a stub runner for the duration of `fn`, then restore the real one. */
async function withStubbedRunner<T>(
  executor: string,
  stub: (typeof EXECUTOR_RUNNERS)[string],
  fn: () => Promise<T>,
): Promise<T> {
  const original = EXECUTOR_RUNNERS[executor];
  EXECUTOR_RUNNERS[executor] = stub;
  try {
    return await fn();
  } finally {
    EXECUTOR_RUNNERS[executor] = original!;
  }
}

test("the drain executes a deferred downstream before completing when the upstream slice it consumes moves", async () => {
  await withTempDir("deferred-drain-moved-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await makeDeferredDrainBundle(root);

    let structureRuns = 0;
    let charterRuns = 0;

    // The stale structure_decomposition re-derives and MOVES the consensus
    // memberships (the slice charter consumes), so charter is released as stale
    // and must execute within the SAME drain — before the drain completes.
    const result = await withStubbedRunner(
      "structure_decomposition_executor",
      async (bundleArg) => {
        structureRuns += 1;
        const b = bundleArg as ArtifactBundle;
        const consensus = [...(b.structure_decomposition?.consensus ?? [])];
        const moved = {
          ...b,
          structure_decomposition: {
            ...b.structure_decomposition!,
            consensus: [
              ...(consensus.length > 0
                ? [{
                    ...consensus[0]!,
                    members: [...(consensus[0]!.members ?? []), "src/new-member.ts"],
                  }]
                : []),
            ],
          },
        };
        return {
          updated: moved,
          artifacts_written: ["structure_decomposition.json"],
          progress_summary: "structure decomposition re-derived (slice moved)",
        };
      },
      () =>
        withStubbedRunner(
          "charter_extraction_executor",
          async (bundleArg) => {
            charterRuns += 1;
            return {
              updated: bundleArg,
              artifacts_written: ["charter_register.json"],
              progress_summary: "charter extraction re-ran",
            };
          },
          () => advanceAudit(bundle, { root, analyzers: SKIP_ANALYZERS }),
        ),
    );

    expect(structureRuns, "the stale upstream must execute").toBeGreaterThan(0);
    expect(
      charterRuns,
      "a moved slice must release the deferred downstream and execute it before the drain completes",
    ).toBeGreaterThan(0);
    // The drain reached a natural boundary (intent checkpoint / host delegation)
    // rather than silently suppressing charter: the artifact it wrote is present.
    expect(result.artifacts_written).toContain("charter_register.json");
  });
});

test("the drain does NOT execute a deferred downstream when the upstream slice is unchanged", async () => {
  await withTempDir("deferred-drain-unchanged-", async (root) => {
    await writeFixtureRepo(root);
    const bundle = await makeDeferredDrainBundle(root);

    let structureRuns = 0;
    let charterRuns = 0;

    // The stale structure_decomposition re-derives WITHOUT moving the consensus
    // slice, so charter stays satisfied (the deferral releases to "not stale")
    // and must NOT execute.
    const result = await withStubbedRunner(
      "structure_decomposition_executor",
      async (bundleArg) => {
        structureRuns += 1;
        return {
          updated: bundleArg,
          artifacts_written: ["structure_decomposition.json"],
          progress_summary: "structure decomposition re-derived (slice unchanged)",
        };
      },
      () =>
        withStubbedRunner(
          "charter_extraction_executor",
          async (bundleArg) => {
            charterRuns += 1;
            return {
              updated: bundleArg,
              artifacts_written: ["charter_register.json"],
              progress_summary: "charter extraction re-ran",
            };
          },
          () => advanceAudit(bundle, { root, analyzers: SKIP_ANALYZERS }),
        ),
    );

    expect(structureRuns, "the stale upstream must still execute").toBeGreaterThan(0);
    expect(
      charterRuns,
      "an unchanged slice must NOT re-fire the downstream it held back",
    ).toBe(0);
    expect(result.artifacts_written).not.toContain("charter_register.json");
  });
});

// The two drain-level tests above only distinguish "moved slice" from "unchanged
// slice" because the drain RE-DERIVES obligation state on a fresh bundle identity
// after every transition: the obligation-state memo (`deriveObligationState`) is
// keyed on bundle object identity, and `runSingleAdvanceStep` returns a newly
// constructed `finalizedBundle` at each transition. Remove either half — cache the
// derivation by obligation id, or return the carried bundle in place — and the
// deferred downstream stays "satisfied" forever: the "moved slice" test above goes
// red (charter never executes), which is exactly the suppression the deferral
// reporting exists to make visible. This test pins the refresh site in source so
// the drain-level pair cannot silently lose its red.
test("the drain's re-derivation rides on a per-bundle-identity memo (the bundle refresh)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const deriveSource = await readFile(
    join(here, "../../src/audit/orchestrator/obligationDerive.ts"),
    "utf8",
  );
  // The memo is keyed on bundle OBJECT IDENTITY, so a transition's fresh bundle
  // forces a re-derivation — a global/id-keyed cache would hide a released
  // deferral behind a stale "satisfied".
  expect(deriveSource).toMatch(/WeakMap<ArtifactBundle, AuditState>/);
  expect(deriveSource).toMatch(/cache\.set\(bundle, state\)/);

  const advanceSource = await readFile(
    join(here, "../../src/audit/orchestrator/advance.ts"),
    "utf8",
  );
  // The single-step primitive returns a freshly built bundle (never the carried
  // bundle in place), so the memo key changes and the next scan re-derives.
  expect(advanceSource).toMatch(/const finalizedBundle = \{ \.\.\.metadataBundle, audit_state: updatedState \}/);
});
