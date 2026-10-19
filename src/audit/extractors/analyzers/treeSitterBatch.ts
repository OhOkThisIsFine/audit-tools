// sites-pinned: tests/audit/tree-sitter-analyzers.test.ts, tests/audit/tree-sitter-batch.test.ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { normalizeGraphPath } from "../graphPathUtils.js";
import type { AnalyzerContext, AnalyzerOutput } from "./types.js";
import { getTreeSitterParser, type TsNode } from "./treeSitter.js";

// Preserve the analyzers' historical JS string-length limit, not UTF-8 bytes.
const MAX_SOURCE_CODE_UNITS = 512 * 1024;

/** Internal batch lifecycle; language-specific collection stays in each analyzer. */
export async function analyzeTreeSitterFiles(
  files: string[],
  context: AnalyzerContext,
  grammar: string,
  warningLabel: string,
  collectFileEdges: (
    fromPath: string,
    root: TsNode,
    pathLookup: Map<string, string>,
    edges: GraphEdge[],
  ) => void,
  loadParser: typeof getTreeSitterParser = getTreeSitterParser,
  prepareBatch?: () => void,
): Promise<AnalyzerOutput> {
  if (files.length === 0) return { edges: [] };
  const parser = await loadParser(grammar, context.dependencyPath);
  if (!parser) return { edges: [] };
  try {
    prepareBatch?.();

    const root = resolve(context.root);
    const edges: GraphEdge[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch {
        continue;
      }
      if (content.length > MAX_SOURCE_CODE_UNITS) continue;
      try {
        const tree = parser.parse(content);
        try {
          collectFileEdges(normalizeGraphPath(file), tree.rootNode, context.pathLookup, edges);
        } finally {
          tree.delete();
        }
      } catch (e) {
        process.stderr.write(`[audit-code] ${warningLabel}: parse failed for '${file}': ${(e as Error).message ?? String(e)}\n`);
      }
    }
    return { edges };
  } finally {
    parser.delete();
  }
}
