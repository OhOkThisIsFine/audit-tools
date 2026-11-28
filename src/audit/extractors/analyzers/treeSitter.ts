import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWithinRoot } from "../../../shared/io/pathContainment.js";

/**
 * Shared web-tree-sitter loader for the Tier-S parser analyzers (Python / HTML /
 * CSS). web-tree-sitter is a pure-WASM runtime — no native compilation — so a
 * grammar parses identically on every platform; grammars ship as `.wasm` files
 * in `tree-sitter-wasms` (out/tree-sitter-<lang>.wasm).
 *
 * Everything here degrades to `undefined` on any failure (missing dependency,
 * missing grammar, init error) so a caller simply keeps the deterministic regex
 * floor. The runtime is initialised once and parsed grammars are cached.
 */

// sites-pinned: tests/audit-smoke.test.mjs
// Minimal structural typings — web-tree-sitter is an optional dependency, so we
// avoid a hard type import and model only the surface the analyzers use.
export interface TsNode {
  type: string;
  text: string;
  startPosition?: { row: number; column: number };
  endPosition?: { row: number; column: number };
  namedChildren: TsNode[];
  hasError?: boolean;
  childForFieldName(field: string): TsNode | null;
  descendantsOfType(type: string | string[]): TsNode[];
}
export interface TsTree {
  rootNode: TsNode;
  delete(): void;
}
export interface TsLanguage {
  __brand?: "tree-sitter-language";
}
export interface TsParser {
  setLanguage(language: TsLanguage): void;
  parse(source: string): TsTree;
  delete(): void;
}

interface ParserModule {
  Parser: {
    init(): Promise<void>;
    new (): TsParser;
  };
  Language: {
    load(path: string): Promise<TsLanguage>;
  };
}

const requireFromHere = createRequire(import.meta.url);

// The parser module is resolved per `dependencyPath`: a call with a different
// dependencyPath must resolve its own module rather than reusing the first
// resolution. Keyed by `dependencyPath ?? ""` so the bare-specifier path
// (no dependencyPath) gets a stable cache slot too.
const moduleCache = new Map<string, Promise<ParserModule | undefined>>();
const initCache = new Map<ParserModule, Promise<boolean>>();
const languageCache = new Map<ParserModule, Map<string, TsLanguage | null>>();

function selectedParserEntry(dependencyPath: string): string | undefined {
  const packageDir = realpathSync(dependencyPath);
  const manifestPath = join(packageDir, "package.json");
  const manifest = requireFromHere(manifestPath) as {
    exports?: unknown;
    main?: string;
    module?: string;
  };
  // Node selects the package's supported require export. For older packages
  // without exports, retain their existing module/main entry precedence.
  const entry = realpathSync(
    manifest.exports !== undefined
      ? createRequire(manifestPath).resolve("web-tree-sitter")
      : resolve(packageDir, manifest.module ?? manifest.main ?? "index.js"),
  );
  const contained = resolveWithinRoot(packageDir, entry, { allowRoot: false });
  return contained ? pathToFileURL(contained).href : undefined;
}

async function importParserModule(
  dependencyPath?: string,
): Promise<ParserModule | undefined> {
  let specifier = dependencyPath ?? "web-tree-sitter";
  try {
    if (dependencyPath !== undefined) {
      const entry = selectedParserEntry(dependencyPath);
      if (!entry) return undefined;
      specifier = entry;
    }
    const mod = (await import(specifier)) as Partial<ParserModule> & {
      default?: Partial<ParserModule>;
    };
    const resolved = mod.Parser && mod.Language ? mod : mod.default;
    if (typeof resolved?.Parser === "function" &&
        typeof resolved.Parser.init === "function" &&
        typeof resolved.Language?.load === "function") {
      return resolved as ParserModule;
    }
  } catch (e) {
    process.stderr.write(
      `[audit-code] tree-sitter: failed to import '${specifier}': ${(e as Error).message ?? String(e)}\n`,
    );
  }
  return undefined;
}

async function getModule(
  dependencyPath?: string,
): Promise<ParserModule | undefined> {
  const key = dependencyPath ?? "";
  let cached = moduleCache.get(key);
  if (!cached) {
    cached = importParserModule(dependencyPath);
    moduleCache.set(key, cached);
  }
  return cached;
}

async function ensureInit(parserModule: ParserModule): Promise<boolean> {
  let cached = initCache.get(parserModule);
  if (!cached) {
    cached = parserModule.Parser.init()
      .then(() => true)
      .catch((e: unknown) => {

        process.stderr.write(
          `[audit-code] tree-sitter: Parser.init() failed: ${(e as Error).message ?? String(e)}\n`,
        );
        return false;
      });
    initCache.set(parserModule, cached);
  }
  return cached;
}

function resolveGrammarPath(grammar: string): string | undefined {
  // tree-sitter-wasms ships prebuilt grammars under out/tree-sitter-<lang>.wasm.
  try {
    return requireFromHere.resolve(
      `tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`,
    );
  } catch {
    // Fall back to locating the package root, then the file under out/.
  }
  try {
    const pkg = requireFromHere.resolve("tree-sitter-wasms/package.json");
    return join(dirname(pkg), "out", `tree-sitter-${grammar}.wasm`);
  } catch {
    return undefined;
  }
}

async function loadLanguage(
  parserModule: ParserModule,
  grammar: string,
): Promise<TsLanguage | undefined> {
  let moduleMap = languageCache.get(parserModule);
  if (!moduleMap) {
    moduleMap = new Map();
    languageCache.set(parserModule, moduleMap);
  }
  if (moduleMap.has(grammar)) {
    return moduleMap.get(grammar) ?? undefined;
  }
  const grammarPath = resolveGrammarPath(grammar);
  if (!grammarPath) {
    moduleMap.set(grammar, null);
    return undefined;
  }
  try {
    const language = await parserModule.Language.load(grammarPath);
    moduleMap.set(grammar, language);
    return language;
  } catch (e) {
    process.stderr.write(
      `[audit-code] tree-sitter: failed to load grammar '${grammar}' from '${grammarPath}': ${(e as Error).message ?? String(e)}\n`,
    );
    moduleMap.set(grammar, null);
    return undefined;
  }
}

/**
 * Obtain a parser bound to `grammar` (e.g. "python", "html", "css"), or
 * `undefined` if web-tree-sitter or the grammar wasm cannot be loaded.
 */
export async function getTreeSitterParser(
  grammar: string,
  dependencyPath?: string,
): Promise<TsParser | undefined> {
  const parserModule = await getModule(dependencyPath);
  if (!parserModule) return undefined;
  if (!(await ensureInit(parserModule))) return undefined;
  const language = await loadLanguage(parserModule, grammar);
  if (!language) return undefined;
  try {
    const parser = new parserModule.Parser();
    try {
      parser.setLanguage(language);
    } catch (e) {
      parser.delete();
      throw e;
    }
    return parser;
  } catch (e) {
    process.stderr.write(
      `[audit-code] tree-sitter: failed to instantiate parser for grammar '${grammar}': ${(e as Error).message ?? String(e)}\n`,
    );
    return undefined;
  }
}
