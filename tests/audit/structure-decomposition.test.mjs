import { describe, it, expect } from "vitest";

const { deriveDataStateCoupling } = await import(
  "../../src/audit/extractors/dataStateCoupling.ts"
);
const { extractCommentText, deriveCommentDecomposition, deriveDocGroups } =
  await import("../../src/audit/extractors/commentDecomposition.ts");
const { detectNonColocalization } = await import(
  "../../src/audit/decompose/findings.ts"
);
const { buildStructureDecomposition } = await import(
  "../../src/audit/decompose/buildStructureDecomposition.ts"
);
const { runStructureDecompositionExecutor } = await import(
  "../../src/audit/orchestrator/structureExecutors.ts"
);

/** A DI reader keyed by repo-relative path, tolerant of the join()'d absolute. */
function readerFrom(contents) {
  return async (abs) => {
    const p = abs.replace(/\\/g, "/");
    for (const [file, text] of Object.entries(contents)) {
      if (p.endsWith(file)) return text;
    }
    return undefined;
  };
}

describe("deriveDataStateCoupling — bibliographic coupling", () => {
  const bundle = {
    graphs: {
      imports: [
        { from: "a", to: "t" },
        { from: "b", to: "t" },
        { from: "c", to: "t" },
        { from: "a", to: "u" },
        { from: "b", to: "u" },
      ],
    },
  };

  it("couples files sharing at least the minimum targets", () => {
    // a,b share {t,u} = 2; a/c and b/c share only {t} = 1 (below min 2).
    expect(deriveDataStateCoupling(bundle)).toEqual([
      { a: "a", b: "b", weight: 2 },
    ]);
  });

  it("drops generic targets referenced by too many files", () => {
    // With a genericness cap of 1, both t and u are dropped → no coupling.
    expect(
      deriveDataStateCoupling(bundle, {
        genericAbsolute: 1,
        genericFraction: 0,
      }),
    ).toEqual([]);
  });

  it("degrades to [] on an edgeless bundle", () => {
    expect(deriveDataStateCoupling({ graphs: {} })).toEqual([]);
  });
});

describe("extractCommentText — language-neutral lexing", () => {
  it("extracts line + block comments and skips string literals", () => {
    const text = extractCommentText(
      'a = 1 // line\nb /* blk */ = "x // y"',
      "f.ts",
    );
    expect(text).toContain("line");
    expect(text).toContain("blk");
    expect(text).not.toContain("x // y");
  });

  it("does not treat a JS private field # as a comment", () => {
    expect(extractCommentText("this.#field = 1", "f.ts")).toBe("");
  });

  it("treats # as a comment and captures docstrings in Python", () => {
    const text = extractCommentText('# note\nx = 1\n"""doc"""', "f.py");
    expect(text).toContain("note");
    expect(text).toContain("doc");
  });

  it("captures markup comments", () => {
    expect(extractCommentText("<p>x</p><!-- hidden -->", "f.md")).toContain(
      "hidden",
    );
  });
});

describe("deriveCommentDecomposition — comment cross-references", () => {
  it("edges files whose comments name another in-scope file by path", async () => {
    const result = await deriveCommentDecomposition({
      root: "/repo",
      files: ["src/pay/charge.ts", "src/pay/refund.ts"],
      readFileText: readerFrom({
        "src/pay/charge.ts": "// reverse handled in src/pay/refund.ts\ncode",
        "src/pay/refund.ts": "code with no references",
      }),
    });
    expect(result.scannedFiles).toBe(2);
    expect(result.edges).toEqual([
      { a: "src/pay/charge.ts", b: "src/pay/refund.ts", weight: 1 },
    ]);
  });

  it("ignores references that appear outside comments", async () => {
    const result = await deriveCommentDecomposition({
      root: "/repo",
      files: ["src/pay/charge.ts", "src/pay/refund.ts"],
      readFileText: readerFrom({
        // The path appears only in code, not a comment → no intent edge.
        "src/pay/charge.ts": 'import "src/pay/refund.ts";',
        "src/pay/refund.ts": "code",
      }),
    });
    expect(result.edges).toEqual([]);
  });
});

describe("deriveDocGroups — docs naming files together", () => {
  it("groups the code files a single doc names", async () => {
    const groups = await deriveDocGroups({
      root: "/repo",
      docFiles: ["README.md"],
      codeFiles: ["src/pay/charge.ts", "src/pay/refund.ts", "src/util/log.ts"],
      readFileText: readerFrom({
        "README.md":
          "The payment module spans src/pay/charge.ts and src/pay/refund.ts.",
      }),
    });
    expect(groups).toEqual([["src/pay/charge.ts", "src/pay/refund.ts"]]);
  });
});

