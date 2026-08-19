import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RED_SIGNATURE = "contract:shared-content-coherence:not-yet-satisfied";

type UnknownRecord = Record<string, unknown>;

interface CoherencePolicy {
  readonly eligibility: string;
  readonly refineAtModularityPeak: boolean;
}

interface CoreModule {
  readonly CONTENT_COHERENCE_SCORES: Readonly<Record<string, number>>;
  readonly buildContentCoherenceTrace: (
    input: UnknownRecord,
    policy: CoherencePolicy,
  ) => UnknownRecord;
  readonly ContentCoherenceTraceSchema: { readonly shape: UnknownRecord };
  readonly TASK_DRAW_COHERENCE_POLICY: CoherencePolicy;
  readonly FINDINGS_DRAW_COHERENCE_POLICY: CoherencePolicy;
}

/**
 * The complete emitted trace surface — every field with a PRODUCTION reader,
 * and nothing else.
 *
 * `components` is read by every projection (audit packets, work blocks, the
 * deliverable emitter, the approved-subset projection); `normalized_items` is
 * read by the work-block projection and by the report contract's own
 * `superRefine`. The pairwise layer that used to ride alongside them
 * (`pair_scores`, `eligible_candidates`, `merge_trace`, `merge_decisions`) had
 * NO reader — its one non-test reference copied it through a filter — while
 * being O(N²): at 3,194 findings `pair_scores` alone serialized to 1.33 GB and
 * blew V8's 512 MB string cap inside `stableStringify`, wedging artifact
 * hashing before anything could be persisted. Adding a field here is therefore
 * a deliberate act: name its production reader, or it does not belong in a
 * persisted contract.
 */
const TRACE_FIELDS = ["components", "normalized_items"] as const;

interface AuditProjectionModule {
  readonly buildTaskCoherencePartition: (
    graph: UnknownRecord,
    retiredOptions?: UnknownRecord,
  ) => {
    readonly coherence_trace: UnknownRecord;
    readonly packets: readonly UnknownRecord[];
  };
}

interface FindingsProjectionModule {
  readonly buildWorkBlockPartition: (input: UnknownRecord) => {
    readonly coherence_trace: UnknownRecord;
    readonly blocks: readonly UnknownRecord[];
    readonly seams: readonly UnknownRecord[];
  };
}

async function loadCore(): Promise<CoreModule> {
  try {
    const loaded = (await import(
      "../../src/shared/decompose/contentCoherence.js"
    )) as unknown as Partial<CoreModule>;
    if (
      typeof loaded.buildContentCoherenceTrace !== "function" ||
      loaded.CONTENT_COHERENCE_SCORES === undefined ||
      loaded.ContentCoherenceTraceSchema === undefined ||
      loaded.TASK_DRAW_COHERENCE_POLICY === undefined ||
      loaded.FINDINGS_DRAW_COHERENCE_POLICY === undefined
    ) {
      throw new Error("shared coherence exports are absent");
    }
    return loaded as CoreModule;
  } catch (error) {
    throw new Error(`${RED_SIGNATURE}: ${String(error)}`, { cause: error });
  }
}

async function loadAuditProjection(): Promise<AuditProjectionModule> {
  const loaded = (await import(
    "../../src/audit/orchestrator/partitionTaskGraph.js"
  )) as unknown as Partial<AuditProjectionModule>;
  if (typeof loaded.buildTaskCoherencePartition !== "function") {
    throw new Error(`${RED_SIGNATURE}: audit still uses a local partitioner`);
  }
  return loaded as AuditProjectionModule;
}

async function loadFindingsProjection(): Promise<FindingsProjectionModule> {
  const loaded = (await import(
    "../../src/audit/reporting/workBlocks.js"
  )) as unknown as Partial<FindingsProjectionModule>;
  if (typeof loaded.buildWorkBlockPartition !== "function") {
    throw new Error(`${RED_SIGNATURE}: findings projection is absent`);
  }
  return loaded as FindingsProjectionModule;
}

