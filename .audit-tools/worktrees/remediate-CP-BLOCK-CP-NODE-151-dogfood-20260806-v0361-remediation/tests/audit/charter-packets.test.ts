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
  it("keeps indent-zero declarations, drops indented bodies and bare closers", () => {
    const stripped = [
      'import { z } from "zod";',
      "export function alpha(a: number): number {",
      "  return a + 1;",
      "}",
      "export const BETA = 2;",
    ].join("\n");
    const lines = topLevelDeclarationLines(stripped);
    expect(lines).toContain('import { z } from "zod";');
    expect(lines).toContain("export function alpha(a: number): number {");
    expect(lines).toContain("export const BETA = 2;");
    expect(lines.join("\n")).not.toContain("return a + 1;");
    expect(lines).not.toContain("}");
  });

  it("truncates pathological single lines", () => {
    const long = `export const X = "${"y".repeat(400)}";`;
    const [line] = topLevelDeclarationLines(long);
    expect(line!.length).toBeLessThanOrEqual(201);
    expect(line).toContain("…");
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
    const packet = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "revealed",
    });
    expect(packet).toContain(CODE_BODY_MARKER);
    expect(packet).not.toContain(COMMENT_MARKER);
    expect(packet).not.toContain(DOC_MARKER);
  });

  it("structural: tree + edges + declarations — no bodies, no comments, no docs", async () => {
    const root = await makeRepoRoot();
    const packet = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "structural",
    });
    expect(packet).toContain("src/a.ts");
    expect(packet).toContain("src/b.ts → src/a.ts");
    expect(packet).toContain("export function alpha(): number {");
    expect(packet).not.toContain(CODE_BODY_MARKER);
    expect(packet).not.toContain(COMMENT_MARKER);
    expect(packet).not.toContain(DOC_MARKER);
  });

  it("stated: docs + extracted comments — no code bodies", async () => {
    const root = await makeRepoRoot();
    const packet = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "stated",
    });
    expect(packet).toContain(DOC_MARKER);
    expect(packet).toContain(COMMENT_MARKER);
    expect(packet).not.toContain(CODE_BODY_MARKER);
  });

  it("refuses a packet for the true kind (nominated downstream, never extracted)", async () => {
    const root = await makeRepoRoot();
    await expect(
      materializeCharterPacket({ root, bundle: makeBundle(), kind: "true" }),
    ).rejects.toThrow(/never extracted/);
  });

  it("names unreadable files in the omitted list instead of silently skipping", async () => {
    const root = await mkdtemp(join(tmpdir(), "charter-packets-empty-"));
    const packet = await materializeCharterPacket({
      root,
      bundle: makeBundle(),
      kind: "revealed",
    });
    expect(packet).toContain("Omitted");
    expect(packet).toContain("src/a.ts (unreadable or oversized)");
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
