// Channel-pure charter packets (design resolution 4): the comment strip/extract
// complement pair, the structural declaration heuristic, the single-sourced
// read-set, the per-channel packet purity companion assertions from the
// design-check record, and the register's discard-on-version-mismatch read.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { StructureDecomposition } from "../../src/audit/types/structureDecomposition.js";

const { extractCommentText, stripCommentText } = await import(
  "../../src/audit/extractors/commentDecomposition.js"
);
const {
  charterPacketReadSet,
  topLevelDeclarationLines,
  materializeCharterPacket,
} = await import("../../src/audit/orchestrator/charterPackets.js");
const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");
const { CHARTER_REGISTER_SCHEMA_VERSION } = await import(
  "../../src/audit/types/charterRegister.js"
);

describe("stripCommentText — the extract complement (one grammar, two views)", () => {
  it("removes line + block comments, keeps code and string literals", () => {
    const src = 'a = 1 // line\nb /* blk */ = "x // y"';
    const stripped = stripCommentText(src, "f.ts");
    expect(stripped).not.toContain("line");
    expect(stripped).not.toContain("blk");
    expect(stripped).toContain('"x // y"');
    expect(stripped).toContain("a = 1");
  });

  it("partitions the file with extractCommentText: comment text never survives both views", () => {
    const src = "// intent note\nconst x = 1; /* why */\n";
    const comments = extractCommentText(src, "f.ts");
    const stripped = stripCommentText(src, "f.ts");
    expect(comments).toContain("intent note");
    expect(comments).toContain("why");
    expect(stripped).not.toContain("intent note");
    expect(stripped).not.toContain("why");
    expect(stripped).toContain("const x = 1;");
  });

  it("honours per-language syntax (python # + docstrings)", () => {
    const stripped = stripCommentText('# note\nx = 1\n"""doc"""', "f.py");
    expect(stripped).not.toContain("note");
    expect(stripped).not.toContain("doc");
    expect(stripped).toContain("x = 1");
  });

  it("collapses blank-line runs left by removed comment blocks", () => {
    const src = "a = 1\n// one\n// two\n// three\n\nb = 2\n";
    const stripped = stripCommentText(src, "f.ts");
    expect(stripped).not.toContain("\n\n\n");
    expect(stripped).toContain("a = 1");
    expect(stripped).toContain("b = 2");
  });

  it("returns comment-free source unchanged", () => {
    expect(stripCommentText("const x = 1;\n", "f.ts")).toBe("const x = 1;\n");
  });
});

describe("topLevelDeclarationLines — the structural channel's heuristic lead", () => {
  function numbered(texts: string[]) {
    return texts.map((text, i) => ({ line: i + 1, text }));
  }

  it("keeps indent-zero declarations, drops indented bodies and bare closers", () => {
    const lines = topLevelDeclarationLines(
      numbered([
        'import { z } from "zod";',
        "export function alpha(a: number): number {",
        "  return a + 1;",
        "}",
        "export const BETA = 2;",
      ]),
    );
    const texts = lines.map((entry) => entry.text);
    expect(texts).toContain('import { z } from "zod";');
    expect(texts).toContain("export function alpha(a: number): number {");
    expect(texts).toContain("export const BETA = 2;");
    expect(texts.join("\n")).not.toContain("return a + 1;");
    expect(texts).not.toContain("}");
  });

  it("keeps each declaration's TRUE source line, not its index in the kept set", () => {
    // The whole point of the shape change: a lane citing `BETA` must be able to
    // copy line 5, not the "3rd kept declaration".
    const lines = topLevelDeclarationLines(
      numbered([
        'import { z } from "zod";',
        "export function alpha(a: number): number {",
        "  return a + 1;",
        "}",
        "export const BETA = 2;",
      ]),
    );
    expect(lines.find((entry) => entry.text.includes("BETA"))?.line).toBe(5);
  });

  it("truncates pathological single lines", () => {
    const long = `export const X = "${"y".repeat(400)}";`;
    const [line] = topLevelDeclarationLines([{ line: 1, text: long }]);
    expect(line!.text.length).toBeLessThanOrEqual(201);
    expect(line!.text).toContain("…");
  });
});

// ── Fixtures for the packet + read-set layer ─────────────────────────────────

const CODE_BODY_MARKER = "secretBodyDetail";
const COMMENT_MARKER = "intentCommentMarker";
const DOC_MARKER = "readmePurposeMarker";

function makeStructure(): StructureDecomposition {
  return {
    generated_at: "2026-08-06T00:00:00Z",
    target: "structure",
    node_universe_size: 3,
    source_ids: ["s"],
    consensus: [
      {
        node_id: "src/a.ts",
        members: ["src/a.ts", "src/b.ts"],
        agreed_across_source: 1,
        stable_across_scale: 1,
        contested: false,
      },
    ],
    contested: [],
    findings: [],
  };
}