function goldenItems(reverse = false): UnknownRecord[] {
  const items: UnknownRecord[] = [
    {
      id: "d",
      file_paths: ["lib/z.ts"],
      unit_ids: ["u3"],
      tags: ["auth"],
    },
    {
      id: "b",
      file_paths: ["src/x.ts"],
      unit_ids: ["u2"],
      tags: ["ui"],
    },
    {
      id: "e",
      file_paths: ["api/q.ts"],
      unit_ids: ["u4"],
      tags: ["ops"],
    },
    {
      id: "a",
      file_paths: ["src/x.ts"],
      unit_ids: ["u1"],
      tags: ["auth"],
    },
    {
      id: "c",
      file_paths: ["src/y.ts"],
      unit_ids: ["u1"],
      tags: ["auth"],
    },
  ];
  return reverse
    ? items.reverse().map((item) => ({
        ...item,
        file_paths: [...(item.file_paths as string[])].reverse(),
        unit_ids: [...(item.unit_ids as string[])].reverse(),
        tags: [...(item.tags as string[])].reverse(),
      }))
    : items;
}

function goldenInput(reverse = false): UnknownRecord {
  return {
    items: goldenItems(reverse),
    relationships: [
      reverse
        ? { left: "d", right: "e", kind: "call_adjacent" }
        : { left: "e", right: "d", kind: "call_adjacent" },
    ],
  };
}

const GOLDEN = {
  components: [
    ["a", "b", "c"],
    ["d", "e"],
  ],
} as const;

/**
 * The trace's ONLY consumed fields. The pairwise layer (`pair_scores`,
 * `eligible_candidates`, `merge_trace`, `merge_decisions`) is module-private
 * scratch — see TRACE_FIELDS below.
 */
function traceProjection(trace: UnknownRecord): UnknownRecord {
  return { components: trace.components };
}

/**
 * Whether `left` and `right` landed in the SAME component — the observable form
 * of "this pair scored at or above the threshold and was unioned". Scoring is
 * asserted through membership, never through a persisted pair record.
 */
function merged(trace: UnknownRecord, left: string, right: string): boolean {
  return (trace.components as string[][]).some(
    (component) => component.includes(left) && component.includes(right),
  );
}

/** Two bare items joined only by `kinds`; no direct evidence of any class. */
function relatedOnly(...kinds: string[]): UnknownRecord {
  return {
    items: [
      { id: "left", file_paths: [], unit_ids: [], tags: [] },
      { id: "right", file_paths: [], unit_ids: [], tags: [] },
    ],
    relationships: kinds.map((kind) => ({ left: "left", right: "right", kind })),
  };
}

function finding(
  id: string,
  files: readonly string[],
  lens: "security" | "reliability",
  systemic = false,
): UnknownRecord {
  return {
    id,
    title: id,
    category: "test",
    severity: id === "a" ? "high" : "medium",
    confidence: "high",
    lens,
    summary: id,
    affected_files: files.map((path) => ({ path })),
    systemic,
  };
}

function consumerGoldenGraph(): UnknownRecord {
  return {
    schema_version: "task-affinity-graph/v1",
    nodes: [
      {
        task_id: "e",
        unit_id: "u4",
        lens: "reliability",
        file_paths: ["api/q.ts"],
        token_estimate: 50,
        risk_estimate: 0.1,
      },
      {
        task_id: "c",
        unit_id: "u1",
        lens: "security",
        file_paths: ["unit/c.anchor", "src/y.ts"],
        token_estimate: 40,
        risk_estimate: 0.2,
      },
      {
        task_id: "a",
        unit_id: "u1",
        lens: "security",
        file_paths: ["unit/a.anchor", "src/x.ts"],
        token_estimate: 30,
        risk_estimate: 0.3,
      },
      {
        task_id: "d",
        unit_id: "u3",
        lens: "security",
        file_paths: ["lib/z.ts"],
        token_estimate: 20,
        risk_estimate: 0.4,
      },
      {
        task_id: "b",
        unit_id: "u2",
        lens: "reliability",
        file_paths: ["other/b.anchor", "src/x.ts"],
        token_estimate: 10,
        risk_estimate: 0.5,
      },
    ],
    edges: [
      {
        from: "d",
        to: "e",
        kind: "call_adjacent",
        reason: "call_adjacent",
        weight: 0.01,
      },
      {
        from: "a",
        to: "c",
        kind: "same_unit",
        reason: "same_dir,same_lens,same_unit",
        weight: 0.01,
      },
      {
        from: "b",
        to: "a",
        kind: "cross_lens_same_file",
        reason: "same_dir,cross_lens_same_file",
        weight: 0.01,
      },
    ],
  };
}