describe("detectNonColocalization — the two first-class findings", () => {
  it("flags a behavioral cluster with no declared purpose", () => {
    const behaviorPartitions = [
      new Map([
        ["a", "a"],
        ["b", "a"],
        ["c", "a"],
      ]),
    ];
    const findings = detectNonColocalization({
      behaviorPartitions,
      // No intent boundary contains the {a,b,c} cluster.
      intentBoundaries: [["d", "e"]],
      purposeGroups: [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("non_colocalization_behavioral");
    expect(findings[0].lens).toBe("architecture");
    expect(findings[0].confidence).toBe("low");
    expect(findings[0].affected_files.map((f) => f.path)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("flags a declared purpose that is behaviorally smeared", () => {
    const behaviorPartitions = [
      new Map([
        ["a", "a"],
        ["b", "a"],
        ["c", "a"],
      ]),
    ];
    const findings = detectNonColocalization({
      behaviorPartitions,
      intentBoundaries: [["a", "b", "c"]],
      // p,q are declared a unit but never co-cluster behaviorally.
      purposeGroups: [["p", "q"]],
    });
    const purpose = findings.filter(
      (f) => f.category === "non_colocalization_purpose",
    );
    expect(purpose).toHaveLength(1);
    expect(purpose[0].affected_files.map((f) => f.path)).toEqual(["p", "q"]);
  });

  it("emits nothing when behavior and intent co-localize", () => {
    const behaviorPartitions = [
      new Map([
        ["a", "a"],
        ["b", "a"],
        ["c", "a"],
      ]),
    ];
    expect(
      detectNonColocalization({
        behaviorPartitions,
        intentBoundaries: [["a", "b", "c"]],
        purposeGroups: [["a", "b", "c"]],
      }),
    ).toEqual([]);
  });
});

describe("buildStructureDecomposition + executor — end to end", () => {
  const files = [
    "src/pay/charge.ts",
    "src/pay/refund.ts",
    "src/pay/ledger.ts",
    "src/report/pdf.ts",
    "src/report/html.ts",
  ];
  const bundle = {
    repo_manifest: {
      repository: { name: "t" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: files.map((path) => ({ path, language: "ts", size_bytes: 10 })),
    },
    file_disposition: {
      files: files.map((path) => ({ path, status: "included" })),
    },
    graph_bundle: {
      graphs: {
        imports: [
          { from: "src/pay/charge.ts", to: "src/pay/ledger.ts" },
          { from: "src/pay/refund.ts", to: "src/pay/ledger.ts" },
          { from: "src/pay/charge.ts", to: "src/pay/refund.ts" },
          { from: "src/report/pdf.ts", to: "src/report/html.ts" },
        ],
      },
    },
  };

  it("produces a scaffold + findings artifact (no root → intent from dir only)", async () => {
    const decomposition = await buildStructureDecomposition({
      repoManifest: bundle.repo_manifest,
      disposition: bundle.file_disposition,
      graphBundle: bundle.graph_bundle,
    });
    expect(decomposition.target).toBe("structure");
    expect(decomposition.node_universe_size).toBe(5);
    expect(decomposition.source_ids).toContain("call_import");
    expect(decomposition.source_ids).toContain("directory");
    // The payment files (behavior-coupled AND in one directory) co-localize.
    const allNodes = [...decomposition.consensus, ...decomposition.contested];
    const payNode = allNodes.find((n) =>
      n.members.includes("src/pay/charge.ts"),
    );
    expect(payNode).toBeDefined();
    expect(payNode.members).toContain("src/pay/refund.ts");
    expect(Array.isArray(decomposition.findings)).toBe(true);
  });

  it("executor returns the uniform run result and updates the bundle", async () => {
    const result = await runStructureDecompositionExecutor(bundle);
    expect(result.artifacts_written).toEqual(["structure_decomposition.json"]);
    expect(result.updated.structure_decomposition).toBeDefined();
    expect(result.updated.structure_decomposition.target).toBe("structure");
    expect(result.progress_summary).toContain("Structure decomposition");
  });

  it("throws without the required structure artifacts", async () => {
    await expect(
      runStructureDecompositionExecutor({ repo_manifest: bundle.repo_manifest }),
    ).rejects.toThrow(/structure artifacts/);
  });
});
