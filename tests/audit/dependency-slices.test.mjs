// The charter dependency-slice layer: projections (contract-pinned), the
// metadata stamping terms, and the staleness slice compare that replaces the
// whole-hash disjunction on projected edges.
import { test, expect } from "vitest";

const {
  DEPENDENCY_SLICE_PROJECTIONS,
  computeDependencySliceHash,
  hasDependencySliceProjection,
  buildDependencySlices,
  SLICE_PROJECTION_ERROR,
} = await import("../../src/audit/orchestrator/dependencySlices.ts");
const { computeArtifactMetadata } = await import(
  "../../src/audit/orchestrator/artifactMetadata.ts"
);
const { computeStaleArtifacts } = await import(
  "../../src/audit/orchestrator/staleness.ts"
);
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.ts"
);

function makeBundle(over = {}) {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-07-23T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "ts", size_bytes: 10, hash: "hash-a" },
        { path: "src/b.ts", language: "ts", size_bytes: 20, hash: "hash-b" },
        { path: "README.md", language: "md", size_bytes: 5, hash: "hash-doc" },
        { path: "big/blob.ts", language: "ts", size_bytes: 2_000_000 },
        // A plain code file that is neither a consensus member nor a doc —
        // its CONTENT churn is the out-of-slice case throughout this suite.
        { path: "src/zz.ts", language: "ts", size_bytes: 9, hash: "hash-zz" },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "src/b.ts", status: "included" },
        { path: "README.md", status: "doc_only" },
        { path: "big/blob.ts", status: "included" },
        { path: "src/zz.ts", status: "included" },
      ],
    },
    structure_decomposition: {
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/b.ts", "src/a.ts", "big/blob.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
    },
    ...over,
  };
}

test("the registry is contract-pinned: exactly charter_register's two edges", () => {
  expect(Object.keys(DEPENDENCY_SLICE_PROJECTIONS).sort()).toEqual([
    "charter_register.json",
  ]);
  expect(
    Object.keys(DEPENDENCY_SLICE_PROJECTIONS["charter_register.json"]).sort(),
  ).toEqual(["repo_manifest.json", "structure_decomposition.json"]);
  expect(
    hasDependencySliceProjection("charter_register.json", "intent_checkpoint.json"),
  ).toBe(false);
  expect(
    computeDependencySliceHash("systemic_challenge.json", "repo_manifest.json", makeBundle()),
  ).toBeUndefined();
});

test("repo slice ignores non-member/non-doc CONTENT churn; fires on member content, doc content, membership, path-set changes, and oversized-file size", () => {
  const base = makeBundle();
  const hash = (bundle) =>
    computeDependencySliceHash("charter_register.json", "repo_manifest.json", bundle);
  const baseHash = hash(base);

  // CONTENT churn on the non-member, non-doc file with the path set constant —
  // the live phantom-staleness driver — stays quiet.
  const zzChurned = makeBundle();
  zzChurned.repo_manifest = {
    ...base.repo_manifest,
    files: base.repo_manifest.files.map((f) =>
      f.path === "src/zz.ts" ? { ...f, hash: "hash-zz-CHANGED" } : f,
    ),
  };
  expect(hash(zzChurned)).toBe(baseHash);

  // A path-set change (add/delete/rename) FIRES — the delta pass grounds
  // findings against the complete path set (reviewer F1).
  const added = makeBundle();
  added.repo_manifest = {
    ...base.repo_manifest,
    files: [
      ...base.repo_manifest.files,
      { path: "src/new.ts", language: "ts", size_bytes: 7, hash: "hash-new" },
    ],
  };
  expect(hash(added)).not.toBe(baseHash);
  const removed = makeBundle();
  removed.repo_manifest = {
    ...base.repo_manifest,
    files: base.repo_manifest.files.filter((f) => f.path !== "src/zz.ts"),
  };
  expect(hash(removed)).not.toBe(baseHash);

  // A member file's content hash moved.
  const memberChanged = makeBundle();
  memberChanged.repo_manifest = {
    ...base.repo_manifest,
    files: base.repo_manifest.files.map((f) =>
      f.path === "src/b.ts" ? { ...f, hash: "hash-b2" } : f,
    ),
  };
  expect(hash(memberChanged)).not.toBe(baseHash);

  // A doc_only file's content moved (the Stated pass reads docs — Codex #3).
  const docChanged = makeBundle();
  docChanged.repo_manifest = {
    ...base.repo_manifest,
    files: base.repo_manifest.files.map((f) =>
      f.path === "README.md" ? { ...f, hash: "hash-doc2" } : f,
    ),
  };
  expect(hash(docChanged)).not.toBe(baseHash);

  // An UNHASHED oversized member changed size (Codex #4: size proxies content).
  const bigChanged = makeBundle();
  bigChanged.repo_manifest = {
    ...base.repo_manifest,
    files: base.repo_manifest.files.map((f) =>
      f.path === "big/blob.ts" ? { ...f, size_bytes: 2_000_001 } : f,
    ),
  };
  expect(hash(bigChanged)).not.toBe(baseHash);

  // Membership changed (cross-artifact sensitivity).
  const membership = makeBundle();
  membership.structure_decomposition = {
    consensus: [
      {
        node_id: "src/a.ts",
        members: ["src/a.ts"],
        agreed_across_source: 1,
        stable_across_scale: 1,
        contested: false,
      },
    ],
    contested: [],
  };
  expect(hash(membership)).not.toBe(baseHash);
});

