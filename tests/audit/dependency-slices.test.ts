import { REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
// The charter dependency-slice layer: projections (contract-pinned), the
// metadata stamping terms, and the staleness slice compare that replaces the
// whole-hash disjunction on projected edges.
import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { StructureDecomposition } from "../../src/audit/types/structureDecomposition.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import type { DecomposedNode } from "audit-tools/shared";

const {
  DEPENDENCY_SLICE_PROJECTIONS,
  computeDependencySliceHash,
  hasDependencySliceProjection,
  buildDependencySlices,
  SLICE_PROJECTION_ERROR,
} = await import("../../src/audit/orchestrator/dependencySlices.js");
const { computeArtifactMetadata } = await import(
  "../../src/audit/orchestrator/artifactMetadata.js"
);
const {
  computeStaleArtifacts,
  StaleArtifactSet,
  deferredArtifactsOf,
  describeStalenessRecovery,
  emitStalenessRecord,
} = await import("../../src/audit/orchestrator/staleness.js");
const { ARTIFACT_DEPENDS_ON_MAP, ALL_DAG_ARTIFACTS } = await import(
  "../../src/audit/orchestrator/dependencyMap.js"
);
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.js"
);
const { CHARTER_REGISTER_SCHEMA_VERSION } = await import(
  "../../src/audit/types/charterRegister.js"
);

/** A full-shape consensus/contested node, defaults matching the base fixture's sole member. */
function consensusNode(over: Partial<DecomposedNode> = {}): DecomposedNode {
  return {
    node_id: "src/a.ts",
    members: ["src/b.ts", "src/a.ts", "big/blob.ts"],
    agreed_across_source: 1,
    stable_across_scale: 1,
    contested: false,
    ...over,
  };
}

/** A full-shape `structure_decomposition.json` — only `consensus`/`contested` vary across tests. */
function makeStructureDecomposition(
  over: Partial<StructureDecomposition> = {},
): StructureDecomposition {
  return {
    generated_at: "2026-07-23T00:00:00Z",
    target: "structure",
    node_universe_size: 5,
    source_ids: ["source-a"],
    consensus: [consensusNode()],
    contested: [],
    findings: [],
    ...over,
  };
}

/** A full-shape `charter_register.json` in its "omitted" (no charter layer requested) form. */
function makeCharterRegister(over: Partial<CharterRegister> = {}): CharterRegister {
  return {
    schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
    generated_at: "2026-07-23T00:00:00Z",
    target: "charter",
    ceiling: { rung: "deep" },
    status: "omitted",
    subsystems: [],
    goal_graph: { nodes: [], edges: [] },
    deltas: [],
    findings: [],
    triangulated: [],
    disagreement: [],
    validation_issues: [],
    ...REGISTER_V4_AFFIRMATION,
    ...over,
  };
}

function makeBundle(over: Partial<ArtifactBundle> = {}): ArtifactBundle {
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
    structure_decomposition: makeStructureDecomposition(),
    ...over,
  };
}

test("the registry is contract-pinned: exactly charter_register's three edges", () => {
  expect(Object.keys(DEPENDENCY_SLICE_PROJECTIONS).sort()).toEqual([
    "charter_register.json",
  ]);
  // graph_bundle joined at design resolution 4: the STRUCTURAL channel's packet
  // embeds member-member dependency edges, so enrichment-merged edges must
  // re-stale the register (sliced to the member-member set the packet renders).
  expect(
    Object.keys(DEPENDENCY_SLICE_PROJECTIONS["charter_register.json"]!).sort(),
  ).toEqual([
    "graph_bundle.json",
    "repo_manifest.json",
    "structure_decomposition.json",
  ]);
  expect(
    hasDependencySliceProjection("charter_register.json", "intent_checkpoint.json"),
  ).toBe(false);
  expect(
    computeDependencySliceHash("systemic_challenge.json", "repo_manifest.json", makeBundle()),
  ).toBeUndefined();
});

