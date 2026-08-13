import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RED_SIGNATURE = "contract:shared-content-coherence:not-yet-satisfied";

type UnknownRecord = Record<string, unknown>;

interface CoreModule {
  readonly CONTENT_COHERENCE_SCORES: Readonly<Record<string, number>>;
  readonly buildContentCoherenceTrace: (input: UnknownRecord) => UnknownRecord;
  readonly ContentCoherenceTraceSchema: { readonly shape: UnknownRecord };
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
      loaded.ContentCoherenceTraceSchema === undefined
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

    const trace = core.buildContentCoherenceTrace(goldenInput());
    expect(traceProjection(trace), RED_SIGNATURE).toEqual(GOLDEN);
    expect(trace.normalized_items).toEqual(goldenItems().sort((a, b) =>
      String(a.id) < String(b.id) ? -1 : 1,
    ));
  });

  it("scores every boolean class once, honors aliases, and rejects unknown relations", async () => {
    const core = await loadCore();
    // Every relationship kind maps onto exactly one evidence class, and the
    // weight table (asserted verbatim above) decides whether that ONE class
    // clears the 60 threshold on its own. Membership is the observable form.
    for (const kind of [
      "shared_file",
      "cross_lens_same_file",
      "same_unit",
      "call_adjacent",
      "same_flow",
    ]) {
      const trace = core.buildContentCoherenceTrace(relatedOnly(kind));
      expect(merged(trace, "left", "right"), `${kind} must merge alone`).toBe(true);
    }
    for (const kind of ["same_lens", "same_dir"]) {
      const trace = core.buildContentCoherenceTrace(relatedOnly(kind));
      expect(merged(trace, "left", "right"), `${kind} must not merge alone`).toBe(
        false,
      );
    }
    // 30 + 10 still under threshold — weak classes accumulate but do not reach it.
    expect(
      merged(
        core.buildContentCoherenceTrace(relatedOnly("same_lens", "same_dir")),
        "left",
        "right",
      ),
    ).toBe(false);
    // Endpoint order is canonicalized: a reversed relationship is the same pair.
    expect(
      merged(
        core.buildContentCoherenceTrace({
          items: [
            { id: "left", file_paths: [], unit_ids: [], tags: [] },
            { id: "right", file_paths: [], unit_ids: [], tags: [] },
          ],
          relationships: [{ left: "right", right: "left", kind: "shared_file" }],
        }),
        "left",
        "right",
      ),
    ).toBe(true);
    // Direct (relationship-free) evidence scores identically.
    expect(
      merged(
        core.buildContentCoherenceTrace({
          items: [
            { id: "left", file_paths: ["src/x.ts"], unit_ids: [], tags: [] },
            { id: "right", file_paths: ["src/x.ts"], unit_ids: [], tags: [] },
          ],
        }),
        "left",
        "right",
      ),
    ).toBe(true);
    expect(
      merged(
        core.buildContentCoherenceTrace({
          items: [
            { id: "left", file_paths: ["src/x.ts"], unit_ids: [], tags: ["t"] },
            { id: "right", file_paths: ["src/y.ts"], unit_ids: [], tags: ["t"] },
          ],
        }),
        "left",
        "right",
      ),
    ).toBe(false);

    expect(() =>
      core.buildContentCoherenceTrace({
        items: [
          { id: "a", file_paths: [], unit_ids: [], tags: [] },
          { id: "b", file_paths: [], unit_ids: [], tags: [] },
        ],
        relationships: [{ left: "a", right: "b", kind: "mystery" }],
      }),
    ).toThrow(/unknown.*mystery/i);
  });

  it("uses threshold 60 inclusively and folds an already-connected triangle", async () => {
    const core = await loadCore();
    const threshold = core.buildContentCoherenceTrace({
      items: [
        { id: "a", file_paths: ["x/a"], unit_ids: [], tags: [] },
        { id: "b", file_paths: ["y/b"], unit_ids: [], tags: [] },
        { id: "c", file_paths: ["x/c"], unit_ids: [], tags: ["tag"] },
        { id: "d", file_paths: ["x/d"], unit_ids: [], tags: ["tag"] },
      ],
      relationships: [{ left: "a", right: "b", kind: "same_flow" }],
    });
    // a/b score exactly 60 (shared_critical_flow, different dirs) → merged: the
    // threshold is inclusive. c/d score 40 (same_directory 10 + same tag 30).
    expect(merged(threshold, "a", "b")).toBe(true);
    expect(merged(threshold, "c", "d")).toBe(false);
    expect(threshold.components).toEqual([["a", "b"], ["c"], ["d"]]);

    // A triangle: the third eligible pair is already connected, so the union
    // is idempotent and the whole triangle is ONE component.
    const triangle = core.buildContentCoherenceTrace({
      items: ["c", "a", "b"].map((id) => ({
        id,
        file_paths: ["src/shared.ts"],
        unit_ids: [],
        tags: [],
      })),
      relationships: [],
    });
    expect(triangle.components).toEqual([["a", "b", "c"]]);
  });

  it("is byte-stable across permutations and covers every item exactly once", async () => {
    const core = await loadCore();
    const forward = core.buildContentCoherenceTrace(goldenInput());
    const reverse = core.buildContentCoherenceTrace(goldenInput(true));
    expect(JSON.stringify(reverse)).toBe(JSON.stringify(forward));
    const ids = (forward.components as string[][]).flat();
    expect(ids).toEqual(["a", "b", "c", "d", "e"]);
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
    expect(core.buildContentCoherenceTrace(base).components).toEqual([["a", "b"]]);
    expect(() =>
      core.buildContentCoherenceTrace({
        ...base,
        items: [
          { ...(base.items[0] as UnknownRecord), annotations: { token_estimate: Number.NaN } },
          base.items[1],
        ],
      }),
    ).toThrow(/finite|annotation/i);
  });

  it("makes audit packets and finding blocks project the identical core trace", async () => {
    const audit = await loadAuditProjection();
    const findings = await loadFindingsProjection();
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

    expect(traceProjection(auditResult.coherence_trace)).toEqual(GOLDEN);
    expect(auditResult.coherence_trace).toEqual(findingsResult.coherence_trace);
    expect(
      auditResult.packets.map((packet) => packet.task_ids),
    ).toEqual(GOLDEN.components);
    expect(componentMembers(findingsResult.blocks)).toEqual(GOLDEN.components);
    expect(auditResult.packets).toHaveLength(2);
    expect(auditResult.packets.some((packet) => packet.over_budget === true)).toBe(false);
    expect(findingsResult.seams).toEqual([]);
    expectAcyclic(findingsResult.blocks);
  });

  it("keeps systemic findings inside canonical membership and only projects coordination", async () => {
    const findings = await loadFindingsProjection();
    const regular = findings.buildWorkBlockPartition(consumerGoldenFindings(false));
    const systemic = findings.buildWorkBlockPartition(consumerGoldenFindings(true));

    expect(systemic.coherence_trace).toEqual(regular.coherence_trace);
    expect(componentMembers(systemic.blocks)).toEqual(GOLDEN.components);
    const owning = systemic.blocks.find((block) =>
      ((block.finding_ids as string[]) ?? []).includes("a"),
    );
    expect(owning).toMatchObject({ role: "coordination" });
    expect(owning?.finding_ids).toEqual(["a", "b", "c"]);
  });

  it("emits no trace field without a production reader", async () => {
    const core = await loadCore();
    // The persisted contract's shape IS the schema (.strict(), so an extra key
    // is a validation error rather than silent payload). Both the schema and a
    // real returned trace must carry exactly the consumed set.
    expect(Object.keys(core.ContentCoherenceTraceSchema.shape).sort()).toEqual(
      [...TRACE_FIELDS],
    );
    const trace = core.buildContentCoherenceTrace(goldenInput());
    expect(Object.keys(trace).sort()).toEqual([...TRACE_FIELDS]);
    // The empty draw carries the same shape — no field appears only when
    // populated.
    expect(
      Object.keys(core.buildContentCoherenceTrace({ items: [] })).sort(),
    ).toEqual([...TRACE_FIELDS]);
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
    const trace = core.buildContentCoherenceTrace({ items });
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
