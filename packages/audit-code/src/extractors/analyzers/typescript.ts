import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as TS from "typescript";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate } from "../graphPathUtils.js";
import type { AnalyzerContext, AnalyzerOutput, LanguageAnalyzer } from "./types.js";
import {
  TS_CALL_EDGE_CONFIDENCE,
  TS_EXTENDS_EDGE_CONFIDENCE,
  TS_IMPLEMENTS_EDGE_CONFIDENCE,
  TS_IMPORT_EDGE_CONFIDENCE,
  TS_REEXPORT_EDGE_CONFIDENCE,
} from "./merge.js";

const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function supports(file: string): boolean {
  const lower = normalizeGraphPath(file).toLowerCase();
  if (lower.endsWith(".d.ts")) return false;
  return SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Load the TypeScript compiler module. Prefers the dependency resolved from the
 * audited repo / shared cache (so its tsconfig + version semantics match);
 * falls back to the bundled `typescript` so the analyzer still works when the
 * caller did not pin a path.
 */
async function loadTypescript(dependencyPath?: string): Promise<typeof TS> {
  if (dependencyPath) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dependencyPath, "package.json"), "utf8"),
      ) as { main?: string };
      const mainPath = resolve(dependencyPath, manifest.main ?? "index.js");
      const mod = (await import(pathToFileURL(mainPath).href)) as {
        default?: typeof TS;
      } & typeof TS;
      return (mod.default ?? mod) as typeof TS;
    } catch (e) {
      process.stderr.write(
        `[audit-code] typescript-analyzer: failed to load TypeScript from '${dependencyPath}', falling back to bundled: ${(e as Error).message ?? String(e)}\n`,
      );
    }
  }
  const mod = (await import("typescript")) as { default?: typeof TS } & typeof TS;
  return (mod.default ?? mod) as typeof TS;
}

function loadCompilerOptions(
  ts: typeof TS,
  root: string,
): TS.CompilerOptions {
  let options: TS.CompilerOptions = {};
  try {
    const configPath = ts.findConfigFile(
      root,
      (path) => ts.sys.fileExists(path),
      "tsconfig.json",
    );
    if (configPath) {
      const read = ts.readConfigFile(configPath, (path) =>
        ts.sys.readFile(path),
      );
      const parsed = ts.parseJsonConfigFileContent(
        read.config ?? {},
        ts.sys,
        dirname(configPath),
      );
      options = parsed.options;
    }
  } catch (e) {
    process.stderr.write(
      `[audit-code] typescript-analyzer: failed to load compiler options from '${root}', using defaults: ${(e as Error).message ?? String(e)}\n`,
    );
    options = {};
  }
  // Force a lenient, emit-free, JS-aware program: we only want resolution + the
  // checker, never diagnostics or output.
  return {
    ...options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    declaration: false,
    composite: false,
    incremental: false,
  };
}

interface AnalyzeState {
  ts: typeof TS;
  options: TS.CompilerOptions;
  checker: TS.TypeChecker;
  context: AnalyzerContext;
  root: string;
}

/** Map an absolute file path back to its canonical audit-included repo path. */
function mapToIncluded(
  state: AnalyzeState,
  absolutePath: string,
): string | undefined {
  const normalizedAbsolute = isAbsolute(absolutePath)
    ? absolutePath
    : resolve(state.root, absolutePath);
  const relativePath = normalizeGraphPath(
    relative(state.root, normalizedAbsolute),
  );
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }
  return resolveCandidate(relativePath, state.context.pathLookup);
}

function resolveSpecifierTarget(
  state: AnalyzeState,
  specifier: string,
  containingFile: string,
): string | undefined {
  const resolved = state.ts.resolveModuleName(
    specifier,
    containingFile,
    state.options,
    state.ts.sys,
  );
  const target = resolved.resolvedModule;
  if (
    !target ||
    target.isExternalLibraryImport ||
    target.resolvedFileName.endsWith(".d.ts")
  ) {
    return undefined;
  }
  return mapToIncluded(state, target.resolvedFileName);
}

/** Follow import aliases to the symbol's real declaration source file. */
function resolveSymbolToIncluded(
  state: AnalyzeState,
  symbol: TS.Symbol | undefined,
): string | undefined {
  if (!symbol) return undefined;
  let resolved = symbol;
  if (resolved.flags & state.ts.SymbolFlags.Alias) {
    try {
      resolved = state.checker.getAliasedSymbol(resolved);
    } catch (_e) {
      // getAliasedSymbol can throw for malformed programs; keep the un-aliased symbol.
    }
  }
  for (const declaration of resolved.declarations ?? []) {
    const fileName = declaration.getSourceFile().fileName;
    if (fileName.endsWith(".d.ts")) continue;
    const included = mapToIncluded(state, fileName);
    if (included) return included;
  }
  return undefined;
}