test("graph slice fires on a member-member edge change, ignores outside-member and node_metrics churn", () => {
  const base = makeBundle();
  const hash = (bundle: ArtifactBundle) =>
    computeDependencySliceHash("charter_register.json", "graph_bundle.json", bundle);
  const withGraph = (graphs: NonNullable<ArtifactBundle["graph_bundle"]>["graphs"]): ArtifactBundle => ({
    ...base,
    graph_bundle: { graphs },
  });
  const baseline = hash(
    withGraph({ imports: [{ from: "src/a.ts", to: "src/b.ts", kind: "import" }] }),
  );
  // New member-member edge (e.g. analyzer enrichment) → fires.
  expect(
    hash(
      withGraph({
        imports: [
          { from: "src/a.ts", to: "src/b.ts", kind: "import" },
          { from: "src/b.ts", to: "src/a.ts", kind: "call" },
        ],
      }),
    ),
  ).not.toBe(baseline);
  // An edge to a non-member → invisible to the packet → no fire.
  expect(
    hash(
      withGraph({
        imports: [
          { from: "src/a.ts", to: "src/b.ts", kind: "import" },
          { from: "src/a.ts", to: "src/zz.ts", kind: "import" },
        ],
      }),
    ),
  ).toBe(baseline);
  // node_metrics churn → invisible → no fire.
  expect(
    hash({
      ...base,
      graph_bundle: {
        graphs: { imports: [{ from: "src/a.ts", to: "src/b.ts", kind: "import" }] },
        node_metrics: { "src/a.ts": {} },
      },
    }),
  ).toBe(baseline);
});

test("repo slice ignores non-member/non-doc CONTENT churn; fires on member content, doc content, membership, path-set changes, and oversized-file size", () => {
  const base = makeBundle();
  const hash = (bundle: ArtifactBundle) =>
    computeDependencySliceHash("charter_register.json", "repo_manifest.json", bundle);
  const baseHash = hash(base);

  // CONTENT churn on the non-member, non-doc file with the path set constant —
  // the live phantom-staleness driver — stays quiet.
  const zzChurned = makeBundle();
  zzChurned.repo_manifest = {
    ...base.repo_manifest!,
    files: base.repo_manifest!.files.map((f) =>
      f.path === "src/zz.ts" ? { ...f, hash: "hash-zz-CHANGED" } : f,
    ),
  };
  expect(hash(zzChurned)).toBe(baseHash);

  // A path-set change (add/delete/rename) FIRES — the delta pass grounds
  // findings against the complete path set (reviewer F1).
  const added = makeBundle();
  added.repo_manifest = {
    ...base.repo_manifest!,
    files: [
      ...base.repo_manifest!.files,
      { path: "src/new.ts", language: "ts", size_bytes: 7, hash: "hash-new" },
    ],
  };
  expect(hash(added)).not.toBe(baseHash);
  const removed = makeBundle();
  removed.repo_manifest = {
    ...base.repo_manifest!,
    files: base.repo_manifest!.files.filter((f) => f.path !== "src/zz.ts"),
  };
  expect(hash(removed)).not.toBe(baseHash);

  // A member file's content hash moved.
  const memberChanged = makeBundle();
  memberChanged.repo_manifest = {
    ...base.repo_manifest!,
    files: base.repo_manifest!.files.map((f) =>
      f.path === "src/b.ts" ? { ...f, hash: "hash-b2" } : f,
    ),
  };
  expect(hash(memberChanged)).not.toBe(baseHash);

  // A doc_only file's content moved (the Stated pass reads docs — Codex #3).
  const docChanged = makeBundle();
  docChanged.repo_manifest = {
    ...base.repo_manifest!,
    files: base.repo_manifest!.files.map((f) =>
      f.path === "README.md" ? { ...f, hash: "hash-doc2" } : f,
    ),
  };
  expect(hash(docChanged)).not.toBe(baseHash);

  // An UNHASHED oversized member changed size (Codex #4: size proxies content).
  const bigChanged = makeBundle();
  bigChanged.repo_manifest = {
    ...base.repo_manifest!,
    files: base.repo_manifest!.files.map((f) =>
      f.path === "big/blob.ts" ? { ...f, size_bytes: 2_000_001 } : f,
    ),
  };
  expect(hash(bigChanged)).not.toBe(baseHash);

  // Membership changed (cross-artifact sensitivity).
  const membership = makeBundle();
  membership.structure_decomposition = makeStructureDecomposition({
    consensus: [consensusNode({ members: ["src/a.ts"] })],
  });
  expect(hash(membership)).not.toBe(baseHash);
});

