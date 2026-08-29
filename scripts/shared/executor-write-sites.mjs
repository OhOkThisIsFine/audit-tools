// Where each audit executor actually writes — the EXTRACTION side of the
// executor→artifact producer relation.
//
// WHY THIS EXISTS. `EXECUTOR_REGISTRY.produces`
// (`src/audit/orchestrator/executors.ts`) DECLARES what each executor writes,
// and `spec/audit/executor-producers.generated.md` renders that declaration. A
// declaration nothing checks is prose in a `.ts` file, so this module recovers
// the same relation from the CODE and
// `tests/audit/executor-artifact-production-declaration.test.ts` pins the two
// against each other in both directions.
//
// ONE HOME FOR THE EXTRACTION. The write-set extraction used to live inside
// `tests/audit/seam-dependency-map-executor-writeset-parity.test.ts` as a
// per-FILE regex over a hand list of 14 modules. That list was neither sound nor
// complete (it omitted `executorRunners.ts`'s inline friction runner,
// `charterDeltaExecutor.ts` and `intentEquivalenceExecutor.ts`, and carried a
// dead `intentCheckpointExecutor.ts` entry), and per-file granularity cannot
// attribute a write to one of the four executors sharing `structureExecutors.ts`.
// The extraction is therefore here, per EXECUTOR, and the seam test consumes it.
//
// Extraction is STRUCTURAL (the `typescript` compiler API, already a
// devDependency and already the idiom of generate-filelock-export-surface.mjs),
// not a regex over declarations: a scanner that silently drops what it does not
// understand is the shape this repo bans. An unresolvable site REFUSES loudly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Modules defining the `<NAME>_FILENAME = "x.y"` constants that appear as
 * IDENTIFIERS inside an `artifacts_written` array (synthesis writes
 * `AUDIT_REPORT_FILENAME`, not the literal). Resolved textually with the same
 * `filenameConstants` rule generate-runtime-artifact-names.mjs uses.
 */
const FILENAME_CONSTANT_SOURCES = [
  "src/shared/io/auditToolsPaths.ts",
  "src/shared/agentReflections.ts",
];

const FILENAME_CONSTANT_RULE = /([A-Z][A-Z0-9_]*FILENAME)\s*=\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"/g;

/**
 * Extraction rules, keyed by the `rule` field of a write site.
 *
 *   'runnerWriteSet'      — every `artifacts_written` literal reachable inside
 *                           the named `scope` (a top-level function declaration,
 *                           or a property of a top-level object literal — which
 *                           is how `EXECUTOR_RUNNERS`' inline friction runner is
 *                           addressed). Follows the local-variable form
 *                           (`const artifactsWritten = [...]` + `.push("x")`)
 *                           the intake and acquisition runners use.
 *   'artifactsDirWrites'  — `writeJsonFile(join(<x.>artifactsDir, "name"))`: the
 *                           CLI-site writes of host_delegation executors, which
 *                           never return an `artifacts_written` array.
 *   'artifactPathBinding' — `= join(<x.>artifactsDir, "name")`: the artifact path
 *                           the CLI BINDS and hands to the host, which then
 *                           performs the write itself.
 *   'bundleFieldCarry'    — the CLI site lands the artifact by REBUILDING the
 *                           named bundle `field` on the fold's carried bundle;
 *                           the write itself is the fold's single core commit
 *                           (CX-02: `commitFold` → `writeCoreArtifacts`). The
 *                           extractor CHECKS the field is written in the named
 *                           scope and maps it to `<field>.json`.
 *   'no-writes'           — the executor writes nothing; `reason` says why. A
 *                           `file`+`scope` makes the claim CHECKED: an
 *                           `artifacts_written` literal appearing there refuses,
 *                           instead of leaving the executor's pin vacuous.
 *
 * Both regex rules honour an optional `scope`, matching inside that top-level
 * binding rather than over the whole file — the whole-file form attributes any
 * later matching call in the module to this executor.
 */