function consumerGoldenFindings(systemicA = false): UnknownRecord {
  return {
    findings: [
      finding("e", ["api/q.ts"], "reliability"),
      finding("c", ["unit/c.anchor", "src/y.ts"], "security"),
      finding("a", ["unit/a.anchor", "src/x.ts"], "security", systemicA),
      finding("d", ["lib/z.ts"], "security"),
      finding("b", ["other/b.anchor", "src/x.ts"], "reliability"),
    ],
    unitManifest: {
      units: [
        {
          unit_id: "u1",
          name: "u1",
          files: ["unit/a.anchor", "unit/c.anchor"],
          required_lenses: [],
        },
        {
          unit_id: "u2",
          name: "u2",
          files: ["other/b.anchor"],
          required_lenses: [],
        },
        {
          unit_id: "u3",
          name: "u3",
          files: ["lib/z.ts"],
          required_lenses: [],
        },
        {
          unit_id: "u4",
          name: "u4",
          files: ["api/q.ts"],
          required_lenses: [],
        },
      ],
    },
    graphBundle: {
      graphs: {
        imports: [{ from: "lib/z.ts", to: "api/q.ts", kind: "imports" }],
        calls: [],
        references: [],
      },
    },
  };
}

function componentMembers(blocks: readonly UnknownRecord[]): string[][] {
  return blocks
    .map((block) => [...((block.finding_ids as string[]) ?? [])].sort())
    .sort((left, right) =>
      (left[0] ?? "") < (right[0] ?? "") ? -1 : 1,
    );
}

function expectAcyclic(blocks: readonly UnknownRecord[]): void {
  const dependencies = new Map(
    blocks.map((block) => [
      String(block.id),
      new Set(((block.depends_on as string[]) ?? []).map(String)),
    ]),
  );
  const visit = (id: string, stack: Set<string>): void => {
    expect(stack.has(id), `dependency cycle at ${id}`).toBe(false);
    const next = new Set(stack).add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency, next);
  };
  for (const id of dependencies.keys()) visit(id, new Set());
}