function collectFileEdges(
  state: AnalyzeState,
  sourceFile: TS.SourceFile,
  fromPath: string,
  imports: GraphEdge[],
  references: GraphEdge[],
  calls: GraphEdge[],
): void {
  const ts = state.ts;
  const callTargets = new Set<string>();

  const recordCall = (target: string | undefined): void => {
    if (!target || target === fromPath || callTargets.has(target)) return;
    callTargets.add(target);
    calls.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "ts-call",
        confidence: TS_CALL_EDGE_CONFIDENCE,
        reason: `TypeScript checker resolved a cross-file call into '${target}'.`,
      }),
    );
  };

  const visitHeritage = (
    node: TS.ClassLikeDeclaration | TS.InterfaceDeclaration,
  ): void => {
    for (const clause of node.heritageClauses ?? []) {
      const isExtends = clause.token === ts.SyntaxKind.ExtendsKeyword;
      for (const typeNode of clause.types) {
        const target = resolveSymbolToIncluded(
          state,
          state.checker.getSymbolAtLocation(typeNode.expression),
        );
        if (!target || target === fromPath) continue;
        references.push(
          graphEdge({
            from: fromPath,
            to: target,
            kind: isExtends ? "ts-extends" : "ts-implements",
            confidence: isExtends
              ? TS_EXTENDS_EDGE_CONFIDENCE
              : TS_IMPLEMENTS_EDGE_CONFIDENCE,
            reason: `TypeScript ${isExtends ? "extends" : "implements"} heritage resolves to '${target}'.`,
          }),
        );
      }
    }
  };

  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifierTarget(
        state,
        node.moduleSpecifier.text,
        sourceFile.fileName,
      );
      if (target && target !== fromPath) {
        imports.push(
          graphEdge({
            from: fromPath,
            to: target,
            kind: "ts-import",
            confidence: TS_IMPORT_EDGE_CONFIDENCE,
            reason: `TypeScript resolved import '${node.moduleSpecifier.text}' to '${target}'.`,
          }),
        );
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const target = resolveSpecifierTarget(
        state,
        node.moduleSpecifier.text,
        sourceFile.fileName,
      );
      if (target && target !== fromPath) {
        imports.push(
          graphEdge({
            from: fromPath,
            to: target,
            kind: "ts-reexport",
            confidence: TS_REEXPORT_EDGE_CONFIDENCE,
            reason: `TypeScript resolved re-export '${node.moduleSpecifier.text}' to '${target}'.`,
          }),
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      const target = resolveSpecifierTarget(
        state,
        node.moduleReference.expression.text,
        sourceFile.fileName,
      );
      if (target && target !== fromPath) {
        imports.push(
          graphEdge({
            from: fromPath,
            to: target,
            kind: "ts-import",
            confidence: TS_IMPORT_EDGE_CONFIDENCE,
            reason: `TypeScript resolved import-equals to '${target}'.`,
          }),
        );
      }
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const target = resolveSpecifierTarget(
          state,
          node.arguments[0].text,
          sourceFile.fileName,
        );
        if (target && target !== fromPath) {
          imports.push(
            graphEdge({
              from: fromPath,
              to: target,
              kind: "ts-import",
              confidence: TS_IMPORT_EDGE_CONFIDENCE,
              reason: `TypeScript resolved dynamic import to '${target}'.`,
            }),
          );
        }
      } else {
        recordCall(
          resolveSymbolToIncluded(
            state,
            state.checker.getSymbolAtLocation(node.expression),
          ),
        );
      }
    } else if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      visitHeritage(node);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
}

async function analyze(
  files: string[],
  context: AnalyzerContext,
): Promise<AnalyzerOutput> {
  if (files.length === 0) return { edges: [] };

  let ts: typeof TS;
  try {
    ts = await loadTypescript(context.dependencyPath);
  } catch (e) {
    process.stderr.write(
      `[audit-code] typescript-analyzer: failed to load TypeScript compiler, skipping ${files.length} file(s): ${(e as Error).message ?? String(e)}\n`,
    );
    return { edges: [] };
  }

  try {
    const root = resolve(context.root);
    const options = loadCompilerOptions(ts, root);
    const rootNames = files.map((file) => resolve(root, file));
    const program = ts.createProgram({ rootNames, options });
    const checker = program.getTypeChecker();
    const state: AnalyzeState = { ts, options, checker, context, root };

    const imports: GraphEdge[] = [];
    const references: GraphEdge[] = [];
    const calls: GraphEdge[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      const fromPath = mapToIncluded(state, sourceFile.fileName);
      if (!fromPath) continue;
      collectFileEdges(state, sourceFile, fromPath, imports, references, calls);
    }

    return { edges: [...imports, ...references, ...calls] };
  } catch (e) {
    process.stderr.write(
      `[audit-code] typescript-analyzer: program analysis failed for ${files.length} file(s) under '${context.root}', degrading to regex floor: ${(e as Error).message ?? String(e)}\n`,
    );
    return { edges: [] };
  }
}

export const typescriptAnalyzer: LanguageAnalyzer = {
  id: "typescript",
  dependency: "typescript@5",
  supports,
  analyze,
};