test("structure slice ignores score churn, fires on membership; member order is canonical", () => {
  const base = makeBundle();
  const hash = (bundle) =>
    computeDependencySliceHash(
      "charter_register.json",
      "structure_decomposition.json",
      bundle,
    );
  const baseHash = hash(base);

  const scoresOnly = makeBundle();
  scoresOnly.structure_decomposition = {
    consensus: [
      {
        ...base.structure_decomposition.consensus[0],
        agreed_across_source: 0.5,
        stable_across_scale: 0.25,
      },
    ],
    contested: [{ node_id: "noise", members: [] }],
  };
  // Contested nodes are deliberately outside the slice: the charter path
  // grounds ONLY on consensus, so a contested-only change does not re-fire.
  expect(hash(scoresOnly)).toBe(baseHash);

  const reordered = makeBundle();
  reordered.structure_decomposition = {
    consensus: [
      {
        ...base.structure_decomposition.consensus[0],
        members: ["big/blob.ts", "src/a.ts", "src/b.ts"],
      },
    ],
    contested: [],
  };
  expect(hash(reordered)).toBe(baseHash);
});

test("a throwing projection returns the error sentinel; buildDependencySlices skips it", () => {
  const malformed = makeBundle();
  malformed.structure_decomposition = { consensus: [{ node_id: "x" }] };
  expect(
    computeDependencySliceHash(
      "charter_register.json",
      "structure_decomposition.json",
      malformed,
    ),
  ).toBe(SLICE_PROJECTION_ERROR);
  const slices = buildDependencySlices(
    "charter_register.json",
    ["structure_decomposition.json"],
    malformed,
  );
  expect(slices).toBeUndefined();
});

test("staleness: a slice-recorded charter edge ignores out-of-slice manifest churn but fires on member change", () => {
  const bundle = makeBundle({
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-07-23T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "full-audit",
    },
    charter_register: { schema_version: "charter-register/v1", status: "omitted", subsystems: [], generated_at: "2026-07-23T00:00:00Z" },
  });
  // Stamp with charter_register LISTED so dependency_slices record.
  const manifest = computeArtifactMetadata(
    bundle,
    {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {},
    },
    [
      "repo_manifest.json",
      "file_disposition.json",
      "structure_decomposition.json",
      "intent_checkpoint.json",
      "charter_register.json",
    ],
  );
  const entry = manifest.artifacts["charter_register.json"];
  expect(entry.dependency_slices["repo_manifest.json"]).toBeDefined();
  expect(entry.dependency_slices["structure_decomposition.json"]).toBeDefined();
  expect(entry.dependency_slices["intent_checkpoint.json"]).toBeUndefined();

  // Out-of-slice churn: the non-member/non-doc file's CONTENT hash moves with
  // the path set unchanged — repo_manifest's own canonical hash DOES move
  // (structure re-stales via its whole-hash edge), but the charter slice does
  // not: this is the live incident's exact shape.
  const churned = {
    ...bundle,
    artifact_metadata: manifest,
    repo_manifest: {
      ...bundle.repo_manifest,
      files: bundle.repo_manifest.files.map((f) =>
        f.path === "src/zz.ts" ? { ...f, hash: "hash-zz-CHANGED" } : f,
      ),
    },
  };
  // Restamp the manifest for the churned repo_manifest (listed re-extraction)
  // so the repo entry itself is consistent — the charter edge still compares
  // against its RECORDED slice.
  const churnedManifest = computeArtifactMetadata(churned, manifest, [
    "repo_manifest.json",
  ]);
  const stale = computeStaleArtifacts(
    { ...churned, artifact_metadata: churnedManifest },
    { emit: false },
  );
  expect(stale.has("charter_register.json")).toBe(false);

  // In-slice change: a member file's hash moved.
  const memberChanged = {
    ...bundle,
    repo_manifest: {
      ...bundle.repo_manifest,
      files: bundle.repo_manifest.files.map((f) =>
        f.path === "src/a.ts" ? { ...f, hash: "hash-a2" } : f,
      ),
    },
  };
  const memberManifest = computeArtifactMetadata(memberChanged, manifest, [
    "repo_manifest.json",
  ]);
  const staleAfterMember = computeStaleArtifacts(
    { ...memberChanged, artifact_metadata: memberManifest },
    { emit: false },
  );
  expect(staleAfterMember.has("charter_register.json")).toBe(true);
});