const ARTIFACTS_DIR_WRITE_RULE =
  /writeJsonFile\(\s*join\(\s*(?:[A-Za-z_$][\w$]*\.)*artifactsDir,\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"\s*\)/g;
const ARTIFACT_PATH_BINDING_RULE =
  /=\s*join\(\s*(?:[A-Za-z_$][\w$]*\.)*artifactsDir,\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"\s*\)/g;

/**
 * Executor id → the source site that performs (or binds) its writes. Declared
 * explicitly rather than derived from `EXECUTOR_RUNNERS`: that map omits every
 * host_delegation executor by design, so deriving the list from it would make
 * exactly the executors whose writes happen at CLI sites invisible.
 *
 * Ordered by executor id (content-derived stable key).
 *
 * @type {ReadonlyArray<{executor: string, file?: string, scope?: string, rule: string, reason?: string, field?: string}>}
 */
export const EXECUTOR_WRITE_SITES = [
  {
    executor: "auto_fix_executor",
    file: "src/audit/orchestrator/autoFixExecutor.ts",
    scope: "runAutoFixExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "charter_clarification_executor",
    file: "src/audit/orchestrator/charterClarificationExecutor.ts",
    scope: "runCharterClarificationExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "charter_delta_executor",
    file: "src/audit/orchestrator/charterDeltaExecutor.ts",
    scope: "runCharterDeltaExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "charter_extraction_executor",
    file: "src/audit/orchestrator/charterExtractionExecutor.ts",
    scope: "runCharterExtractionExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "critical_flow_fallback_executor",
    file: "src/audit/orchestrator/criticalFlowFallbackExecutor.ts",
    scope: "runCriticalFlowFallbackExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "design_assessment_executor",
    file: "src/audit/orchestrator/structureExecutors.ts",
    scope: "runDesignAssessmentExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "design_review_conceptual",
    file: "src/audit/cli/nextStepHelpers.ts",
    scope: "handleDesignReviewBranch",
    rule: "bundleFieldCarry",
    field: "design_assessment",
  },
  {
    executor: "design_review_contract",
    file: "src/audit/cli/nextStepHelpers.ts",
    scope: "handleDesignReviewBranch",
    rule: "bundleFieldCarry",
    field: "design_assessment",
  },
  {
    executor: "docs_digest_executor",
    file: "src/audit/orchestrator/structureExecutors.ts",
    scope: "runDocsDigestExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "external_analyzer_acquisition_executor",
    file: "src/audit/orchestrator/acquisitionExecutor.ts",
    scope: "runExternalAnalyzerAcquisitionExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "external_analyzer_import_executor",
    file: "src/audit/orchestrator/ingestionExecutors.ts",
    scope: "runExternalAnalyzerImportExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "friction_capture_executor",
    file: "src/audit/orchestrator/executorRunners.ts",
    scope: "friction_capture_executor",
    rule: "runnerWriteSet",
  },
  {
    executor: "graph_enrichment_executor",
    file: "src/audit/orchestrator/graphEnrichmentExecutor.ts",
    scope: "runGraphEnrichmentExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "intake_executor",
    file: "src/audit/orchestrator/intakeExecutors.ts",
    scope: "runIntakeExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "intent_checkpoint_executor",
    file: "src/audit/cli/nextStepCommand.ts",
    scope: "emitConfirmIntent",
    rule: "artifactPathBinding",
  },
  {
    executor: "intent_equivalence_executor",
    file: "src/audit/orchestrator/intentEquivalenceExecutor.ts",
    scope: "runIntentEquivalenceResolve",
    rule: "no-writes",
    reason:
      "every return path of runIntentEquivalenceResolve sets artifacts_written: []; the resolution is committed into artifact_metadata.intent_baseline, which advanceAudit persists (a LIFECYCLE_PRODUCTIONS artifact)",
  },
  {
    executor: "planning_executor",
    file: "src/audit/orchestrator/planningExecutors.ts",
    scope: "runPlanningExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "result_ingestion_executor",
    file: "src/audit/orchestrator/ingestionExecutors.ts",
    scope: "runResultIngestionExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "runtime_validation_executor",
    file: "src/audit/orchestrator/ingestionExecutors.ts",
    scope: "runRuntimeValidationExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "runtime_validation_update_executor",
    file: "src/audit/orchestrator/ingestionExecutors.ts",
    scope: "runRuntimeValidationUpdateExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "semantic_review_executor",
    rule: "no-writes",
    reason:
      "the host returns audit results through the submission ledger; result_ingestion_executor is what persists them",
  },
  {
    executor: "structure_decomposition_executor",
    file: "src/audit/orchestrator/structureExecutors.ts",
    scope: "runStructureDecompositionExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "structure_executor",
    file: "src/audit/orchestrator/structureExecutors.ts",
    scope: "runStructureExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "syntax_resolution_executor",
    file: "src/audit/orchestrator/syntaxResolutionExecutor.ts",
    scope: "runSyntaxResolutionExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "synthesis_executor",
    file: "src/audit/orchestrator/synthesisExecutors.ts",
    scope: "runSynthesisExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "synthesis_narrative_executor",
    file: "src/audit/orchestrator/synthesisExecutors.ts",
    scope: "runSynthesisNarrativeExecutor",
    rule: "runnerWriteSet",
  },
  {
    executor: "systemic_challenge_executor",
    file: "src/audit/orchestrator/systemicChallengeExecutor.ts",
    scope: "runSystemicChallengeExecutor",
    rule: "runnerWriteSet",
  },
];

/**
 * Artifacts an executor is declared to produce that NO literal in its source can
 * name, because the runtime write-set is COMPUTED. Declared here as data so the
 * declaration↔reality pin stays an equality (a declared artifact with neither a
 * literal nor an entry here is a stale declaration; a shrinking write-set still
 * goes red) instead of degrading to a one-sided superset check.
 *
 * Ordered by executor id, then artifact (content-derived stable key).
 *
 * @type {ReadonlyArray<{executor: string, artifact: string, reason: string}>}
 */
export const DYNAMIC_WRITE_CONTRIBUTORS = [
  {
    executor: "runtime_validation_executor",
    artifact: "audit_plan_metrics.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
  {
    executor: "runtime_validation_executor",
    artifact: "audit_tasks.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
  {
    executor: "runtime_validation_executor",
    artifact: "task_affinity_graph.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
  {
    executor: "runtime_validation_update_executor",
    artifact: "audit_plan_metrics.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
  {
    executor: "runtime_validation_update_executor",
    artifact: "audit_tasks.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
  {
    executor: "runtime_validation_update_executor",
    artifact: "task_affinity_graph.json",
    reason: "spread of applySelectiveDeepening().artifacts (ingestionExecutors.ts)",
  },
];

/** `<NAME>_FILENAME` → its literal value, from the constant-source modules. */
function readFilenameConstants(root) {
  const constants = new Map();
  for (const file of FILENAME_CONSTANT_SOURCES) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(FILENAME_CONSTANT_RULE)) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** Every string literal under `node`, plus identifiers resolvable to a filename. */
function collectLiterals(node, out, constants) {
  const visit = (n) => {
    if (ts.isStringLiteral(n)) out.add(n.text);
    else if (ts.isIdentifier(n) && constants.has(n.text)) out.add(constants.get(n.text));
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * Sentinel recorded for a top-level name more than one node defines. Held in the
 * index rather than thrown at index time so an ambiguity in a name NO write site
 * requests costs nothing — the refusal fires at resolution, where it is real.
 */
const AMBIGUOUS_SCOPE = Symbol("ambiguous write-site scope");

/**
 * Index a source TEXT's addressable scopes. Separate from the file-reading path so
 * the ambiguity/missing refusals can be exercised against a scratch source.
 */
export function buildScopeIndexFromText(fileName, sourceText) {
  return buildScopeIndex(
    ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true),
  );
}

/**
 * One site's scope node, or a REFUSAL: an unknown name, and an ambiguous one the
 * site actually requests, are both unresolvable.
 */
export function resolveScopeNode(scopes, site) {
  const scopeNode = scopes.get(site.scope);
  if (scopeNode === AMBIGUOUS_SCOPE) {
    throw new Error(
      `write site for ${site.executor} names scope "${site.scope}" in ${site.file}, which more than one top-level function, variable, or object property defines — a scope name must address exactly one node`,
    );
  }
  if (!scopeNode) {
    throw new Error(
      `write site for ${site.executor} names scope "${site.scope}" in ${site.file}, which no top-level function, variable, or object property defines`,
    );
  }
  return scopeNode;
}

/**
 * Index a source file's addressable scopes: top-level function declarations by
 * name, top-level variable declarations by name (which is how a runner defined
 * as `const emitX = wrapper(...)` is addressed), and properties of top-level
 * object literals by property name.
 */
function buildScopeIndex(sourceFile) {
  const scopes = new Map();
  const add = (name, node) => {
    scopes.set(name, scopes.has(name) ? AMBIGUOUS_SCOPE : node);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) add(declaration.name.text, declaration);
      const initializer = declaration.initializer;
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
      for (const property of initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        add(property.name.getText(sourceFile).replace(/^["']|["']$/g, ""), property);
      }
    }
  }
  return scopes;
}

/** Artifact names reachable through `artifacts_written` inside one scope node. */
function collectRunnerWriteSet(scopeNode, constants) {
  const names = new Set();
  const varRefs = new Set();

  const visitDirect = (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "artifacts_written") {
      if (ts.isIdentifier(n.initializer)) varRefs.add(n.initializer.text);
      else collectLiterals(n.initializer, names, constants);
    }
    ts.forEachChild(n, visitDirect);
  };
  visitDirect(scopeNode);

  if (varRefs.size === 0) return names;

  // The local-variable form: the initializer plus every `<var>.push("x")`.
  const visitVar = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      varRefs.has(n.name.text) &&
      n.initializer
    ) {
      collectLiterals(n.initializer, names, constants);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "push" &&
      ts.isIdentifier(n.expression.expression) &&
      varRefs.has(n.expression.expression.text)
    ) {
      for (const argument of n.arguments) collectLiterals(argument, names, constants);
    }
    ts.forEachChild(n, visitVar);
  };
  visitVar(scopeNode);
  return names;
}

/**
 * Run every declared write site → `Map<executorId, Set<artifactName>>`.
 *
 * A site that resolves to nothing is a REFUSAL, not an empty set: a renamed
 * runner function would otherwise silently turn its executor's pin vacuous.
 * `no-writes` sites are the one declared, reasoned exception — and a `no-writes`
 * site that names a scope refuses in the opposite direction, when the executor
 * starts writing.
 *
 * @param {string} [root] repo root to read the executor sources from.
 * @returns {Map<string, Set<string>>} executor id → the artifact names it writes.
 */
export function extractExecutorWriteSets(root = repoRoot) {
  const constants = readFilenameConstants(root);
  const sourceCache = new Map();
  const scopeCache = new Map();
  const readSource = (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(join(root, file), "utf8"));
    return sourceCache.get(file);
  };

  const scopeNodeFor = (site) => {
    if (!scopeCache.has(site.file)) {
      scopeCache.set(
        site.file,
        buildScopeIndex(
          ts.createSourceFile(site.file, readSource(site.file), ts.ScriptTarget.Latest, true),
        ),
      );
    }
    return resolveScopeNode(scopeCache.get(site.file), site);
  };

  const byExecutor = new Map();
  for (const site of EXECUTOR_WRITE_SITES) {
    if (site.rule === "no-writes") {
      // A `no-writes` claim with an addressable scope is CHECKED, not trusted:
      // an executor that starts writing would otherwise pass DECL-3 vacuously.
      if (site.file && site.scope) {
        const written = collectRunnerWriteSet(scopeNodeFor(site), constants);
        if (written.size > 0) {
          throw new Error(
            `write site for ${site.executor} is declared "no-writes" (${site.reason}) but ${site.file}#${site.scope} now names artifact literal(s) ${[...written].sort().join(", ")} — replace the no-writes declaration with a real write site and declare the artifact in EXECUTOR_REGISTRY[].produces`,
          );
        }
      }
      byExecutor.set(site.executor, new Set());
      continue;
    }
    const source = readSource(site.file);
    let names;
    if (site.rule === "bundleFieldCarry") {
      // The artifact lands through the fold's single core commit; what THIS
      // site owns is the carried-bundle FIELD rebuild. Checked, not trusted:
      // the field must actually be written inside the named scope.
      const haystack = site.scope ? scopeNodeFor(site).getText() : source;
      const fieldWrite = new RegExp(`\\b${site.field}\\b\\s*[:=]`);
      if (!fieldWrite.test(haystack)) {
        throw new Error(
          `write site for ${site.executor} (bundleFieldCarry over ${site.file}${site.scope ? `#${site.scope}` : ""}) found no write of bundle field "${site.field}" — the carry moved, or the executor stopped producing it`,
        );
      }
      byExecutor.set(site.executor, new Set([`${site.field}.json`]));
      continue;
    }
    if (site.rule === "runnerWriteSet") {
      names = collectRunnerWriteSet(scopeNodeFor(site), constants);
      if (names.size === 0) {
        throw new Error(
          `write site for ${site.executor} (runnerWriteSet over ${site.file}#${site.scope}) resolved to no artifact literal — the write moved out of the named scope, or the executor writes nothing and owes a "no-writes" declaration`,
        );
      }
    } else {
      const rule = {
        artifactsDirWrites: ARTIFACTS_DIR_WRITE_RULE,
        artifactPathBinding: ARTIFACT_PATH_BINDING_RULE,
      }[site.rule];
      if (!rule) {
        throw new Error(`unknown write-site rule "${site.rule}" for ${site.executor}`);
      }
      const haystack = site.scope ? scopeNodeFor(site).getText() : source;
      names = new Set([...haystack.matchAll(rule)].map((match) => match[1]));
      if (names.size === 0) {
        throw new Error(
          `write site for ${site.executor} (${site.rule} over ${site.file}${site.scope ? `#${site.scope}` : ""}) matched nothing — the rule or the call shape moved`,
        );
      }
    }
    byExecutor.set(site.executor, names);
  }
  return byExecutor;
}
