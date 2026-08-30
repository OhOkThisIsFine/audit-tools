#!/usr/bin/env node
// Regenerate `scripts/shared/runtime-artifact-names.generated.mjs` — the set of
// RUN-artifact basenames (`repo_manifest.json`, `state.json`, `host-workload.json`,
// …) that the doc-citation gate must treat as runtime layout, not repo files.
//
// WHY THIS EXISTS. `scripts/check-doc-code-citations.mjs` resolves BARE filename
// citations (`repo_manifest.json`) against the git-tracked file set. Docs cite
// run-artifact names constantly — the artifact contract, the dependency map, the
// skill bodies — and none of those names ever match a tracked file, so without
// this set every one would be a false red. A hand list here would rot the first
// time an artifact is added or renamed ("never hand-maintain a table something
// else can generate"), so the set is EXTRACTED from the modules that own the
// runtime layout: the audit artifact registry (`ARTIFACT_DEFINITIONS`), the
// shared `.audit-tools` path module, the step-contract writer, the host-handoff
// run-dir builders, and the remediate intake/state/step/validation modules.
//
// Extraction is textual (same precedent as generate-constitutional-doc-paths:
// the consumer runs under plain node pre-build and cannot import TS), with three
// narrow rules per source file:
//   • artifactConstructors — `jsonArtifact("x.json")` / `ndjsonArtifact` /
//     `textArtifact` literals in the artifact registry;
//   • joinLiterals — a quoted extension-bearing basename closing a call,
//     `join(dir, "x.json")` being the canonical shape;
//   • filenameConstants — `SOMETHING_FILENAME = "x.json"` constants.
// Leading-dot matches are dropped (`endsWith(".result.json")` is a suffix test,
// not a filename). Drift between this file and the sources is pinned by
// `tests/shared/runtime-artifact-names-drift.test.ts`, which re-runs the
// extraction and diffs it against the generated module.
//
//   node scripts/shared/generate-runtime-artifact-names.mjs           # write
//   node scripts/shared/generate-runtime-artifact-names.mjs --check   # verify only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGeneratedArtifactCli } from "./generatedArtifacts.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * The runtime-layout source modules and which extraction rules apply to each.
 * Every file here OWNS part of the on-disk run layout; adding a module that also
 * quotes tracked repo filenames would poison the set (a tracked name in this set
 * silently exempts its citations from the gate), so keep the list to layout
 * owners only.
 */
export const RUNTIME_NAME_SOURCES = [
  { file: "src/audit/io/artifacts.ts", rules: ["artifactConstructors"] },
  { file: "src/audit/orchestrator/intakeExecutors.ts", rules: ["artifactsDirJoinLiterals"] },
  { file: "src/shared/io/auditToolsPaths.ts", rules: ["joinLiterals", "filenameConstants"] },
  { file: "src/shared/agentReflections.ts", rules: ["filenameConstants"] },
  { file: "src/shared/io/stepContractWriter.ts", rules: ["joinLiterals"] },
  { file: "src/audit/io/runArtifacts.ts", rules: ["joinLiterals"] },
  { file: "src/audit/cli/dispatch/hostHandoff.ts", rules: ["joinLiterals"] },
  { file: "src/remediate/steps/dispatch/hostHandoff.ts", rules: ["joinLiterals"] },
  { file: "src/remediate/intake.ts", rules: ["joinLiterals"] },
  { file: "src/remediate/state/store.ts", rules: ["filenameConstants"] },
  { file: "src/remediate/steps/nextStep.ts", rules: ["joinLiterals"] },
  { file: "src/remediate/steps/finalGate.ts", rules: ["filenameConstants"] },
  { file: "src/remediate/validation/artifacts.ts", rules: ["joinLiterals"] },
];

const EXTRACTION_RULES = {
  artifactConstructors:
    /\b(?:jsonArtifact|ndjsonArtifact|textArtifact)\(\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"/g,
  joinLiterals: /"([^"\\/\s]+\.[A-Za-z0-9]+)"\s*\)/g,
  // The narrow variant for files that ALSO join non-runtime names (e.g. the
  // intake executor reads the audited repo's package.json): only a literal
  // joined onto the artifacts dir is a runtime artifact name.
  artifactsDirJoinLiterals: /\bjoin\(artifactsDir,\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"\)/g,
  filenameConstants: /[A-Z][A-Z0-9_]*FILENAME\s*=\s*"([^"\\/\s]+\.[A-Za-z0-9]+)"/g,
};

/** Run the extraction over the live source tree → sorted, deduped basenames. */
export function extractRuntimeArtifactNames() {
  const names = new Set();
  for (const { file, rules } of RUNTIME_NAME_SOURCES) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    for (const rule of rules) {
      for (const match of source.matchAll(EXTRACTION_RULES[rule])) {
        // A leading dot marks a suffix test (`endsWith(".result.json")`), never
        // a runtime artifact basename.
        if (!match[1].startsWith(".")) names.add(match[1]);
      }
    }
  }
  if (names.size === 0) {
    throw new Error(
      "runtime-artifact-name extraction found nothing — refusing to generate an empty set " +
        "(that would turn every run-artifact citation into a false red)",
    );
  }
  return [...names].sort();
}

export function renderRuntimeArtifactNamesModule(names) {
  return (
    `// @generated by scripts/shared/generate-runtime-artifact-names.mjs — DO NOT EDIT.\n` +
    `// RUN-artifact basenames extracted from the runtime-layout source modules; the\n` +
    `// doc-citation gate (scripts/check-doc-code-citations.mjs) skips bare filename\n` +
    `// citations of these names — they describe what a run writes, never repo files.\n` +
    `// The gate runs under plain node pre-build, so it imports THIS generated\n` +
    `// sibling instead of the TypeScript sources. Regenerate after changing a\n` +
    `// runtime layout module: node scripts/shared/generate-runtime-artifact-names.mjs\n` +
    `// (drift is pinned by tests/shared/runtime-artifact-names-drift.test.ts).\n` +
    `export const RUNTIME_ARTIFACT_NAMES = [\n` +
    names.map((name) => `  ${JSON.stringify(name)},\n`).join("") +
    `];\n`
  );
}

function main() {
  runGeneratedArtifactCli({
    repoRoot,
    files: [
      {
        target: "scripts/shared/runtime-artifact-names.generated.mjs",
        next: renderRuntimeArtifactNamesModule(extractRuntimeArtifactNames()),
      },
    ],
    staleMessage:
      `The doc-citation gate would classify run-artifact names against a DIFFERENT set than ` +
      `the runtime layout actually uses — a renamed artifact turns into false reds (or a ` +
      `retired name stays silently exempt).`,
    fixCommand: "node scripts/shared/generate-runtime-artifact-names.mjs",
    okMessage: "runtime-artifact-names: generated set matches the layout sources",
  });
}

// Importable as a library (the drift test re-runs the extraction), so the CLI
// body runs ONLY on direct invocation — importing must never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