describe(RED_SIGNATURE, () => {
  it("produces the exact six-class golden topology and canonical trace", async () => {
    const core = await loadCore();
    expect(core.CONTENT_COHERENCE_SCORES).toEqual({
      call_import_reference_adjacency: 70,
      same_directory: 10,
      shared_critical_flow: 60,
      shared_file: 100,
      shared_semantic_tag_or_same_lens: 30,
      shared_unit: 80,
    });

    const trace = core.buildContentCoherenceTrace(
      goldenInput(),
      core.TASK_DRAW_COHERENCE_POLICY,
    );
    expect(traceProjection(trace), RED_SIGNATURE).toEqual(GOLDEN);
    expect(trace.normalized_items).toEqual(goldenItems().sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : 1,
    ));
  });

  it("declares exactly two draw policies and refines only the findings draw", async () => {
    const core = await loadCore();
    // Eligibility is a POLICY AXIS of the ONE shared core, never a fork: the two
    // draws differ by these values and by nothing else.
    expect(core.TASK_DRAW_COHERENCE_POLICY).toEqual({
      eligibility: "weighted_score_threshold",
      refineAtModularityPeak: false,
    });
    expect(core.FINDINGS_DRAW_COHERENCE_POLICY).toEqual({
      eligibility: "shared_file_and_same_lens",
      refineAtModularityPeak: true,
    });
  });

  it("scores every boolean class once, honors aliases, and rejects unknown relations", async () => {
    const core = await loadCore();
    const task = core.TASK_DRAW_COHERENCE_POLICY;
    // Every relationship kind maps onto exactly one evidence class, and under the
    // TASK draw's weighted-score eligibility the weight table (asserted verbatim
    // above) decides whether that ONE class clears the 60 threshold on its own.
    // Membership is the observable form.
    for (const kind of [
      "shared_file",
      "cross_lens_same_file",
      "same_unit",
      "call_adjacent",
      "same_flow",
    ]) {
      const trace = core.buildContentCoherenceTrace(relatedOnly(kind), task);
      expect(merged(trace, "left", "right"), `${kind} must merge alone`).toBe(true);
    }
    for (const kind of ["same_lens", "same_dir"]) {
      const trace = core.buildContentCoherenceTrace(relatedOnly(kind), task);
      expect(merged(trace, "left", "right"), `${kind} must not merge alone`).toBe(
        false,
      );
    }
    // 30 + 10 still under threshold — weak classes accumulate but do not reach it.
    expect(
      merged(
        core.buildContentCoherenceTrace(
          relatedOnly("same_lens", "same_dir"),
          task,
        ),
        "left",
        "right",
      ),
    ).toBe(false);
    // Endpoint order is canonicalized: a reversed relationship is the same pair.
    expect(
      merged(
        core.buildContentCoherenceTrace(
          {
            items: [
              { id: "left", file_paths: [], unit_ids: [], tags: [] },
              { id: "right", file_paths: [], unit_ids: [], tags: [] },
            ],
            relationships: [{ left: "right", right: "left", kind: "shared_file" }],
          },
          task,
        ),
        "left",
        "right",
      ),
    ).toBe(true);
    // Direct (relationship-free) evidence scores identically.
    expect(
      merged(
        core.buildContentCoherenceTrace(
          {
            items: [
              { id: "left", file_paths: ["src/x.ts"], unit_ids: [], tags: [] },
              { id: "right", file_paths: ["src/x.ts"], unit_ids: [], tags: [] },
            ],
          },
          task,
        ),
        "left",
        "right",
      ),
    ).toBe(true);
    expect(
      merged(
        core.buildContentCoherenceTrace(
          {
            items: [
              { id: "left", file_paths: ["src/x.ts"], unit_ids: [], tags: ["t"] },
              { id: "right", file_paths: ["src/y.ts"], unit_ids: [], tags: ["t"] },
            ],
          },
          task,
        ),
        "left",
        "right",
      ),
    ).toBe(false);

    expect(() =>
      core.buildContentCoherenceTrace(
        {
          items: [
            { id: "a", file_paths: [], unit_ids: [], tags: [] },
            { id: "b", file_paths: [], unit_ids: [], tags: [] },
          ],
          relationships: [{ left: "a", right: "b", kind: "mystery" }],
        },
        task,
      ),
    ).toThrow(/unknown.*mystery/i);
  });

  it("joins a findings-draw pair only on shared_file AND same_lens", async () => {
    const core = await loadCore();
    const findings = core.FINDINGS_DRAW_COHERENCE_POLICY;
    const pair = (
      left: UnknownRecord,
      right: UnknownRecord,
      relationships: UnknownRecord[] = [],
    ): boolean =>
      merged(
        core.buildContentCoherenceTrace(
          { items: [{ id: "left", ...left }, { id: "right", ...right }], relationships },
          findings,
        ),
        "left",
        "right",
      );

    // Both halves present → joins.
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: ["u"], tags: ["security"] },
        { file_paths: ["src/x.ts"], unit_ids: ["u"], tags: ["security"] },
      ),
    ).toBe(true);
    // Same file, different lens → does NOT join (this is the half the disjunctive
    // rule cleared on `shared_file`'s weight of 100 alone).
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: ["u"], tags: ["security"] },
        { file_paths: ["src/x.ts"], unit_ids: ["u"], tags: ["reliability"] },
      ),
    ).toBe(false);
    // Same lens, no shared file → does NOT join, whatever else agrees.
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: ["u"], tags: ["security"] },
        { file_paths: ["src/y.ts"], unit_ids: ["u"], tags: ["security"] },
      ),
    ).toBe(false);
    // Neither call adjacency nor a shared critical flow can substitute for the
    // conjunction — the two classes that carried the collapse.
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: [], tags: ["security"] },
        { file_paths: ["src/y.ts"], unit_ids: [], tags: ["security"] },
        [{ left: "left", right: "right", kind: "call_adjacent" }],
      ),
    ).toBe(false);
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: [], tags: ["security"] },
        { file_paths: ["src/y.ts"], unit_ids: [], tags: ["security"] },
        [{ left: "left", right: "right", kind: "same_flow" }],
      ),
    ).toBe(false);
    // RELATIONSHIP-contributed evidence can never satisfy either conjunct. The
    // `shared_file` / `cross_lens_same_file` / `same_lens` relationship kinds map
    // onto the very bits the conjunction reads, so without this mask a caller
    // that passed them would create eligibility and "same_lens is a hard
    // partition no edge may cross" would hold only by call-site habit. The bits
    // still raise the pair's WEIGHT, which is refinement's input.
    expect(
      pair(
        { file_paths: [], unit_ids: [], tags: ["security"] },
        { file_paths: [], unit_ids: [], tags: ["security"] },
        [{ left: "left", right: "right", kind: "shared_file" }],
      ),
    ).toBe(false);
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: [], tags: ["security"] },
        { file_paths: ["src/y.ts"], unit_ids: [], tags: ["reliability"] },
        [
          { left: "left", right: "right", kind: "cross_lens_same_file" },
          { left: "left", right: "right", kind: "same_lens" },
        ],
      ),
    ).toBe(false);
    // …while the SAME two conjuncts supplied directly still join.
    expect(
      pair(
        { file_paths: ["src/x.ts"], unit_ids: [], tags: ["security"] },
        { file_paths: ["src/x.ts"], unit_ids: [], tags: ["security"] },
        [{ left: "left", right: "right", kind: "call_adjacent" }],
      ),
    ).toBe(true);
  });

  it("uses threshold 60 inclusively and folds an already-connected triangle", async () => {
    const core = await loadCore();
    const threshold = core.buildContentCoherenceTrace(
      {
        items: [
          { id: "a", file_paths: ["x/a"], unit_ids: [], tags: [] },
          { id: "b", file_paths: ["y/b"], unit_ids: [], tags: [] },
          { id: "c", file_paths: ["x/c"], unit_ids: [], tags: ["tag"] },
          { id: "d", file_paths: ["x/d"], unit_ids: [], tags: ["tag"] },
        ],
        relationships: [{ left: "a", right: "b", kind: "same_flow" }],
      },
      core.TASK_DRAW_COHERENCE_POLICY,
    );
    // a/b score exactly 60 (shared_critical_flow, different dirs) → merged: the
    // threshold is inclusive. c/d score 40 (same_directory 10 + same tag 30).
    expect(merged(threshold, "a", "b")).toBe(true);
    expect(merged(threshold, "c", "d")).toBe(false);
    expect(threshold.components).toEqual([["a", "b"], ["c"], ["d"]]);

    // A triangle: the third eligible pair is already connected, so the union
    // is idempotent and the whole triangle is ONE component.
    const triangle = core.buildContentCoherenceTrace(
      {
        items: ["c", "a", "b"].map((id) => ({
          id,
          file_paths: ["src/shared.ts"],
          unit_ids: [],
          tags: [],
        })),
        relationships: [],
      },
      core.TASK_DRAW_COHERENCE_POLICY,
    );
    expect(triangle.components).toEqual([["a", "b", "c"]]);
  });

  it("is byte-stable across permutations and covers every item exactly once", async () => {
    const core = await loadCore();
    const forward = core.buildContentCoherenceTrace(
      goldenInput(),
      core.TASK_DRAW_COHERENCE_POLICY,
    );
    const reverse = core.buildContentCoherenceTrace(
      goldenInput(true),
      core.TASK_DRAW_COHERENCE_POLICY,
    );
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    const ids = (forward.components as string[][]).flat();
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── Modularity-peak refinement (findings draw) ─────────────────────────────
  // Constant-free granularity: inside every eligible-edge component, Louvain at
  // the canonical resolution γ=1 proposes a split and the split is ACCEPTED only
  // when its modularity strictly beats the whole component's. No budget,
  // threshold, or ceiling of any denomination enters the decision.

  /**
   * Two 3-cliques (each: one shared file + one shared unit + one directory,
   * pairwise score 220) joined by exactly ONE weak bridge — a single link file
   * shared by `a3`/`b1` with no shared unit (score 140). Eligible-edge closure
   * makes this ONE component; the bridge is the data-derived thin seam.
   */
  function twoClustersOneBridge(): UnknownRecord[] {
    return [
      { id: "a1", file_paths: ["alpha/a.ts"], unit_ids: ["uA"], tags: ["security"] },
      { id: "a2", file_paths: ["alpha/a.ts"], unit_ids: ["uA"], tags: ["security"] },
      {
        id: "a3",
        file_paths: ["alpha/a.ts", "link/shared.ts"],
        unit_ids: ["uA"],
        tags: ["security"],
      },
      {
        id: "b1",
        file_paths: ["beta/b.ts", "link/shared.ts"],
        unit_ids: ["uB"],
        tags: ["security"],
      },
      { id: "b2", file_paths: ["beta/b.ts"], unit_ids: ["uB"], tags: ["security"] },
      { id: "b3", file_paths: ["beta/b.ts"], unit_ids: ["uB"], tags: ["security"] },
    ];
  }

  it("splits a non-uniform same-file clique at its secondary-evidence contrast", async () => {
    const core = await loadCore();
    // Six findings on ONE file with ONE lens — a complete eligible graph — but
    // two different units. Intra-unit pairs weigh 220, cross-unit pairs 140, and
    // that contrast alone beats the whole component's modularity. So "a clique
    // survives whole" is true of a UNIFORM-weight clique only; a same-file clique
    // whose secondary evidence disagrees may still split, and its halves then
    // contest the shared file as a seam. Two-sided below: the same six items with
    // one unit stay whole.
    const items = (unitOf: (index: number) => string): UnknownRecord[] =>
      ["k1", "k2", "k3", "k4", "k5", "k6"].map((id, index) => ({
        id,
        file_paths: ["src/one.ts"],
        unit_ids: [unitOf(index)],
        tags: ["security"],
      }));

    const split = core.buildContentCoherenceTrace(
      { items: items((index) => (index < 3 ? "uA" : "uB")) },
      core.FINDINGS_DRAW_COHERENCE_POLICY,
    );
    expect(split.components).toEqual([
      ["k1", "k2", "k3"],
      ["k4", "k5", "k6"],
    ]);
    // Exhaustive and disjoint even after a same-file component is cut.
    expect((split.components as string[][]).flat().sort()).toEqual([
      "k1",
      "k2",
      "k3",
      "k4",
      "k5",
      "k6",
    ]);

    const whole = core.buildContentCoherenceTrace(
      { items: items(() => "uA") },
      core.FINDINGS_DRAW_COHERENCE_POLICY,
    );
    expect(whole.components).toEqual([["k1", "k2", "k3", "k4", "k5", "k6"]]);
  });

  it("splits a loose component at its thin seam and keeps a uniform clique whole", async () => {
    const core = await loadCore();
    const findingsPolicy = core.FINDINGS_DRAW_COHERENCE_POLICY;

    // Without refinement the bridge welds all six into one component: the split
    // below is refinement's doing, not eligibility's.
    const unrefined = core.buildContentCoherenceTrace(
      { items: twoClustersOneBridge() },
      { ...findingsPolicy, refineAtModularityPeak: false },
    );
    expect(unrefined.components).toEqual([["a1", "a2", "a3", "b1", "b2", "b3"]]);

    const refined = core.buildContentCoherenceTrace(
      { items: twoClustersOneBridge() },
      findingsPolicy,
    );
    expect(refined.components).toEqual([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);

    // A UNIFORM-weight clique has no thin seam: every split scores below the
    // whole, so the component survives refinement intact. (A clique whose edge
    // weights differ is a separate case — see the non-uniform test above.)
    const clique = core.buildContentCoherenceTrace(
      {
        items: ["c6", "c1", "c4", "c2", "c5", "c3"].map((id) => ({
          id,
          file_paths: ["src/clique.ts"],
          unit_ids: ["uC"],
          tags: ["security"],
        })),
      },
      findingsPolicy,
    );
    expect(clique.components).toEqual([
      ["c1", "c2", "c3", "c4", "c5", "c6"],
    ]);
  });

  it("keeps refinement permutation-invariant and item-exhaustive", async () => {
    const core = await loadCore();
    const findingsPolicy = core.FINDINGS_DRAW_COHERENCE_POLICY;
    const forward = core.buildContentCoherenceTrace(
      { items: twoClustersOneBridge() },
      findingsPolicy,
    );
    const reverse = core.buildContentCoherenceTrace(
      {
        items: [...twoClustersOneBridge()].reverse().map((item) => ({
          ...item,
          file_paths: [...(item.file_paths as string[])].reverse(),
        })),
      },
      findingsPolicy,
    );
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    const ids = (forward.components as string[][]).flat();
    expect([...ids].sort()).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("validates annotations but never lets size, risk, role, or capacity veto membership", async () => {
    const core = await loadCore();
    const base = {
      items: [
        {
          id: "a",
          file_paths: [],
          unit_ids: [],
          tags: [],
          annotations: {
            token_estimate: 10 ** 12,
            byte_estimate: 10 ** 15,
            risk_estimate: 10 ** 9,
            role: "coordination",
          },
        },
        {
          id: "b",
          file_paths: [],
          unit_ids: [],
          tags: [],
          annotations: {
            token_estimate: 10 ** 12,
            byte_estimate: 10 ** 15,
            risk_estimate: 10 ** 9,
            role: "implementation",
          },
        },
      ],
      relationships: [{ left: "a", right: "b", kind: "same_flow" }],
    };
    expect(
      core.buildContentCoherenceTrace(base, core.TASK_DRAW_COHERENCE_POLICY)
        .components,
    ).toEqual([["a", "b"]]);
    expect(() =>
      core.buildContentCoherenceTrace(
        {
          ...base,
          items: [
            { ...(base.items[0] as UnknownRecord), annotations: { token_estimate: Number.NaN } },
            base.items[1],
          ],
        },
        core.TASK_DRAW_COHERENCE_POLICY,
      ),
    ).toThrow(/finite|annotation/i);
  });

  it("makes both draws project ONE core that differs only by its declared policy", async () => {
    const core = await loadCore();
    const audit = await loadAuditProjection();
    const findings = await loadFindingsProjection();

    // ONE core, ONE input, TWO policies — the whole divergence between the draws
    // is these two values. Neither draw owns an algorithm the other lacks.
    expect(
      traceProjection(
        core.buildContentCoherenceTrace(
          goldenInput(),
          core.TASK_DRAW_COHERENCE_POLICY,
        ),
      ),
    ).toEqual(GOLDEN);
    expect(
      core.buildContentCoherenceTrace(
        goldenInput(),
        core.FINDINGS_DRAW_COHERENCE_POLICY,
      ).components,
    ).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);

    const auditResult = audit.buildTaskCoherencePartition(
      consumerGoldenGraph(),
      {
        contextTokenBudget: 1,
        riskMassBudget: 0,
        targetPacketTokens: 1,
      },
    );
    const findingsResult = findings.buildWorkBlockPartition(
      consumerGoldenFindings(),
    );

    // The task draw is UNCHANGED by this lap.
    expect(traceProjection(auditResult.coherence_trace)).toEqual(GOLDEN);
    expect(
      auditResult.packets.map((packet) => packet.task_ids),
    ).toEqual(GOLDEN.components);
    expect(auditResult.packets).toHaveLength(2);
    expect(auditResult.packets.some((packet) => packet.over_budget === true)).toBe(false);

    // The findings draw keeps only `a`/`b`'s shared `src/x.ts` as an overlap, and
    // their lenses differ — so they stay separate blocks and the contested file
    // becomes a seam instead of a silent merge.
    expect(componentMembers(findingsResult.blocks)).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
      ["e"],
    ]);
    expect(findingsResult.seams).toHaveLength(1);
    expect(findingsResult.seams[0]).toMatchObject({
      file: "src/x.ts",
      kind: "predicted_write_conflict",
      requires_preparation: true,
    });
    expectAcyclic(findingsResult.blocks);
  });

  it("keeps systemic findings inside canonical membership and only projects coordination", async () => {
    const findings = await loadFindingsProjection();
    const regular = findings.buildWorkBlockPartition(consumerGoldenFindings(false));
    const systemic = findings.buildWorkBlockPartition(consumerGoldenFindings(true));

    expect(systemic.coherence_trace).toEqual(regular.coherence_trace);
    expect(componentMembers(systemic.blocks)).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
      ["e"],
    ]);
    const owning = systemic.blocks.find((block) =>
      ((block.finding_ids as string[]) ?? []).includes("a"),
    );
    expect(owning).toMatchObject({ role: "coordination" });
    expect(owning?.finding_ids).toEqual(["a"]);
    // The systemic block contests `src/x.ts` with `b`, so its seam is escalated
    // from a plain write conflict to a coordination seam.
    expect(systemic.seams).toHaveLength(1);
    expect(systemic.seams[0]).toMatchObject({
      file: "src/x.ts",
      kind: "systemic_coordination",
    });
  });

  it("emits no trace field without a production reader", async () => {
    const core = await loadCore();
    // The persisted contract's shape IS the schema (.strict(), so an extra key
    // is a validation error rather than silent payload). Both the schema and a
    // real returned trace must carry exactly the consumed set.
    expect(Object.keys(core.ContentCoherenceTraceSchema.shape).sort()).toEqual(
      [...TRACE_FIELDS],
    );
    for (const policy of [
      core.TASK_DRAW_COHERENCE_POLICY,
      core.FINDINGS_DRAW_COHERENCE_POLICY,
    ]) {
      const trace = core.buildContentCoherenceTrace(goldenInput(), policy);
      expect(Object.keys(trace).sort()).toEqual([...TRACE_FIELDS]);
      // The empty draw carries the same shape — no field appears only when
      // populated.
      expect(
        Object.keys(core.buildContentCoherenceTrace({ items: [] }, policy)).sort(),
      ).toEqual([...TRACE_FIELDS]);
    }
  });

  it("stays hashable at audit scale (3,000 items)", async () => {
    const core = await loadCore();
    const { hashArtifactValue } = await import(
      "../../src/shared/artifactFreshness.js"
    );
    // 3,000 items = 4,498,500 pairs. Emitting the pairwise layer put ~1.2 GB
    // into ONE JavaScript string inside stableStringify's Array.join, over V8's
    // 512 MB cap — a RangeError("Invalid string length") thrown from artifact
    // content hashing, BEFORE any persist, which wedged a live audit lap on a
    // deterministically-repeating retry. Membership is O(N²) in TIME by
    // construction; it must never be O(N²) in PAYLOAD.
    const items = Array.from({ length: 3000 }, (_, index) => ({
      // Distinct directory per item keeps the pair set almost entirely
      // ineligible, so this guards serialization size, not merge behavior.
      id: `F-${String(index).padStart(5, "0")}`,
      file_paths: [`src/pkg${index}/file${index}.ts`],
      unit_ids: [`unit-${index}`],
      tags: [`lens-${index % 11}`],
    }));
    const trace = core.buildContentCoherenceTrace(
      { items },
      core.FINDINGS_DRAW_COHERENCE_POLICY,
    );
    expect((trace.components as string[][]).length).toBe(3000);
    const digest = hashArtifactValue("audit-findings.json", trace);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  }, 120_000);

  it("deletes every local membership and backend-fit surface", async () => {
    const sources = await Promise.all(
      [
        "../../src/audit/orchestrator/partitionTaskGraph.ts",
        "../../src/audit/orchestrator/reviewPackets.ts",
        "../../src/audit/reporting/workBlocks.ts",
      ].map(async (path) =>
        await readFile(new URL(path, import.meta.url), "utf8"),
      ),
    );
    const joined = sources.join("\n");
    for (const retired of [
      "partitionWorkItems",
      "mergeGraphConnectedGroups",
      "mergeByDirectoryProximity",
      "contextTokenBudget",
      "riskMassBudget",
      "targetPacketTokens",
      "availableParallelism",
      "over_budget",
    ]) {
      expect(joined, `${RED_SIGNATURE}: retired surface ${retired}`).not.toContain(retired);
    }
  });
});