test("doc-extension files outside docs/ count as docs even when statused included (reviewer F2)", () => {
  const base = makeBundle();
  const hash = (bundle) =>
    computeDependencySliceHash("charter_register.json", "repo_manifest.json", bundle);
  const withSpec = (h) => {
    const bundle = makeBundle();
    bundle.repo_manifest = {
      ...base.repo_manifest,
      files: [
        ...base.repo_manifest.files,
        { path: "spec/design.rst", language: "rst", size_bytes: 4, hash: h },
      ],
    };
    bundle.file_disposition = {
      files: [
        ...base.file_disposition.files,
        { path: "spec/design.rst", status: "included" },
      ],
    };
    return bundle;
  };
  // Content churn on the .rst FIRES — it is in the doc set via the shared
  // doc predicate, not via doc_only status.
  expect(hash(withSpec("hash-spec"))).not.toBe(hash(withSpec("hash-spec2")));
});

test("deferred fire: propagation skip + upstream re-derive with CHANGED membership fires charter on the next pass", () => {
  const bundle = makeBundle({
    charter_register: { schema_version: "charter-register/v1", status: "omitted", subsystems: [], generated_at: "2026-07-23T00:00:00Z" },
  });
  const manifest = computeArtifactMetadata(
    bundle,
    { metadata_schema_version: METADATA_SCHEMA_VERSION, artifacts: {} },
    [
      "repo_manifest.json",
      "file_disposition.json",
      "structure_decomposition.json",
      "charter_register.json",
    ],
  );

  // Phase 1: membership CHANGES on disk but structure_decomposition has not
  // been restamped as a listed re-derive yet — the direct slice compare on
  // charter's structure edge already fires (recorded membership ≠ current).
  const membershipChanged = {
    ...bundle,
    artifact_metadata: manifest,
    structure_decomposition: {
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
    },
  };
  const staleNow = computeStaleArtifacts(membershipChanged, { emit: false });
  expect(staleNow.has("charter_register.json")).toBe(true);

  // Phase 2: after structure re-derives (listed restamp), charter STILL fires
  // until its own listed re-derive records the new slices — then it clears.
  const restamped = computeArtifactMetadata(membershipChanged, manifest, [
    "structure_decomposition.json",
  ]);
  const staleAfterUpstream = computeStaleArtifacts(
    { ...membershipChanged, artifact_metadata: restamped },
    { emit: false },
  );
  expect(staleAfterUpstream.has("charter_register.json")).toBe(true);

  const charterRederived = computeArtifactMetadata(
    membershipChanged,
    restamped,
    ["charter_register.json"],
  );
  const staleAfterCharter = computeStaleArtifacts(
    { ...membershipChanged, artifact_metadata: charterRederived },
    { emit: false },
  );
  expect(staleAfterCharter.has("charter_register.json")).toBe(false);
});

test("metadata: an unlisted mismatch-restamp preserves recorded slices verbatim", () => {
  const bundle = makeBundle({
    charter_register: { schema_version: "charter-register/v1", status: "omitted", subsystems: [], generated_at: "2026-07-23T00:00:00Z" },
  });
  const first = computeArtifactMetadata(
    bundle,
    { metadata_schema_version: METADATA_SCHEMA_VERSION, artifacts: {} },
    [
      "repo_manifest.json",
      "file_disposition.json",
      "structure_decomposition.json",
      "charter_register.json",
    ],
  );
  const recorded = first.artifacts["charter_register.json"].dependency_slices;

  // Mutate the register on disk WITHOUT listing it (the forgotten-listing case)
  // AND move the membership so a rebuild would produce different slices.
  const mutated = {
    ...bundle,
    charter_register: { ...bundle.charter_register, status: "present" },
    structure_decomposition: {
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
    },
  };
  const second = computeArtifactMetadata(mutated, first, []);
  expect(second.artifacts["charter_register.json"].dependency_slices).toEqual(
    recorded,
  );
});
