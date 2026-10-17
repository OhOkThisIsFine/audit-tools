// sites-pinned: tests/audit/tree-sitter-analyzers.test.ts, tests/audit/tree-sitter-batch.test.ts
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath } from "../graphPathUtils.js";
import type { AnalyzerContext, AnalyzerOutput, LanguageAnalyzer } from "./types.js";
import type { TsNode } from "./treeSitter.js";
import { analyzeTreeSitterFiles } from "./treeSitterBatch.js";
import { resolveResourceUrl } from "./resourceUrl.js";

// Above the regex floor's html-resource-link so the merge prefers the parsed
// edge for the same (from, to).
const HTML_RESOURCE_EDGE_CONFIDENCE = 0.96;
const HTML_EXTENSIONS = [".html", ".htm"] as const;

// tag → the attribute carrying its resource reference. Single-sourced here and
// consumed by the regex floor (browserExtension.ts) so both the tree-sitter
// analyzer and the floor track the same tag→attribute relationships.
export const HTML_RESOURCE_ATTRIBUTE: Record<string, string> = {
  script: "src",
  link: "href",
  img: "src",
};

function supports(file: string): boolean {
  const lower = normalizeGraphPath(file).toLowerCase();
  return HTML_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function attributeValue(tag: TsNode, name: string): string | undefined {
  for (const attribute of tag.descendantsOfType("attribute")) {
    const attributeName = attribute
      .descendantsOfType("attribute_name")[0]
      ?.text?.toLowerCase();
    if (attributeName !== name) continue;
    const value = attribute.descendantsOfType("attribute_value")[0]?.text;
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function collectFileEdges(
  fromPath: string,
  root: TsNode,
  pathLookup: Map<string, string>,
  edges: GraphEdge[],
): void {
  const seen = new Set<string>();
  for (const tag of root.descendantsOfType("start_tag")) {
    const tagName = tag.descendantsOfType("tag_name")[0]?.text?.toLowerCase();
    if (!tagName) continue;
    const attribute = HTML_RESOURCE_ATTRIBUTE[tagName];
    if (!attribute) continue;
    const url = attributeValue(tag, attribute);
    if (!url) continue;
    const target = resolveResourceUrl(fromPath, url, pathLookup);
    if (!target || target === fromPath || seen.has(target)) continue;
    seen.add(target);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "html-resource",
        confidence: HTML_RESOURCE_EDGE_CONFIDENCE,
        reason: `HTML <${tagName} ${attribute}> references '${target}'.`,
      }),
    );
  }
}

async function analyze(
  files: string[],
  context: AnalyzerContext,
): Promise<AnalyzerOutput> {
  return analyzeTreeSitterFiles(
    files, context, "html", "html-analyzer", collectFileEdges,
  );
}

export const htmlAnalyzer: LanguageAnalyzer = {
  id: "html",
  dependency: "web-tree-sitter",
  supports,
  analyze,
};
