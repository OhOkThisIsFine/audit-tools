#!/usr/bin/env node
// sites-pinned: tests/shared/spec-artifact-prefixes-gate.test.ts
// Category-prefix gate for the artifact rows of spec/audit/artifact-contract.md.
//
// A row whose Purpose cell opens with a category prefix (`Durable host input:`,
// `Marker:`, `**Transient host submission**`) is read as a CONTRACT: two files that
// share a prefix share a lifecycle. A false prefix once made the nightly docs leg
// register a transient submission in the staleness DAG ("it is labelled like the
// durable leaf, so register it for consistency"). Each recognized prefix therefore
// carries a PREDICATE over the two code-side facts that decide a file's lifecycle:
//
//   registered  — a filename in ARTIFACT_DEFINITIONS (src/audit/io/artifacts.ts)
//   DAG role    — a key of ARTIFACT_DEPENDS_ON_MAP (src/audit/orchestrator/dependencyMap.ts),
//                 or only an upstream of another key (a leaf), or neither
//
// Both are read by the same structural extraction the spec-mirror generator uses
// (never a second parser). An unknown prefix fails, so a new category must be
// declared here WITH its predicate before a row may wear it; a row whose file fails
// its prefix's predicate fails, naming row, prefix and predicate.
//
// Not covered, declared: a prefix-less row makes no claim and is not examined; the
// prefix is recognized only at the very start of the Purpose cell; and the predicate
// proves registry/DAG membership, not the finer lifecycle prose (e.g. that a
// transient file is in fact deleted after ingestion).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACT_REGISTRY_FILE,
  DEPENDENCY_MAP_FILE,
  ARTIFACT_CONTRACT_DOC,
} from "./shared/spec-mirror-data.mjs";
import {
  parseArtifactDefinitions,
  parseDependencyMap,
  readStringConstants,
} from "./shared/generate-spec-mirrors.mjs";
import { parseArgv, USAGE_EXIT } from "./shared/argvGuard.mjs";
import { compareCodeUnits } from "./shared/primitives.mjs";

/**
 * Recognized prefixes: normalized prefix text -> { predicate (stated in a failure),
 * test(facts) }. `facts` = { registered, dagKey, dagUpstreamOnly }.
 */
const PREFIXES = new Map([
  [
    "durable host input",
    {
      predicate: "registered in ARTIFACT_DEFINITIONS AND a leaf of the staleness DAG (an upstream, never a key)",
      test: (f) => f.registered && f.dagUpstreamOnly,
    },
  ],
  [
    "marker",
    {
      predicate: "registered in ARTIFACT_DEFINITIONS AND a key of the staleness DAG (it has upstreams)",
      test: (f) => f.registered && f.dagKey,
    },
  ],
  [
    "transient host submission",
    {
      predicate: "NOT registered in ARTIFACT_DEFINITIONS AND NOT a staleness-DAG participant",
      test: (f) => !f.registered && !f.dagKey && !f.dagUpstreamOnly,
    },
  ],
]);

const ROW_RE = /^\|\s*(?:<!--.*?-->\s*)?`([^`]+)`\s*\|(.*)\|\s*$/;
const BOLD_PREFIX_RE = /^\*\*([^*]+)\*\*/;
const COLON_PREFIX_RE = /^([A-Z][A-Za-z ]{0,40}):\s/;

/** Prefix of a Purpose cell, normalized, or null when the cell claims none. */
function purposePrefix(purpose) {
  const text = purpose.trim();
  const bold = BOLD_PREFIX_RE.exec(text);
  const raw = bold ? bold[1] : (COLON_PREFIX_RE.exec(text)?.[1] ?? null);
  return raw === null ? null : raw.trim().replace(/[.:]+$/, "").toLowerCase();
}

/** `{ file, prefix, line }` for every table row whose Purpose claims a prefix. */
function readPrefixedRows(specText) {
  const rows = [];
  specText.split(/\r?\n/).forEach((text, index) => {
    const match = ROW_RE.exec(text);
    if (!match) return;
    // cells[0] = Format, cells[1] = Purpose; the filename cell is the capture.
    const cells = match[2].split("|");
    if (cells.length < 2) return;
    const prefix = purposePrefix(cells[1]);
    if (prefix !== null) rows.push({ file: match[1], prefix, line: index + 1 });
  });
  return rows;
}

/** The lifecycle facts for one filename, from the parsed registry and DAG. */
function lifecycleFacts(file, artifacts, dependencies) {
  const registered = artifacts.some((a) => a.fileName === file);
  const dagKey = dependencies.some((d) => d.artifact === file);
  const upstream = dependencies.some((d) => d.dependsOn.includes(file));
  return { registered, dagKey, dagUpstreamOnly: !dagKey && upstream };
}

/** Violations as strings, in code-unit order. */
function findViolations(rows, artifacts, dependencies) {
  const out = [];
  for (const row of rows) {
    const where = `${ARTIFACT_CONTRACT_DOC}:${row.line}  \`${row.file}\``;
    const rule = PREFIXES.get(row.prefix);
    if (!rule) {
      out.push(
        `${where} — unknown category prefix "${row.prefix}" (known: ${[...PREFIXES.keys()].sort(compareCodeUnits).join(", ")}). ` +
          `Declare it in scripts/check-spec-artifact-prefixes.mjs with its lifecycle predicate, or reword the row.`,
      );
      continue;
    }
    const facts = lifecycleFacts(row.file, artifacts, dependencies);
    if (!rule.test(facts)) {
      out.push(
        `${where} — prefix "${row.prefix}" requires: ${rule.predicate}; found registered=${facts.registered}, ` +
          `DAG key=${facts.dagKey}, DAG leaf=${facts.dagUpstreamOnly}.`,
      );
    }
  }
  return out.sort(compareCodeUnits);
}

function main() {
  const parsed = parseArgv(process.argv.slice(2), { positionals: 1 });
  if (parsed.help || parsed.unknown.length > 0 || parsed.missingValue.length > 0) {
    console.error("usage: check-spec-artifact-prefixes.mjs [root]");
    process.exit(parsed.help ? 0 : USAGE_EXIT);
  }
  const root = resolve(parsed.positionals[0] ?? process.cwd());
  const specPath = join(root, ARTIFACT_CONTRACT_DOC);
  if (!existsSync(specPath)) {
    console.error(`check-spec-artifact-prefixes: ${ARTIFACT_CONTRACT_DOC} not found under ${root}`);
    process.exit(1);
  }
  let artifacts;
  let dependencies;
  try {
    const constants = readStringConstants(root);
    artifacts = parseArtifactDefinitions(readFileSync(join(root, ARTIFACT_REGISTRY_FILE), "utf8"), constants);
    dependencies = parseDependencyMap(readFileSync(join(root, DEPENDENCY_MAP_FILE), "utf8"), constants);
  } catch (error) {
    console.error(`check-spec-artifact-prefixes: cannot read the registries — ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const rows = readPrefixedRows(readFileSync(specPath, "utf8"));
  const violations = findViolations(rows, artifacts, dependencies);
  if (violations.length > 0) {
    console.error(`check-spec-artifact-prefixes: ${violations.length} row(s) wear a category prefix their file does not have the lifecycle of:`);
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`check-spec-artifact-prefixes: ${rows.length} prefixed row(s) in ${ARTIFACT_CONTRACT_DOC} — each file has its prefix's lifecycle.`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
