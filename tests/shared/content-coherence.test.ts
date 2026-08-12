import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RED_SIGNATURE = "contract:shared-content-coherence:not-yet-satisfied";

type UnknownRecord = Record<string, unknown>;

interface CoreModule {
  readonly CONTENT_COHERENCE_SCORES: Readonly<Record<string, number>>;
  readonly buildContentCoherenceTrace: (input: UnknownRecord) => UnknownRecord;
}

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
      loaded.CONTENT_COHERENCE_SCORES === undefined
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
  eligible_candidates: [
    { left: "a", right: "c", score: 120 },
    { left: "a", right: "b", score: 110 },
    { left: "d", right: "e", score: 70 },
  ],
  merge_decisions: ["merge", "merge", "merge"],
  components: [
    ["a", "b", "c"],
    ["d", "e"],
  ],
} as const;

function traceProjection(trace: UnknownRecord): UnknownRecord {
  return {
    eligible_candidates: trace.eligible_candidates,
    merge_decisions: trace.merge_decisions,
    components: trace.components,
  };
}

function pair(
  trace: UnknownRecord,
  left: string,
  right: string,
): UnknownRecord {
  const pairs = trace.pair_scores;
  expect(Array.isArray(pairs)).toBe(true);
  const found = (pairs as UnknownRecord[]).find(
    (entry) => entry.left === left && entry.right === right,
  );
  expect(found, `missing pair ${left}/${right}`).toBeDefined();
  return found ?? {};
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
    const trace = core.buildContentCoherenceTrace({
      items: [
        {
          id: "left",
          file_paths: ["src/x.ts"],
          unit_ids: ["unit"],
          tags: ["tag"],
          critical_flow_ids: ["flow"],
        },
        {
          id: "right",
          file_paths: ["src/x.ts"],
          unit_ids: ["unit"],
          tags: ["tag"],
          critical_flow_ids: ["flow"],
        },
      ],
      relationships: [
        { left: "right", right: "left", kind: "shared_file" },
        { left: "left", right: "right", kind: "cross_lens_same_file" },
        { left: "left", right: "right", kind: "same_unit" },
        { left: "left", right: "right", kind: "call_adjacent" },
        { left: "left", right: "right", kind: "same_flow" },
        { left: "left", right: "right", kind: "same_lens" },
        { left: "left", right: "right", kind: "same_dir" },
      ],
    });
    expect(pair(trace, "left", "right")).toMatchObject({
      score: 350,
      eligible: true,
      evidence: {
        call_import_reference_adjacency: true,
        same_directory: true,
        shared_critical_flow: true,
        shared_file: true,
        shared_semantic_tag_or_same_lens: true,
        shared_unit: true,
      },
    });

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

  it("uses threshold 60, deterministic roots, and an already-connected trace", async () => {
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
    expect(pair(threshold, "a", "b")).toMatchObject({ score: 60, eligible: true });
    expect(pair(threshold, "c", "d")).toMatchObject({ score: 40, eligible: false });

    const triangle = core.buildContentCoherenceTrace({
      items: ["c", "a", "b"].map((id) => ({
        id,
        file_paths: ["src/shared.ts"],
        unit_ids: [],
        tags: [],
      })),
      relationships: [],
    });
    expect(triangle.merge_decisions).toEqual([
      "merge",
      "merge",
      "already_connected",
    ]);
    expect(triangle.components).toEqual([["a", "b", "c"]]);
    expect(triangle.merge_trace).toMatchObject([
      { left: "a", right: "b", decision: "merge", root: "a" },
      { left: "a", right: "c", decision: "merge", root: "a" },
      { left: "b", right: "c", decision: "already_connected", root: "a" },
    ]);
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