function makeBundle(): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-08-06T00:00:00Z",
      files: [
        { path: "src/a.ts", language: "ts", size_bytes: 100, hash: "h-a" },
        { path: "src/b.ts", language: "ts", size_bytes: 100, hash: "h-b" },
        { path: "README.md", language: "md", size_bytes: 50, hash: "h-r" },
      ],
    },
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "src/b.ts", status: "included" },
        { path: "README.md", status: "doc_only" },
      ],
    },
    structure_decomposition: makeStructure(),
    graph_bundle: {
      graphs: {
        imports: [{ from: "src/b.ts", to: "src/a.ts", kind: "import" }],
      },
    },
  } as ArtifactBundle;
}

async function makeRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "charter-packets-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    [
      `// ${COMMENT_MARKER}: this module exists so budgets are respected`,
      "export function alpha(): number {",
      `  return ${CODE_BODY_MARKER};`,
      "}",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "b.ts"),
    ['import { alpha } from "./a.js";', "export const beta = alpha();"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "README.md"),
    `# Fixture\n\n${DOC_MARKER}: the repo exists to demonstrate packets.\n`,
    "utf8",
  );
  return root;
}

describe("charterPacketReadSet — the single-sourced read-set", () => {
  it("is consensus members ∪ doc-intent files, path-sorted", () => {
    const { memberPaths, docPaths } = charterPacketReadSet(makeBundle());
    expect(memberPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(docPaths).toEqual(["README.md"]);
  });
});

describe("materializeCharterPacket — blindness is a property of the input", () => {
  it("revealed: comment-stripped bodies — no comment text, no docs", async () => {
    const root = await makeRepoRoot();
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "revealed",
    });
    expect(markdown).toContain(CODE_BODY_MARKER);
    expect(markdown).not.toContain(COMMENT_MARKER);
    expect(markdown).not.toContain(DOC_MARKER);
  });

  it("structural: tree + edges + declarations — no bodies, no comments, no docs", async () => {
    const root = await makeRepoRoot();
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "structural",
    });
    expect(markdown).toContain("src/a.ts");
    expect(markdown).toContain("src/b.ts → src/a.ts");
    expect(markdown).toContain("export function alpha(): number {");
    expect(markdown).not.toContain(CODE_BODY_MARKER);
    expect(markdown).not.toContain(COMMENT_MARKER);
    expect(markdown).not.toContain(DOC_MARKER);
  });

  it("stated: docs + extracted comments — no code bodies", async () => {
    const root = await makeRepoRoot();
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    expect(markdown).toContain(DOC_MARKER);
    expect(markdown).toContain(COMMENT_MARKER);
    expect(markdown).not.toContain(CODE_BODY_MARKER);
  });

  it("refuses a packet for the true kind (nominated downstream, never extracted)", async () => {
    const root = await makeRepoRoot();
    await expect(
      materializeCharterPacket({ root, bundle: makeBundle(), kind: "true" }),
    ).rejects.toThrow(/never extracted/);
  });

  it("names unreadable files in the omitted list instead of silently skipping", async () => {
    const root = await mkdtemp(join(tmpdir(), "charter-packets-empty-"));
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "revealed",
    });
    expect(markdown).toContain("Omitted");
    expect(markdown).toContain("src/a.ts (unreadable or oversized)");
  });
});

// ── The packet states what it delivered, and where every line came from ──────

