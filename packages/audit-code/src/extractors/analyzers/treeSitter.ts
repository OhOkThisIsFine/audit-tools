import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

// Minimal structural typings — web-tree-sitter is an optional dependency, so we
// avoid a hard type import and model only the surface the analyzers use.
export interface TsNode {
  type: string;
  text: string;
  namedChildren: TsNode[];
  childForFieldName(field: string): TsNode | null;
  descendantsOfType(type: string | string[]): TsNode[];
}
export interface TsTree {
  rootNode: TsNode;
}
export interface TsLanguage {
  __brand?: "tree-sitter-language";
}
export interface TsParser {
  setLanguage(language: TsLanguage): void;
  parse(source: string): TsTree;
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
const languageCache = new Map<string, TsLanguage | null>();

async function importParserModule(
  dependencyPath?: string,
): Promise<ParserModule | undefined> {
  const specifiers: string[] = [];
  if (dependencyPath) {
    try {
      const manifest = requireFromHere(
        join(dependencyPath, "package.json"),
      ) as { main?: string; module?: string };
      const entry = manifest.module ?? manifest.main ?? "index.js";
      specifiers.push(pathToFileURL(join(dependencyPath, entry)).href);
    } catch {
      // Fall through to the bare specifier.
    }
  }
  specifiers.push("web-tree-sitter");

  for (const specifier of specifiers) {
    try {
      const mod = (await import(specifier)) as Partial<ParserModule> & {
        default?: Partial<ParserModule>;
      };
      const resolved = (mod.Parser ? mod : mod.default) as
        | ParserModule
        | undefined;
      if (resolved?.Parser && resolved.Language) {
        return resolved;
      }
    } catch (e) {
      process.stderr.write(
        `[audit-code] tree-sitter: failed to import '${specifier}': ${(e as Error).message ?? String(e)}\n`,
      );
    }
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
  if (languageCache.has(grammar)) {
    return languageCache.get(grammar) ?? undefined;
  }
  const grammarPath = resolveGrammarPath(grammar);
  if (!grammarPath) {
    languageCache.set(grammar, null);
    return undefined;
  }
  try {
    const language = await parserModule.Language.load(grammarPath);
    languageCache.set(grammar, language);
    return language;
  } catch (e) {
    process.stderr.write(
      `[audit-code] tree-sitter: failed to load grammar '${grammar}' from '${grammarPath}': ${(e as Error).message ?? String(e)}\n`,
    );
    languageCache.set(grammar, null);
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
    parser.setLanguage(language);
    return parser;
  } catch (e) {
    process.stderr.write(
      `[audit-code] tree-sitter: failed to instantiate parser for grammar '${grammar}': ${(e as Error).message ?? String(e)}\n`,
    );
    return undefined;
  }
}

/** Test seam: reset the memoised runtime/grammar caches. */
export function __resetTreeSitterForTests(): void {
  moduleCache.clear();
  initCache.clear();
  languageCache.clear();
}
