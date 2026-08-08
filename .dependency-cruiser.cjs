// Dependency-graph gate for the audit-tools DEV tree (`npm run check:depgraph`,
// wired into verify:checks). This guards OUR OWN source layout — it is not part
// of the audit-tools product's acquired-analyzer surface.
//
// Two rules, both structural invariants of the layout (CLAUDE.md):
//   • no-circular — the graph is currently cycle-free; keep it that way.
//   • shared-imports-no-orchestrator — `src/shared` is the base layer both
//     orchestrators draw from (and the package's `audit-tools/shared` export);
//     an upward import from shared into audit/remediate drags orchestrator code
//     into every shared consumer. (One live violation was found and fixed at
//     adoption: contentKey.ts importing audit's artifactFreshness — the module
//     moved down into shared.)
//
// Deliberately NOT a rule here: orphan/unreachable-module detection. The
// tested-but-unwired class is a periodic MANUAL audit by standing decision
// (knip --production + grep, see CLAUDE.md "Dead-code release gate") — a
// reachability rule cannot trace the dispatch-table / string-keyed wiring this
// codebase uses and would false-positive the same way `knip --production` does.
module.exports = {
  options: {
    tsConfig: {
      fileName: "tsconfig.json",
    },
    tsPreCompilationDeps: true,
    doNotFollow: {
      path: "node_modules",
    },
    includeOnly: "^src",
    exclude: "^node_modules",
  },
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular imports make module initialization order load-bearing and " +
        "resist extraction. The src graph has zero cycles of ANY kind — runtime " +
        "or type-only; any new one is a regression. The three type-only cycles " +
        "that existed at adoption (quota/limits<->scheduler, remediate " +
        "state/itemStatus<->types, contractPipeline " +
        "artifactStore<->semanticProjection) were each broken by moving the " +
        "shared declaration DOWN into a module below both sides, so the " +
        "viaOnly type-only exemption is gone: a type-only cycle is a real " +
        "design defect (it says two modules each own part of the other's " +
        "contract), it just happens to be erased at emit.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "shared-imports-no-orchestrator",
      severity: "error",
      comment:
        "src/shared is the base layer (the audit-tools/shared export). It must " +
        "never import from src/audit or src/remediate — move the code down " +
        "into shared instead (one core, two draws).",
      from: { path: "^src/shared" },
      to: { path: "^src/(audit|remediate)" },
    },
  ],
};