/** Docs whose total blows the whole packet ceiling, plus two commented members. */
async function makeOverflowRepoRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "charter-packets-overflow-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "README.md"),
    // MANY lines, as a real doc corpus has — the measured case was 95 doc files
    // costing 459,907 chars against a 150,000 budget, 3.07x over before the
    // comment loop was even reached.
    `# Fixture\n\n${DOC_MARKER}\n${"filler prose that exists only to blow the budget.\n".repeat(4_000)}`,
    "utf8",
  );
  await writeFile(
    join(root, "src", "a.ts"),
    [
      "export function alpha(): number {",
      `  return ${CODE_BODY_MARKER};`,
      "}",
      `// ${COMMENT_MARKER}: alpha exists so budgets are respected`,
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "b.ts"),
    [
      `// ${COMMENT_MARKER}: beta exists to prove the comment class is funded`,
      'import { alpha } from "./a.js";',
      "export const beta = alpha();",
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("materializeCharterPacket — the comment class is funded, not starved", () => {
  it("T1a: delivers source comments even when the doc class alone overflows the ceiling", async () => {
    const root = await makeOverflowRepoRoot();
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    // One greedy budget in doc-then-comment order spent the whole ceiling on
    // docs and reduced every comment section to its heading.
    expect(markdown).toContain(COMMENT_MARKER);
    expect(markdown).toContain(DOC_MARKER);
  });

  it("T1b: reports the comment class's delivery figure", async () => {
    const root = await makeOverflowRepoRoot();
    const { coverage } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    const comment = coverage.classes.find((c) => c.evidence_class === "comment");
    expect(comment?.named).toBe(2);
    expect(comment?.delivered).toBe(2);
  });

  it("stays inside the packet ceiling once metadata and prefixes are charged", async () => {
    const root = await makeOverflowRepoRoot();
    const { markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    expect(markdown.length).toBeLessThanOrEqual(150_000);
  });
});

describe("materializeCharterPacket — no candidate is silently absent (T2)", () => {
  it("reconciles delivered + omitted === named for every class", async () => {
    // src/b.ts carries NO comments in this fixture, so under the old builder it
    // appeared in neither the delivered nor the omitted list and `named` could
    // not be reconciled at all.
    const root = await makeRepoRoot();
    for (const kind of ["stated", "structural", "revealed"] as const) {
      const { coverage } = await materializeCharterPacket({
        root,
        bundle: makeBundle(),
        kind,
      });
      expect(coverage.classes.length).toBeGreaterThan(0);
      for (const entry of coverage.classes) {
        expect(
          entry.delivered + entry.omitted.length,
          `${kind}/${entry.evidence_class}`,
        ).toBe(entry.named);
      }
    }
  });

  it("names a member with no comments, with an explicit reason", async () => {
    const root = await makeRepoRoot();
    const { coverage, markdown } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    const comment = coverage.classes.find((c) => c.evidence_class === "comment");
    expect(comment?.omitted).toEqual([{ path: "src/b.ts", reason: "no_content" }]);
    expect(markdown).toContain("src/b.ts (no content of this evidence class");
  });
});

describe("materializeCharterPacket — provenance a lane copies (T3)", () => {
  function manifestOf(markdown: string) {
    const start = markdown.indexOf("```json");
    const end = markdown.indexOf("```", start + 7);
    return JSON.parse(markdown.slice(start + 7, end));
  }

  it("publishes true line runs in a machine manifest and repeats them per line", async () => {
    const root = await makeRepoRoot();
    const { markdown, excerpts } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    const manifest = manifestOf(markdown);
    expect(manifest.schema_version).toBe("charter-packet-manifest/v1");

    // The fixture's comment sits on line 1 of src/a.ts.
    const excerpt = excerpts.find((e) => e.source_path === "src/a.ts");
    expect(excerpt?.evidence_class).toBe("comment");
    expect(excerpt?.line_runs).toEqual([{ start: 1, end: 1 }]);
    const row = manifest.excerpts.find(
      (e: { source_path: string }) => e.source_path === "src/a.ts",
    );
    expect(row.line_runs).toEqual([{ start: 1, end: 1 }]);

    // …and the human body carries the same number on the line itself. The
    // comment's own leading space survives verbatim — the emitted prefix is a
    // fixed width a validator strips POSITIONALLY, so the text after it must not
    // be trimmed or the stripped quote would no longer match the file.
    expect(markdown).toMatch(new RegExp(`1\\|\\s+${COMMENT_MARKER}`));
    expect(markdown).toContain("lines 1");
  });

  it("numbers a structural declaration against the UNSTRIPPED file", async () => {
    const root = await makeRepoRoot();
    const { excerpts } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "structural",
    });
    // src/a.ts is: line 1 comment, line 2 `export function alpha…`.
    // Numbering against `stripCommentText` output would call it line 1.
    const excerpt = excerpts.find((e) => e.source_path === "src/a.ts");
    const decl = excerpt?.lines.find((l) => l.text.includes("export function alpha"));
    expect(decl?.line).toBe(2);
  });

  it("records a per-excerpt prefix width that strips positionally", async () => {
    const root = await makeRepoRoot();
    const { excerpts } = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "revealed",
    });
    const excerpt = excerpts.find((e) => e.source_path === "src/a.ts");
    // Widest line number is a single digit here: `2| ` is 3 characters.
    expect(excerpt?.prefix_width).toBe(3);
  });
});

describe("charter_register read policy — discard on schema-version mismatch", () => {
  it("a v1/unstamped register degrades to absent; a v2-stamped one survives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "charter-register-version-"));
    const v1 = {
      generated_at: "2026-08-01T00:00:00Z",
      target: "charter",
      ceiling: { rung: "deep" },
      subsystems: [],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      validation_issues: [],
    };
    await writeFile(
      join(dir, "charter_register.json"),
      JSON.stringify(v1),
      "utf8",
    );
    const stale = await loadArtifactBundle(dir);
    expect(stale.charter_register).toBeUndefined();

    await writeFile(
      join(dir, "charter_register.json"),
      JSON.stringify({
        ...v1,
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        triangulated: [],
        disagreement: [],
      }),
      "utf8",
    );
    const fresh = await loadArtifactBundle(dir);
    expect(fresh.charter_register).toBeDefined();
    expect(fresh.charter_register!.schema_version).toBe(
      CHARTER_REGISTER_SCHEMA_VERSION,
    );
  });
});
