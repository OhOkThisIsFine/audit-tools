import {
  resolveAnalyzerDep,
  type AnalyzerSetting,
} from "audit-tools/shared";
import type { AnalyzerPlanEntry, LanguageAnalyzer } from "./types.js";
import { typescriptAnalyzer } from "./typescript.js";
import { pythonAnalyzer } from "./python.js";
import { htmlAnalyzer } from "./html.js";
import { cssAnalyzer } from "./css.js";
import { sqlAnalyzer } from "./sql.js";

/**
 * Registered language analyzers, in within-phase order (seam → TS/JS →
 * Python → HTML → CSS). SQL is a registry stub (recognises `.sql`, emits no
 * edges yet). The tree-sitter analyzers (Python/HTML/CSS) load their grammar
 * from the `web-tree-sitter` dependency and degrade to the regex floor when
 * it cannot be resolved — a degradation that is surfaced on stderr, never
 * silent (see `surfaceAbsent`).
 */
export const ANALYZER_REGISTRY: LanguageAnalyzer[] = [
  typescriptAnalyzer,
  pythonAnalyzer,
  htmlAnalyzer,
  cssAnalyzer,
  sqlAnalyzer,
];

// External analyzer acquisition engine (on-demand ecosystem-native tools run
// ephemerally + normalized through the adapter seam). Re-exported here so the
// analyzer registry is the single entry point for both the in-tree
// `LanguageAnalyzer` set and the acquired external set.
export {
  OWNED_TOOL_IDS,
  admitSpawn,
  admitLocalSpawn,
  localToolIdFor,
  runSafetyGate,
  runExternalAnalyzer,
  registerExternalAnalyzers,
  runAcquisitionEngine,
  resolveBinaryCandidates,
  detectNodeEcosystem,
  detectPythonEcosystem,
} from "audit-tools/shared";
export type {
  EcosystemRunner,
  ExternalAnalyzerCandidate,
  AcquisitionRunner,
  AcquisitionEngineOptions,
  AcquisitionOutcome,
  RunAllOutcome,
  ResolvedBinaries,
} from "audit-tools/shared";
export { resolveBinary, expectedSha256For } from "audit-tools/shared";
export {
  EXTERNAL_ANALYZER_CANDIDATES,
  gitleaksCandidate,
  GITLEAKS_VERSION,
} from "audit-tools/shared";
export type {
  BinarySpec,
  BinaryFetcher,
  BinaryResolveOptions,
  BinaryResolution,
} from "audit-tools/shared";

function settingFor(
  analyzers: Record<string, AnalyzerSetting> | undefined,
  id: string,
): AnalyzerSetting {
  return analyzers?.[id] ?? "auto";
}

function makeEntry(
  analyzer: LanguageAnalyzer,
  setting: AnalyzerSetting,
  supportedCount: number,
  resolution: AnalyzerPlanEntry["resolution"],
  path?: string,
): AnalyzerPlanEntry {
  const entry: AnalyzerPlanEntry = {
    id: analyzer.id,
    dependency: analyzer.dependency,
    setting,
    resolution,
    supportedCount,
  };
  if (path !== undefined) entry.path = path;
  return entry;
}

/**
 * Deterministically resolve, without installing anything, how each registered
 * analyzer would run for this repo. The conversation-first CLI uses this to
 * decide whether to propose an install before the enrichment executor runs.
 *
 * Resolution rules:
 *  - 0 supported in-scope files            → `not_applicable`
 *  - setting `skip`                         → `skip`
 *  - dependency resolves (repo|cache)       → `repo` | `cache`
 *  - dependency absent                      → `absent` (executor installs only
 *    for `ephemeral`/`permanent`; `auto` may prompt; `repo` falls to the
 *    floor). A Tier-S parser analyzer resolved absent is surfaced loudly on
 *    stderr — see `surfaceAbsent`.
 */
export function resolveAnalyzerPlan(
  root: string,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  includedFiles: string[],
  options: { cacheRoot?: string } = {},
): AnalyzerPlanEntry[] {
  const depOptions = options.cacheRoot ? { cacheRoot: options.cacheRoot } : {};
  return ANALYZER_REGISTRY.map((analyzer) => {
    const setting = settingFor(analyzers, analyzer.id);
    const supportedCount = includedFiles.filter((file) =>
      analyzer.supports(file),
    ).length;

    if (supportedCount === 0) {
      return makeEntry(analyzer, setting, supportedCount, "not_applicable");
    }
    if (setting === "skip") {
      return makeEntry(analyzer, setting, supportedCount, "skip");
    }
    if (!analyzer.dependency) {
      // No dependency required: always available.
      return makeEntry(analyzer, setting, supportedCount, "repo");
    }

    const resolved = resolveAnalyzerDep(analyzer.dependency, root, depOptions);
    if (resolved.via === "repo" || resolved.via === "cache") {
      return makeEntry(analyzer, setting, supportedCount, resolved.via, resolved.path);
    }
    return surfaceAbsent(makeEntry(analyzer, setting, supportedCount, "absent"));
  });
}

/** Analyzer ids that need a real parser runtime — the Tier-S set. */
const TIER_S_ANALYZER_IDS = new Set(["python", "html", "css"]);

/**
 * A Tier-S parser analyzer whose dependency is absent must never degrade to the
 * regex floor silently: the capability cliff is surfaced on stderr every time
 * the plan resolves it as absent. `skip` is an explicit operator decision, so
 * it is not surfaced here.
 */
function surfaceAbsent(entry: AnalyzerPlanEntry): AnalyzerPlanEntry {
  if (
    !TIER_S_ANALYZER_IDS.has(entry.id) ||
    entry.setting === "skip"
  ) {
    return entry;
  }
  process.stderr.write(
    `[audit-code] analyzer '${entry.id}' (${entry.dependency ?? "unknown dependency"}) is ABSENT — ` +
      `parser-grade extraction is OFF for this audit; the weaker regex floor will run instead. ` +
      `Install '${entry.dependency}' (and 'tree-sitter-wasms') to restore it.\n`,
  );
  return entry;
}

/**
 * A plan entry whose dependency is absent and whose setting is `auto` (or unset)
 * with in-scope files — the only case that warrants proposing an install in the
 * conversation-first flow. (ephemeral/permanent install silently; repo/skip fall
 * to the floor — loudly for Tier-S, via `surfaceAbsent`.)
 */
export function needsInstallDecision(entry: AnalyzerPlanEntry): boolean {
  return entry.resolution === "absent" && entry.setting === "auto";
}
