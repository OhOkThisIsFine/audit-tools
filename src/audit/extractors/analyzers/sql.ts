import { normalizeGraphPath } from "../graphPathUtils.js";
import type {
  AnalyzerContext,
  AnalyzerOutput,
  LanguageAnalyzer,
} from "./types.js";

/**
 * SQL is intentionally a registry stub (per the refactor plan): the seam
 * recognises `.sql` files but emits no edges yet. Registering it keeps the
 * capability surface honest — `analyzer_capability.json` records SQL as
 * applicable-but-empty rather than silently invisible — and leaves a single
 * place to add cross-file resolution (views/foreign keys) later.
 */
function supports(file: string): boolean {
  return normalizeGraphPath(file).toLowerCase().endsWith(".sql");
}

// Signature matches the `LanguageAnalyzer.analyze` interface (the params the
// other analyzers receive) so the registry type stays uniform; the stub
// ignores them and emits no edges yet.
function analyze(_files: string[], _context: AnalyzerContext): AnalyzerOutput {
  return { edges: [] };
}

export const sqlAnalyzer: LanguageAnalyzer = {
  id: "sql",
  supports,
  analyze,
};
