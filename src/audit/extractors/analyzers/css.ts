import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath } from "../graphPathUtils.js";
import type { AnalyzerContext, AnalyzerOutput, LanguageAnalyzer } from "./types.js";
import { getTreeSitterParser, type TsNode } from "./treeSitter.js";
import { resolveResourceUrl } from "./resourceUrl.js";

const CSS_IMPORT_EDGE_CONFIDENCE = 0.9;
const CSS_URL_EDGE_CONFIDENCE = 0.82;
const MAX_CSS_SOURCE_BYTES = 512 * 1024;

function supports(file: string): boolean {
  return normalizeGraphPath(file).toLowerCase().endsWith(".css");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** First quoted or unquoted literal value beneath a node (string / url arg). */
function literalValue(node: TsNode): string | undefined {
  // tree-sitter-css string_value includes the surrounding quotes; plain_value
  // (unquoted url() args) does not.
  const value = node.descendantsOfType(["string_value", "plain_value"])[0];
  return value ? unquote(value.text) : undefined;
}

function collectFileEdges(
  fromPath: string,
  root: TsNode,
  pathLookup: Map<string, string>,
  edges: GraphEdge[],
): void {
  const importTargets = new Set<string>();

  // @import "x.css";  and  @import url("x.css");
  for (const statement of root.descendantsOfType("import_statement")) {
    const url = literalValue(statement);
    if (!url) continue;
    const target = resolveResourceUrl(fromPath, url, pathLookup);
    if (!target || target === fromPath || importTargets.has(target)) continue;
    importTargets.add(target);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "css-import",
        confidence: CSS_IMPORT_EDGE_CONFIDENCE,
        reason: `CSS @import references '${target}'.`,
      }),
    );
  }

  // url(...) references in declarations (background images, fonts, …).
  const seenUrls = new Set<string>(importTargets);
  for (const call of root.descendantsOfType("call_expression")) {
    if (!/^\s*url\s*\(/i.test(call.text)) continue;
    const url = literalValue(call);
    if (!url) continue;
    const target = resolveResourceUrl(fromPath, url, pathLookup);
    if (!target || target === fromPath || seenUrls.has(target)) continue;
    seenUrls.add(target);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "css-url",
        confidence: CSS_URL_EDGE_CONFIDENCE,
        reason: `CSS url() references '${target}'.`,
      }),
    );
  }
}

async function analyze(
  files: string[],
  context: AnalyzerContext,
): Promise<AnalyzerOutput> {
  if (files.length === 0) return { edges: [] };
  const parser = await getTreeSitterParser("css", context.dependencyPath);
  if (!parser) return { edges: [] };

  const root = resolve(context.root);
  const edges: GraphEdge[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(resolve(root, file), "utf8");
    } catch {
      continue;
    }
    if (content.length > MAX_CSS_SOURCE_BYTES) continue;
    try {
      const tree = parser.parse(content);
      collectFileEdges(
        normalizeGraphPath(file),
        tree.rootNode,
        context.pathLookup,
        edges,
      );
    } catch (e) {
      process.stderr.write(`[audit-code] css-analyzer: parse failed for '${file}': ${(e as Error).message ?? String(e)}\n`);
    }
  }
  return { edges };
}

export const cssAnalyzer: LanguageAnalyzer = {
  id: "css",
  dependency: "web-tree-sitter",
  supports,
  analyze,
};