test("structure slice ignores score churn, fires on membership; member order is canonical", () => {
  const base = makeBundle();
  const hash = (bundle: ArtifactBundle) =>
    computeDependencySliceHash(
      "charter_register.json",
      "structure_decomposition.json",
      bundle,
    );
  const baseHash = hash(base);

  const scoresOnly = makeBundle();
  scoresOnly.structure_decomposition = makeStructureDecomposition({
    consensus: [consensusNode({ agreed_across_source: 0.5, stable_across_scale: 0.25 })],
    contested: [
      consensusNode({
        node_id: "noise",
        members: [],
        agreed_across_source: 0,
        stable_across_scale: 0,
        contested: true,
      }),
    ],
  });
  // Contested nodes are deliberately outside the slice: the charter path
  // grounds ONLY on consensus, so a contested-only change does not re-fire.
  expect(hash(scoresOnly)).toBe(baseHash);

  const reordered = makeBundle();
  reordered.structure_decomposition = makeStructureDecomposition({
    consensus: [consensusNode({ members: ["big/blob.ts", "src/a.ts", "src/b.ts"] })],
  });
  expect(hash(reordered)).toBe(baseHash);
});

test("a throwing projection returns the error sentinel; buildDependencySlices skips it", () => {
  const malformed = makeBundle();
  // Deliberately malformed (missing target/node_universe_size/source_ids/
  // findings, and the consensus node missing members/scores) to exercise the
  // projection's runtime throw -> SLICE_PROJECTION_ERROR fallback.
  // @ts-expect-error deliberate contract-violation probe: malformed structure_decomposition
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
    charter_register: makeCharterRegister(),
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
  const entry = manifest.artifacts["charter_register.json"]!;
  expect(entry.dependency_slices!["repo_manifest.json"]).toBeDefined();
  expect(entry.dependency_slices!["structure_decomposition.json"]).toBeDefined();
  expect(entry.dependency_slices!["intent_checkpoint.json"]).toBeUndefined();

  // Out-of-slice churn: the non-member/non-doc file's CONTENT hash moves with
  // the path set unchanged — repo_manifest's own canonical hash DOES move
  // (structure re-stales via its whole-hash edge), but the charter slice does
  // not: this is the live incident's exact shape.
  const churned: ArtifactBundle = {
    ...bundle,
    artifact_metadata: manifest,
    repo_manifest: {
      ...bundle.repo_manifest!,
      files: bundle.repo_manifest!.files.map((f) =>
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
  const memberChanged: ArtifactBundle = {
    ...bundle,
    repo_manifest: {
      ...bundle.repo_manifest!,
      files: bundle.repo_manifest!.files.map((f) =>
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
  const hash = (bundle: ArtifactBundle) =>
    computeDependencySliceHash("charter_register.json", "repo_manifest.json", bundle);
  const withSpec = (h: string) => {
    const bundle = makeBundle();
    bundle.repo_manifest = {
      ...base.repo_manifest!,
      files: [
        ...base.repo_manifest!.files,
        { path: "spec/design.rst", language: "rst", size_bytes: 4, hash: h },
      ],
    };
    bundle.file_disposition = {
      files: [
        ...base.file_disposition!.files,
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
    charter_register: makeCharterRegister(),
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
  const membershipChanged: ArtifactBundle = {
    ...bundle,
    artifact_metadata: manifest,
    structure_decomposition: makeStructureDecomposition({
      consensus: [consensusNode({ members: ["src/a.ts"] })],
    }),
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
    charter_register: makeCharterRegister(),
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
  const recorded = first.artifacts["charter_register.json"]!.dependency_slices;

  // Mutate the register on disk WITHOUT listing it (the forgotten-listing case)
  // AND move the membership so a rebuild would produce different slices.
  const mutated: ArtifactBundle = {
    ...bundle,
    charter_register: { ...bundle.charter_register!, deltas_pending: true },
    structure_decomposition: makeStructureDecomposition({
      consensus: [consensusNode({ members: ["src/a.ts"] })],
    }),
  };
  const second = computeArtifactMetadata(mutated, first, []);
  expect(second.artifacts["charter_register.json"]!.dependency_slices).toEqual(
    recorded,
  );
});

// CP-NODE-10 residual 1: the third state was exempted for map-declared LEAVES,
// which put `audit-findings.json` — the pipeline's primary machine contract —
// outside the only check that can see a partially-written body. The exemption is
// deleted; these two pin that the leaves it covered are classified now.
test("partial reaches a leaf: a leaf body that moved is stale", () => {
  // The exemption's gate was `(ARTIFACT_DEPENDS_ON_MAP[name] ?? []).length === 0`
  // — BOTH an absent key and a zero-length entry. `intent_checkpoint.json` is
  // the absent-key form: a leaf INPUT that no map entry declares and that
  // dependents read, so it participates in the DAG without an upstream of its own.
  // Read as a plain record: the map's declared type is a strict literal, so an
  // ABSENT key is a type error to index directly — which is itself the proof
  // that the key is absent, but it must be stated as a lookup.
  const dependsOn = ARTIFACT_DEPENDS_ON_MAP as Readonly<Record<string, string[]>>;
  expect(
    dependsOn["intent_checkpoint.json"],
    "the fixture leaf is absent from the depends-on map — the exemption's other gate",
  ).toBeUndefined();
  expect(
    ALL_DAG_ARTIFACTS.has("intent_checkpoint.json"),
    "and it is still a tracked DAG artifact, so it is classified",
  ).toBe(true);

  const cp = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host" as const,
    scope_summary: "audit the auth path",
    intent_summary: "audit auth",
  };
  const bundle = { intent_checkpoint: cp } as unknown as ArtifactBundle;
  const metadata = computeArtifactMetadata(bundle);
  const tampered: unknown = { ...cp, intent_summary: "audit auth — TRUNCATED" };
  const stale = computeStaleArtifacts(
    {
      intent_checkpoint: tampered,
      artifact_metadata: metadata,
    } as unknown as ArtifactBundle,
    { emit: false },
  );
  expect([...stale], "a truncated leaf body is the third state, not intact").toContain(
    "intent_checkpoint.json",
  );
});

test("partial reaches audit-findings.json: the machine contract is not exempt", () => {
  const findings = { schema_version: 1, findings: [{ id: "f1" }] };
  const metadata = computeArtifactMetadata({
    audit_findings: findings,
  } as unknown as ArtifactBundle);
  expect(
    metadata.artifacts["audit-findings.json"],
    "the primary machine contract carries a metadata entry",
  ).toBeDefined();
  const truncated = {
    schema_version: 1,
    findings: [{ id: "f1" }, { id: "f2" }],
  };
  const stale = computeStaleArtifacts(
    {
      audit_findings: truncated,
      artifact_metadata: metadata,
    } as unknown as ArtifactBundle,
    { emit: false },
  );
  expect([...stale]).toContain("audit-findings.json");
});

test("the host-appended carve-out survives the leaf exemption's deletion", () => {
  // `agent-feedback.jsonl` is appended by workers AFTER its producer runs, so a
  // body running ahead of the manifest is its steady state. Staling it would
  // re-fire its producer forever; its staleness reaches the report downstream.
  const reflections = { reflections: [{ note: "a" }] };
  const metadata = computeArtifactMetadata({
    agent_reflections: reflections,
  } as unknown as ArtifactBundle);
  const stale = computeStaleArtifacts(
    {
      agent_reflections: { reflections: [{ note: "a" }, { note: "b" }] },
      artifact_metadata: metadata,
    } as unknown as ArtifactBundle,
    { emit: false },
  );
  expect(
    [...stale],
    "a host-appended artifact is not staled by its own appended bytes",
  ).not.toContain("agent-feedback.jsonl");
});

// CP-NODE-10 residual 2: the carry is a field of a `StaleArtifactSet`, so a
// consumer that re-types the set through the constructor keeps it — and its loss
// on the derivations that cannot carry it (union, structuredClone, new Set) is
// STATED as `undefined` rather than degrading to an empty set that reads as
// "nothing was deferred". Those two observations were previously
// indistinguishable.
//
// WHAT EACH ASSERTION DECIDES: the re-typed copy red-greens on the constructor's
// graft (delete the graft and the copy reads an EMPTY set). The plain-`Set`
// assertions are the STATED CONTRACT, not a mechanism probe: a plain `Set` has no
// carry to find, so no predicate over it can answer anything but `undefined`.
test("the deferred carry is readable through the re-typing path, and its loss is stated", () => {
  const original = new StaleArtifactSet(["x"], ["deferred-one"]);
  const retyped = new StaleArtifactSet(original);
  expect(deferredArtifactsOf(retyped), "a re-typed copy keeps the carry").toEqual(
    new Set(["deferred-one"]),
  );

  // A plain-Set derivation (`structuredClone` is the same shape) rebuilds the
  // value with no hook to intercept, so the loss is loud (`undefined`), never a
  // silently-empty deferral. Spelled as a rebuild rather than `Set.prototype.union`
  // because `union` needs the esnext lib and this tsconfig does not target it.
  // The loss is real at the READ: the clone is not a staleness result.
  const rebuilt = structuredClone(original) as ReadonlySet<string>;
  expect(
    deferredArtifactsOf(rebuilt),
    "a rebuilt set states the loss instead of reporting an empty deferral",
  ).toBeUndefined();

  // A plain Set that never was a staleness result reads the same `undefined`.
  // The contract this states: NO plain `Set` carries deferrals — not a clone,
  // not a `union` result, not a hand-built one — so `undefined` from any of them
  // means "not a staleness result", never "I lost the carry somewhere".
  expect(deferredArtifactsOf(new Set(["z"]))).toBeUndefined();

  // The constructor's graft is the ONE derivation that survives, and it is the
  // only repair path for a consumer that must have the type back.
  expect(
    deferredArtifactsOf(new StaleArtifactSet(original)),
    "a copy of a deferring set inherits its carry through the constructor",
  ).toEqual(new Set(["deferred-one"]));
});

// The 2026-07-16 self-audit dogfood entry. Fixing this tool while it audits a
// tree stales the planning chain derived from that tree; the cascade is CORRECT
// and is deliberately not narrowed — but it must say so, or an operator cannot
// tell a correct recovery from a wedge.
test("recovery: a cascade over COMPLETED work names what invalidated it", () => {
  // The dogfood shape: the tool's own source change is noticed by
  // `repo_manifest.json`, and everything derived from it follows. The cascade
  // HEAD is the map-declared artifact with no upstream — `tooling_manifest.json`,
  // which is rebuilt fresh every call and so is never in the stale set.
  expect(
    (ARTIFACT_DEPENDS_ON_MAP["repo_manifest.json"] ?? []),
    "the fixture head is `repo_manifest`'s only upstream",
  ).toEqual(["tooling_manifest.json"]);
  const bundle = {
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    structure_decomposition: { subsystems: [] },
  } as unknown as ArtifactBundle;
  const stale = new Set(["repo_manifest.json", "structure_decomposition.json"]);

  const recovery = describeStalenessRecovery(stale, bundle);
  expect(recovery, "a cascade over written artifacts is a recovery").toBeDefined();
  expect(recovery!.caused_by, "the head of the cascade is named").toEqual([
    "tooling_manifest.json",
  ]);
  expect(recovery!.rederiving).toBe(2);
});

// The cascade head is a property of the ROUTE, not of the artifact alone. Both
// stale artifacts below reach `repo_manifest.json` by a different route — one
// directly, one through `structure_decomposition.json` — while the shared
// upstream itself takes the direct route to the same head. A head computed
// while walking one route must therefore never be reused as the answer for a
// node reached by another: the walk carries a per-branch `seen`, so
// "is this node a head" is decided against the path that reached it.
test("recovery: a shared upstream reached by two routes names the head per route", () => {
  const bundle = {
    repo_manifest: { files: [{ path: "src/a.ts" }] },
    structure_decomposition: { subsystems: [] },
    charter_register: { nodes: [] },
    charter_clarification: { entries: [] },
    // Present so it is NOT a head: an absent upstream would be one in its own
    // right (nothing above it explains the change), which is correct behaviour
    // and would just widen the expected set away from the route question.
    intent_checkpoint: { checkpoints: [] },
    file_disposition: { files: [] },
    graph_bundle: { nodes: [], edges: [] },
  } as unknown as ArtifactBundle;
  // Every upstream in the topology is PRESENT except `tooling_manifest.json`
  // (the map-declared root, rebuilt every call and never persisted), so it —
  // and only it — is the head every route resolves to.
  const stale = new Set([
    "charter_clarification.json",
    "charter_register.json",
    "structure_decomposition.json",
    "repo_manifest.json",
  ]);

  expect(
    (ARTIFACT_DEPENDS_ON_MAP["charter_clarification.json"] ?? []).includes(
      "charter_register.json",
    ) &&
      (ARTIFACT_DEPENDS_ON_MAP["charter_register.json"] ?? []).includes(
        "structure_decomposition.json",
      ),
    "the fixture really does reach the shared upstream by two routes",
  ).toBe(true);

  const recovery = describeStalenessRecovery(stale, bundle);
  expect(recovery!.caused_by, "the head is named once, per route").toEqual([
    "tooling_manifest.json",
  ]);
  expect(recovery!.rederiving, "every routed artifact is counted once").toBe(4);
});

test("recovery: a first pass is NOT a recovery — nothing was done to recover", () => {
  // Nothing present, so nothing is being REDONE; announcing this would fire on
  // every ordinary planning step, which is the same as not having the signal.
  const bundle = {} as unknown as ArtifactBundle;
  expect(describeStalenessRecovery(new Set(["repo_manifest.json"]), bundle)).toBeUndefined();
});

test("recovery: the emitted record carries the explanation, not just the stale list", () => {
  const bundle = {
    repo_manifest: { files: [{ path: "src/a.ts" }] },
  } as unknown as ArtifactBundle;
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    emitStalenessRecord(new Set(["repo_manifest.json"]), undefined, bundle);
  } finally {
    process.stderr.write = original;
  }
  const record = JSON.parse(lines.join("")) as {
    kind?: string;
    recovery?: { caused_by?: string[]; message?: string };
  };
  expect(record.kind).toBe("staleness");
  // The message is the whole point of the entry: one statement, at the moment it
  // happens, that this is a correct re-derivation rather than a wedge.
  expect(record.recovery?.message).toContain("correct recovery");
  expect(record.recovery?.caused_by).toEqual(["tooling_manifest.json"]);
});
