import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath } from "../graphPathUtils.js";
import {
  isPythonSourcePath,
  resolvePythonFromImportTargets,
  resolvePythonImportTarget,
} from "../graphPythonImports.js";
import type { AnalyzerContext, AnalyzerOutput, LanguageAnalyzer } from "./types.js";
import { getTreeSitterParser, type TsNode } from "./treeSitter.js";

// Set above the regex floor's 0.95 so the merge prefers the AST-resolved edge
// for the same (from, to). Resolution itself is shared with the floor, so the
// only difference is parse-grade extraction.
const PY_IMPORT_EDGE_CONFIDENCE = 0.97;
const MAX_PYTHON_SOURCE_BYTES = 512 * 1024;

function supports(file: string): boolean {
  return isPythonSourcePath(file);
}

/** The bare module text for one `import` name (unwrapping `x.y as z`). */
function importModuleText(nameNode: TsNode): string | undefined {
  const moduleNode =
    nameNode.type === "aliased_import"
      ? nameNode.childForFieldName("name")
      : nameNode;
  const text = moduleNode?.text?.trim();
  return text && text.length > 0 ? text : undefined;
}

function collectFileEdges(
  fromPath: string,
  root: TsNode,
  pathLookup: Map<string, string>,
  edges: GraphEdge[],
): void {
  const seen = new Set<string>();
  const push = (
    target: string,
    kind: "py-import" | "py-from-import",
    specifier: string,
  ): void => {
    if (target === fromPath) return;
    const key = `${kind}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind,
        confidence: PY_IMPORT_EDGE_CONFIDENCE,
        reason: `tree-sitter resolved Python import '${specifier}' to '${target}'.`,
      }),
    );
  };

  for (const node of root.descendantsOfType("import_statement")) {
    for (const nameNode of childrenForField(node, "name")) {
      const specifier = importModuleText(nameNode);
      if (!specifier) continue;
      const target = resolvePythonImportTarget(fromPath, specifier, pathLookup);
      if (target) push(target, "py-import", specifier);
    }
  }

  for (const node of root.descendantsOfType("import_from_statement")) {
    const moduleNode = node.childForFieldName("module_name");
    const moduleSpecifier = moduleNode?.text?.trim();
    if (!moduleSpecifier) continue;
    const importedNames = childrenForField(node, "name")
      .map((nameNode) => importModuleText(nameNode))
      .filter((name): name is string => Boolean(name));
    for (const { specifier, target } of resolvePythonFromImportTargets(
      fromPath,
      moduleSpecifier,
      importedNames,
      pathLookup,
    )) {
      push(target, "py-from-import", specifier);
    }
  }
}

/** web-tree-sitter Node#childrenForFieldName, guarded for older runtimes. */
function childrenForField(node: TsNode, field: string): TsNode[] {
  const fn = (node as unknown as {
    childrenForFieldName?: (name: string) => TsNode[];
  }).childrenForFieldName;
  if (typeof fn === "function") {
    return fn.call(node, field) ?? [];
  }
  const single = node.childForFieldName(field);
  return single ? [single] : [];
}

async function analyze(
  files: string[],
  context: AnalyzerContext,
): Promise<AnalyzerOutput> {
  if (files.length === 0) return { edges: [] };
  const parser = await getTreeSitterParser("python", context.dependencyPath);
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
    if (content.length > MAX_PYTHON_SOURCE_BYTES) continue;
    try {
      const tree = parser.parse(content);
      collectFileEdges(
        normalizeGraphPath(file),
        tree.rootNode,
        context.pathLookup,
        edges,
      );
    } catch (e) {
      process.stderr.write(`[audit-code] python-analyzer: parse failed for '${file}': ${(e as Error).message ?? String(e)}\n`);
    }
  }
  return { edges };
}

export const pythonAnalyzer: LanguageAnalyzer = {
  id: "python",
  dependency: "web-tree-sitter",
  supports,
  analyze,
};
