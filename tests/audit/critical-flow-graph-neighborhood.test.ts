import { test, expect } from "vitest";
import type { RepoManifest } from "../../src/audit/types.js";
import type { GraphBundle, SurfaceManifest } from "audit-tools/shared";

const { buildCriticalFlowManifest } = await import(
  "../../src/audit/extractors/flows.js"
);
const { buildRepoManifest } = await import(
  "../../src/audit/extractors/fileInventory.js"
);

function makeRepoManifest(paths: string[]): RepoManifest {
  return buildRepoManifest(
    "fixture-repo",
    paths.map((path, index) => ({ path, size_bytes: index + 1 })),
  );
}

// Dogfood defect: every "background" surface whose path matched a concurrency
// keyword (worker / job / lock / queue) was linked to EVERY async-task path in
// the repository, so unrelated entrypoints carried one shared path list marked
// high confidence. A flow's paths must come from its own entrypoint's graph
// neighborhood instead.
const FILES = [
  "src/audit/cli/workerResult.ts",
  "src/audit/contracts/workerSchemas.ts",
  "src/shared/tooling/windowsOwnedJob.ts",
  "src/shared/tooling/exec.ts",
  "src/shared/tooling/ownedProcessLifecycle.ts",
  "src/audit/clarification/voiQueue.ts",
  "src/shared/io/fileLock.ts",
];

const SURFACES: SurfaceManifest = {
  surfaces: [
    {
      id: "surface:src/audit/cli/workerResult.ts",
      kind: "background",
      entrypoint: "src/audit/cli/workerResult.ts",
    },
    {
      id: "surface:src/shared/tooling/windowsOwnedJob.ts",
      kind: "background",
      entrypoint: "src/shared/tooling/windowsOwnedJob.ts",
    },
    {
      id: "surface:src/audit/clarification/voiQueue.ts",
      kind: "background",
      entrypoint: "src/audit/clarification/voiQueue.ts",
    },
  ],
};

const GRAPH: GraphBundle = {
  graphs: {
    imports: [
      // workerResult imports workerSchemas.
      { from: "src/audit/cli/workerResult.ts", to: "src/audit/contracts/workerSchemas.ts" },
      // windowsOwnedJob imports nothing; exec and ownedProcessLifecycle import it.
      { from: "src/shared/tooling/exec.ts", to: "src/shared/tooling/windowsOwnedJob.ts" },
      {
        from: "src/shared/tooling/ownedProcessLifecycle.ts",
        to: "src/shared/tooling/windowsOwnedJob.ts",
      },
    ],
    // A prose mention is not a structural neighbor.
    references: [
      { from: "src/audit/clarification/voiQueue.ts", to: "src/shared/io/fileLock.ts" },
    ],
  },
};

function flowFor(manifest: ReturnType<typeof buildCriticalFlowManifest>, entry: string) {
  const flow = manifest.flows.find(
    (candidate) =>
      candidate.entrypoints[0] === entry && candidate.id.startsWith("flow:surface:"),
  );
  expect(flow).toBeTruthy();
  return flow!;
}

test("unrelated background entrypoints get their own graph neighborhood, not one shared keyword path set", () => {
  const manifest = buildCriticalFlowManifest(
    makeRepoManifest(FILES),
    SURFACES,
    undefined,
    { graphBundle: GRAPH },
  );

  const worker = flowFor(manifest, "src/audit/cli/workerResult.ts");
  const job = flowFor(manifest, "src/shared/tooling/windowsOwnedJob.ts");
  const queue = flowFor(manifest, "src/audit/clarification/voiQueue.ts");

  expect(worker.paths).toEqual([
    "src/audit/cli/workerResult.ts",
    "src/audit/contracts/workerSchemas.ts",
  ]);
  expect(job.paths).toEqual([
    "src/shared/tooling/exec.ts",
    "src/shared/tooling/ownedProcessLifecycle.ts",
    "src/shared/tooling/windowsOwnedJob.ts",
  ]);
  expect(worker.paths).not.toEqual(job.paths);

  // Graph-corroborated neighborhoods earn high confidence; an entrypoint with
  // no structural neighbor does not, and the manifest asks for the fallback.
  expect(worker.confidence).toBe("high");
  expect(job.confidence).toBe("high");
  expect(queue.confidence).toBe("low");
  expect(manifest.fallback_required).toBe(true);
});

test("a graph with no import/call edge for an entrypoint keeps its keyword evidence at low confidence", () => {
  // voiQueue has only a prose `references` mention; the migration is a file no
  // import graph links. Each falls back to keyword linking, never to its bare
  // entrypoint alone.
  const files = [...FILES, "db/migrations/001_session_tokens.sql", "src/auth/session.ts"];
  const manifest = buildCriticalFlowManifest(
    makeRepoManifest(files),
    SURFACES,
    undefined,
    { graphBundle: GRAPH },
  );

  const queue = flowFor(manifest, "src/audit/clarification/voiQueue.ts");
  expect(queue.paths).toContain("src/audit/clarification/voiQueue.ts");
  expect(queue.paths).toContain("src/shared/tooling/windowsOwnedJob.ts");
  expect(queue.confidence).toBe("low");

  const migration = manifest.flows.find(
    (flow) => flow.entrypoints[0] === "db/migrations/001_session_tokens.sql",
  );
  expect(migration, "a migration still gets a data flow").toBeTruthy();
  expect(migration!.paths).toContain("src/auth/session.ts");
  expect(migration!.confidence).toBe("low");
});

test("without a dependency graph, keyword-only linking is never high confidence", () => {
  const manifest = buildCriticalFlowManifest(makeRepoManifest(FILES), SURFACES);
  for (const flow of manifest.flows) {
    expect(flow.confidence).toBe("low");
  }
  expect(manifest.fallback_required).toBe(true);
});
