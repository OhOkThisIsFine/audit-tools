#!/usr/bin/env node
// Regenerate the result-ingestion check block inside `docs/audit-pkg/contracts.md`.
//
// WHY THIS EXISTS. The checks ingestion performs before accepting a host result
// were enumerated by hand in three docs — the contracts page, the operator
// guide, and the concurrent-runs design — and the three lists disagreed: only
// one named the result path, only one the strict result schema, only one the
// workload version. Nothing reconciled them (nightly item l1-4; owner decision
// 2026-09-05: derive the list from the validator, pick no prose home).
//
// The checks are DECLARED in `src/shared/submission/ingestionChecks.ts`
// (`INGESTION_CHECKS`), the same registry both host-handoff twins cite on every
// refusal they emit. Rendering from it means a check added there cannot go
// undocumented, and the page cannot describe a check the validators do not
// perform. The other two docs keep no copy: they state the property and point
// here.
//
// Extraction is STRUCTURAL (the `typescript` compiler API, the idiom of
// generate-executor-producers.mjs and generate-spec-mirrors.mjs): the registry
// is an `as const satisfies …` array of object literals, which a regex cannot
// read without silently dropping what it fails to match. A property that is not
// a plain literal REFUSES rather than rendering a row without it.
//
// The same module exports the citation extractor the drift test uses to pin the
// registry as load-bearing: every `refuse("<id>", …)` / `invalidResult("<id>", …)`
// / `bindingFailure("<id>", …)` first argument and every `check: "<id>"`
// property in a source file, as a set of ids.
//
//   node scripts/shared/generate-ingestion-checks.mjs           # write
//   node scripts/shared/generate-ingestion-checks.mjs --check   # verify only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { runGeneratedArtifactCli, spliceGeneratedBlock } from "./generatedArtifacts.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const SOURCE_FILE = "src/shared/submission/ingestionChecks.ts";
export const RENDER_FILE = "docs/audit-pkg/contracts.md";
/** The two former hand-written copies; they now state the property and point at the block. */
export const POINTER_FILES = ["docs/audit-pkg/operator-guide.md", "spec/multi-ide-concurrent-runs-design.md"];
export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED INGESTION CHECKS — scripts/shared/generate-ingestion-checks.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED INGESTION CHECKS -->";

/** The calls whose FIRST argument is a check id. */
const CITING_CALLS = new Set(["refuse", "invalidResult", "bindingFailure"]);

/** Strip `as const` / `satisfies T` / parentheses down to the underlying literal. */
function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** @typedef {{id: string, verifies: string, draws: string[], cited_by: string}} IngestionCheckRow */

/**
 * One object literal → a plain object of string / string[] values; anything else refuses.
 * @returns {IngestionCheckRow}
 */
function readCheckRow(node, index) {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error(`INGESTION_CHECKS[${index}] is not an object literal — refusing to guess its shape`);
  }
  /** @type {Record<string, string | string[]>} */
  const row = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      throw new Error(`INGESTION_CHECKS[${index}] uses an unsupported property form — refusing to guess`);
    }
    const key = property.name.text;
    const value = unwrapExpression(property.initializer);
    const strings = ts.isArrayLiteralExpression(value)
      ? value.elements.flatMap((element) => (ts.isStringLiteral(element) ? [element.text] : []))
      : null;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      row[key] = value.text;
    } else if (strings !== null && ts.isArrayLiteralExpression(value) && strings.length === value.elements.length) {
      row[key] = strings;
    } else {
      throw new Error(
        `INGESTION_CHECKS[${index}].${key} is not a plain literal — the render would silently drop ` +
          `it. Keep every registry field a quoted string or an array of quoted strings`,
      );
    }
  }
  for (const required of ["id", "verifies", "draws", "cited_by"]) {
    if (!(required in row)) throw new Error(`INGESTION_CHECKS[${index}] declares no \`${required}\``);
  }
  return /** @type {IngestionCheckRow} */ (/** @type {unknown} */ (row));
}

/**
 * The declared check set, as plain data, from TypeScript source TEXT.
 * @param {string} sourceText contents of the registry module.
 * @returns {IngestionCheckRow[]}
 */
export function parseIngestionChecks(sourceText) {
  const sourceFile = ts.createSourceFile(SOURCE_FILE, sourceText, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "INGESTION_CHECKS") continue;
      const initializer = declaration.initializer && unwrapExpression(declaration.initializer);
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`INGESTION_CHECKS in ${SOURCE_FILE} is not an array literal`);
      }
      const rows = initializer.elements.map((element, index) => readCheckRow(element, index));
      if (rows.length === 0) throw new Error("INGESTION_CHECKS parsed as empty — refusing to render an empty block");
      return rows;
    }
  }
  throw new Error(`could not find \`export const INGESTION_CHECKS\` in ${SOURCE_FILE}`);
}

export function readIngestionChecks(root = repoRoot) {
  return parseIngestionChecks(readFileSync(join(root, SOURCE_FILE), "utf8"));
}

/** Pipe-safe markdown cell. */
const cell = (text) => text.replace(/\|/g, "\\|");

/** The rendered block, markers included. */
export function renderIngestionChecks(checks = readIngestionChecks()) {
  return [
    BEGIN_MARKER,
    "",
    `> Rendered from \`${SOURCE_FILE}\` — the registry both host-handoff twins cite on every`,
    "> refusal they emit. Add a check there and this table follows; the drift test refuses a",
    "> row nothing cites.",
    "",
    "| Check | What must hold for the result to be accepted | Draws |",
    "|---|---|---|",
    ...checks.map(
      (check) => `| \`${check.id}\` | ${cell(check.verifies)} | ${check.draws.map((draw) => `\`${draw}\``).join(", ")} |`,
    ),
    "",
    END_MARKER,
  ].join("\n");
}

/**
 * Every check id a source file CITES: the first argument of a citing call
 * (`refuse`, `invalidResult`, `bindingFailure`) and every `check: "<id>"`
 * property, when that value is a string literal. A non-literal citation
 * (`check: parsed.check`) is a passthrough, not a citation, and is skipped.
 * @param {string} sourceText
 * @returns {Set<string>}
 */
export function extractCitedIngestionChecks(sourceText) {
  const sourceFile = ts.createSourceFile("cited.ts", sourceText, ts.ScriptTarget.Latest, true);
  const cited = new Set();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CITING_CALLS.has(node.expression.text) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      cited.add(node.arguments[0].text);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "check" &&
      ts.isStringLiteral(node.initializer)
    ) {
      cited.add(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return cited;
}

/** Replace the delimited block, leaving every other byte of the page untouched. */
export function spliceIngestionChecks(pageText, block) {
  return spliceGeneratedBlock(pageText, block, { begin: BEGIN_MARKER, end: END_MARKER, target: RENDER_FILE });
}

function main() {
  const current = readFileSync(join(repoRoot, RENDER_FILE), "utf8");
  runGeneratedArtifactCli({
    repoRoot,
    files: [{ target: RENDER_FILE, next: spliceIngestionChecks(current, renderIngestionChecks()) }],
    staleMessage:
      `The ingestion-check block no longer matches INGESTION_CHECKS in ${SOURCE_FILE}, so the page ` +
      `describes a check set the validators do not perform.`,
    fixCommand: `node scripts/shared/generate-ingestion-checks.mjs, then re-stage ${RENDER_FILE}`,
    okMessage: "ingestion-checks: contracts.md matches the declared ingestion check registry",
  });
}

// Importable as a library (the drift test re-runs the render and the citation
// extractor), so the CLI body runs ONLY on direct invocation — importing must
// never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
