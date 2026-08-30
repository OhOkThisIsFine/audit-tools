#!/usr/bin/env node
// Regenerate the mirrored TABLE regions of the three `spec/audit` contract docs:
//
//   spec/audit/artifact-contract.md  ← ARTIFACT_DEFINITIONS      (src/audit/io/artifacts.ts)
//   spec/audit/executor-catalog.md   ← EXECUTOR_REGISTRY         (src/audit/orchestrator/executors.ts)
//   spec/audit/dependency-map.md     ← ARTIFACT_DEPENDS_ON_MAP   (src/audit/orchestrator/dependencyMap.ts)
//
// WHY THIS EXISTS. Each doc's own prose already called its registry "authoritative"
// while restating that registry as a hand-written table, so a registry edit left the
// spec quietly wrong and nothing failed — the exact defect
// `scripts/shared/generate-executor-producers.mjs` fixed for the producer relation
// (owner decision, nightly docs-7, 2026-08-26: render these the same way, with the
// same never-hand-edit banner and check gate).
//
// REGIONS, NOT WHOLE FILES. These three docs are CONSTITUTIONAL
// (`src/shared/constitutionalDocPaths.ts`) and carry normative prose around their
// tables — staleness rules, cycle arguments, the leaf/host-input rationale. Only the
// tables are a mirror, so only the tables are generated, in place, between the
// BEGIN/END markers below; everything outside a marker pair is hand-written and never
// touched. That is `generate-handoff-roadmap.mjs`'s shape (a generated block inside a
// hand-written doc), not `generate-executor-producers.mjs`'s whole-file render — and
// it is why these docs stay constitutional while `*.generated.md` files deliberately
// do not.
//
// EXTRACTION IS STRUCTURAL — the `typescript` compiler API over the registry SOURCE
// TEXT, exactly as the executor-producers generator reads its registry (no new import
// path convention, no built `dist/`, no regex over a nested literal). Every shape it
// cannot read with certainty REFUSES rather than rendering a plausible row: an
// unknown artifact helper, an unresolvable filename identifier, a computed key whose
// constant is not in the declared constant set.
//
// The doc-side half — Purpose / Notes prose and the section a row is filed under —
// is declared in `./spec-mirror-data.mjs` and JOINED onto the registry rows here. The
// join is reconciled both ways, so a registry row no region declares (and a declared
// row no registry holds) is a hard refusal.
//
//   node scripts/shared/generate-spec-mirrors.mjs           # write
//   node scripts/shared/generate-spec-mirrors.mjs --check   # verify only
//
// `--check` is wired as `npm run check:spec-mirrors` (verify:checks + the derived
// pre-commit leg via the guard-reach registry).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { spliceGeneratedBlock } from "./generatedArtifacts.mjs";

import {
  ARTIFACT_REGISTRY_FILE,
  CONSTANT_SOURCE_FILES,
  DEPENDENCY_MAP_FILE,
  EXECUTOR_REGISTRY_FILE,
  SPEC_MIRROR_DOCS,
  SPEC_MIRROR_REGIONS,
} from "./spec-mirror-data.mjs";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * @typedef {object} SpecMirrorRow
 * @property {string} [artifact] artifact fileName (kinds `artifacts` / `dependencies`)
 * @property {string} [executor] executor id (kind `executors`)
 * @property {string} [purpose] doc prose for the artifact-contract Purpose column
 * @property {string} [note] doc prose for the executor-catalog Notes column
 * @property {string} [deliverable] doc prose for the reporting table's fourth column
 * @property {false} [registered] `false` marks a deliberate non-registry row
 * @property {string} [format] format cell for a non-registry row (registry rows derive it)
 * @property {string} [why] why a non-registry row is not a registry entry
 * @property {string} [citationExempt] reason rendered as a `doc-citation-exempt` comment
 */

/**
 * @typedef {object} SpecMirrorRegion
 * @property {string} id region id, unique across all docs
 * @property {string} doc repo-relative doc path the region lives in
 * @property {'artifacts'|'executors'|'dependencies'} kind
 * @property {string} [phase] `artifacts` only: the registry phase this region renders
 * @property {boolean} [deliverableColumn] `artifacts` only: render the fourth column
 * @property {readonly SpecMirrorRow[]} rows
 */

/** Which helper builds which artifact payload format. Unknown helper ⇒ refusal. */
const ARTIFACT_HELPER_FORMATS = {
  jsonArtifact: "json",
  ndjsonArtifact: "ndjson",
  textArtifact: "text",
};

const parseSource = (file, text) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

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

/** The initializer of a top-level `export const <name> = …`, unwrapped. */
function exportedInitializer(sourceFile, name, file) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      if (!declaration.initializer) {
        throw new Error(`\`${name}\` in ${file} has no initializer`);
      }
      return unwrapExpression(declaration.initializer);
    }
  }
  throw new Error(`could not find \`export const ${name}\` in ${file}`);
}

/**
 * Every exported `const NAME = "literal"` in the declared constant sources.
 * The registries name a few filenames by identifier; resolving one from anywhere
 * else would be a guess, and a wrong guess renders a plausible row.
 */
export function readStringConstants(root = repoRoot) {
  const constants = new Map();
  for (const file of CONSTANT_SOURCE_FILES) {
    const sourceFile = parseSource(file, readFileSync(join(root, file), "utf8"));
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const exported = (statement.modifiers ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isStringLiteral(initializer)) {
          constants.set(declaration.name.text, initializer.text);
        }
      }
    }
  }
  return constants;
}

/** A string literal, or an identifier resolved from the declared constant set. */
function resolveName(node, constants, context) {
  if (node && ts.isStringLiteral(node)) return node.text;
  if (node && ts.isIdentifier(node)) {
    const value = constants.get(node.text);
    if (value !== undefined) return value;
    throw new Error(
      `${context} names \`${node.text}\`, which is not an exported string constant in ` +
        `${CONSTANT_SOURCE_FILES.join(" / ")}. Add the declaring module to ` +
        `CONSTANT_SOURCE_FILES in scripts/shared/spec-mirror-data.mjs — the render never ` +
        `guesses a filename.`,
    );
  }
  throw new Error(
    `${context} is not a plain string literal or a resolvable identifier — refusing to ` +
      `render a row whose name the extraction had to guess.`,
  );
}

/** `JSON` / `**NDJSON**` / `**Markdown**`, derived from the helper and the extension. */
function formatCellFor(helperFormat, fileName, context) {
  if (helperFormat === "json") return "JSON";
  if (helperFormat === "ndjson") return "**NDJSON**";
  if (fileName.endsWith(".md")) return "**Markdown**";
  throw new Error(
    `${context} is a text artifact named "${fileName}", whose format this render cannot ` +
      `name (only \`.md\` text artifacts render as Markdown). Teach formatCellFor the new ` +
      `format rather than letting the table state the wrong one.`,
  );
}

/** ARTIFACT_DEFINITIONS as plain data, in declaration order. */
export function parseArtifactDefinitions(sourceText, constants) {
  const sourceFile = parseSource(ARTIFACT_REGISTRY_FILE, sourceText);
  const literal = exportedInitializer(
    sourceFile,
    "ARTIFACT_DEFINITIONS",
    ARTIFACT_REGISTRY_FILE,
  );
  if (!ts.isObjectLiteralExpression(literal)) {
    throw new Error(`ARTIFACT_DEFINITIONS in ${ARTIFACT_REGISTRY_FILE} is not an object literal`);
  }
  const entries = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        `ARTIFACT_DEFINITIONS uses an unsupported property form (a spread or shorthand) — ` +
          `refusing to guess which artifacts it declares.`,
      );
    }
    const key = property.name.getText().replace(/^["']|["']$/g, "");
    const context = `ARTIFACT_DEFINITIONS.${key}`;
    const call = unwrapExpression(property.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
      throw new Error(
        `${context} is not a \`<helper>(fileName, phase)\` call — refusing to guess its ` +
          `filename, phase or format.`,
      );
    }
    const helperFormat = ARTIFACT_HELPER_FORMATS[call.expression.text];
    if (!helperFormat) {
      throw new Error(
        `${context} is built by \`${call.expression.text}\`, which this render does not know ` +
          `how to format. Add it to ARTIFACT_HELPER_FORMATS.`,
      );
    }
    const fileName = resolveName(call.arguments[0], constants, `${context}'s filename`);
    const phaseNode = call.arguments[1];
    if (!phaseNode || !ts.isStringLiteral(phaseNode)) {
      throw new Error(`${context} does not declare its phase as a string literal.`);
    }
    entries.push({
      key,
      fileName,
      phase: phaseNode.text,
      format: formatCellFor(helperFormat, fileName, context),
    });
  }
  if (entries.length === 0) {
    throw new Error("ARTIFACT_DEFINITIONS parsed as empty — refusing to generate empty tables");
  }
  return entries;
}

/** EXECUTOR_REGISTRY as plain data (id / kind / obligation ids), in declaration order. */
export function parseExecutorRegistry(sourceText) {
  const sourceFile = parseSource(EXECUTOR_REGISTRY_FILE, sourceText);
  const literal = exportedInitializer(
    sourceFile,
    "EXECUTOR_REGISTRY",
    EXECUTOR_REGISTRY_FILE,
  );
  if (!ts.isArrayLiteralExpression(literal)) {
    throw new Error(`EXECUTOR_REGISTRY in ${EXECUTOR_REGISTRY_FILE} is not an array literal`);
  }
  const executors = literal.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) {
      throw new Error("EXECUTOR_REGISTRY contains a non-object element — refusing to guess its shape");
    }
    /** @type {{id: string|null, kind: string|null, obligations: string[]|null}} */
    const executor = { id: null, kind: null, obligations: null };
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replace(/^["']|["']$/g, "");
      const value = property.initializer;
      if (name === "id" || name === "kind") {
        if (!ts.isStringLiteral(value)) {
          throw new Error(`EXECUTOR_REGISTRY entry declares a non-literal \`${name}\``);
        }
        executor[name] = value.text;
      } else if (name === "obligation_ids") {
        if (!ts.isArrayLiteralExpression(value)) {
          throw new Error("EXECUTOR_REGISTRY entry declares a non-array `obligation_ids`");
        }
        executor.obligations = value.elements.map((obligation) => {
          if (!ts.isStringLiteral(obligation)) {
            throw new Error("EXECUTOR_REGISTRY declares a non-literal obligation id");
          }
          return obligation.text;
        });
      }
    }
    if (executor.id === null || executor.kind === null || executor.obligations === null) {
      throw new Error(
        `EXECUTOR_REGISTRY entry "${executor.id ?? "<unnamed>"}" is missing id, kind or ` +
          `obligation_ids — the catalog row would state something the registry does not.`,
      );
    }
    return executor;
  });
  if (executors.length === 0) {
    throw new Error("EXECUTOR_REGISTRY parsed as empty — refusing to generate an empty catalog");
  }
  return executors;
}

/** ARTIFACT_DEPENDS_ON_MAP as `[{ artifact, dependsOn }]`, in declaration order. */
export function parseDependencyMap(sourceText, constants) {
  const sourceFile = parseSource(DEPENDENCY_MAP_FILE, sourceText);
  const literal = exportedInitializer(
    sourceFile,
    "ARTIFACT_DEPENDS_ON_MAP",
    DEPENDENCY_MAP_FILE,
  );
  if (!ts.isObjectLiteralExpression(literal)) {
    throw new Error(`ARTIFACT_DEPENDS_ON_MAP in ${DEPENDENCY_MAP_FILE} is not an object literal`);
  }
  const rows = literal.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(
        "ARTIFACT_DEPENDS_ON_MAP uses an unsupported property form — refusing to guess its edges",
      );
    }
    const name = property.name;
    // A quoted key IS the filename; a computed key names a filename constant. A bare
    // identifier key is neither (no artifact filename is a valid identifier — they all
    // carry a dot), so it refuses rather than being read either way.
    let artifact;
    if (ts.isComputedPropertyName(name)) {
      artifact = resolveName(name.expression, constants, "an ARTIFACT_DEPENDS_ON_MAP computed key");
    } else if (ts.isStringLiteral(name)) {
      artifact = name.text;
    } else {
      throw new Error(
        `ARTIFACT_DEPENDS_ON_MAP key \`${name.getText()}\` is neither a quoted filename nor a ` +
          `computed filename constant — refusing to guess which artifact it keys.`,
      );
    }
    const value = property.initializer;
    if (!ts.isArrayLiteralExpression(value)) {
      throw new Error(`ARTIFACT_DEPENDS_ON_MAP["${artifact}"] is not an array literal`);
    }
    const dependsOn = value.elements.map((element) =>
      resolveName(element, constants, `an upstream of ARTIFACT_DEPENDS_ON_MAP["${artifact}"]`),
    );
    return { artifact, dependsOn };
  });
  if (rows.length === 0) {
    throw new Error("ARTIFACT_DEPENDS_ON_MAP parsed as empty — refusing to generate an empty DAG table");
  }
  return rows;
}

/** All three registries, as plain data. */
export function readRegistries(root = repoRoot) {
  const constants = readStringConstants(root);
  return {
    artifacts: parseArtifactDefinitions(
      readFileSync(join(root, ARTIFACT_REGISTRY_FILE), "utf8"),
      constants,
    ),
    executors: parseExecutorRegistry(
      readFileSync(join(root, EXECUTOR_REGISTRY_FILE), "utf8"),
    ),
    dependencies: parseDependencyMap(
      readFileSync(join(root, DEPENDENCY_MAP_FILE), "utf8"),
      constants,
    ),
  };
}

// ── reconciliation ───────────────────────────────────────────────────────────

/**
 * Refuse unless the declared regions and the registries describe the same rows.
 * Returns error strings; empty means the join is total in both directions.
 */
export function reconcileRegions(regions, registries) {
  const errors = [];
  const seenIds = new Set();
  for (const region of regions) {
    if (seenIds.has(region.id)) errors.push(`duplicate region id "${region.id}"`);
    seenIds.add(region.id);
    if (!SPEC_MIRROR_DOCS.includes(region.doc)) {
      errors.push(`region "${region.id}" targets ${region.doc}, which is not a declared mirror doc`);
    }
  }

  /** @type {(kind: string, key: 'artifact'|'executor') => Map<string, {region: any, row: any}>} */
  const declaredOf = (kind, key) => {
    const declared = new Map();
    for (const region of regions) {
      if (region.kind !== kind) continue;
      for (const row of region.rows) {
        const name = row[key];
        if (typeof name !== "string" || name === "") {
          errors.push(`region "${region.id}" declares a row with no ${key}`);
          continue;
        }
        if (declared.has(name)) {
          errors.push(`"${name}" is declared twice across ${kind} regions`);
          continue;
        }
        declared.set(name, { region, row });
      }
    }
    return declared;
  };

  const declaredArtifacts = declaredOf("artifacts", "artifact");
  for (const entry of registries.artifacts) {
    const hit = declaredArtifacts.get(entry.fileName);
    if (!hit) {
      errors.push(
        `ARTIFACT_DEFINITIONS declares "${entry.fileName}" (phase ${entry.phase}) but no ` +
          `artifact-contract region does — add a row (with its Purpose) to the ${entry.phase} region`,
      );
      continue;
    }
    if (hit.region.phase !== entry.phase) {
      errors.push(
        `"${entry.fileName}" is registry-phase ${entry.phase} but declared in region ` +
          `"${hit.region.id}" (phase ${hit.region.phase})`,
      );
    }
    if (typeof hit.row.purpose !== "string" || hit.row.purpose.trim() === "") {
      errors.push(`"${entry.fileName}" declares no Purpose prose in region "${hit.region.id}"`);
    }
  }
  const registryFileNames = new Set(registries.artifacts.map((entry) => entry.fileName));
  for (const [name, hit] of declaredArtifacts) {
    if (hit.row.registered === false) {
      if (registryFileNames.has(name)) {
        errors.push(
          `"${name}" is declared as a NON-registry row in "${hit.region.id}" but ` +
            `ARTIFACT_DEFINITIONS holds it — drop the \`registered: false\` marker`,
        );
      }
      if (typeof hit.row.format !== "string" || typeof hit.row.why !== "string") {
        errors.push(
          `non-registry row "${name}" in "${hit.region.id}" must state its own \`format\` and ` +
            `a \`why\` it is deliberately outside the registry`,
        );
      }
      continue;
    }
    if (!registryFileNames.has(name)) {
      errors.push(
        `region "${hit.region.id}" declares "${name}", which ARTIFACT_DEFINITIONS does not — ` +
          `remove the row, or mark it \`registered: false\` with a stated \`why\``,
      );
    }
  }

  const declaredExecutors = declaredOf("executors", "executor");
  const registryExecutorIds = new Set(registries.executors.map((executor) => executor.id));
  for (const executor of registries.executors) {
    if (!declaredExecutors.has(executor.id)) {
      errors.push(
        `EXECUTOR_REGISTRY declares "${executor.id}" but no executor-catalog region does — ` +
          `file it under the stage it runs in`,
      );
    }
  }
  for (const [id, hit] of declaredExecutors) {
    if (!registryExecutorIds.has(id)) {
      errors.push(`region "${hit.region.id}" declares executor "${id}", which EXECUTOR_REGISTRY does not`);
    }
  }

  const declaredDependencies = declaredOf("dependencies", "artifact");
  const mapKeys = new Set(registries.dependencies.map((row) => row.artifact));
  for (const row of registries.dependencies) {
    if (!declaredDependencies.has(row.artifact)) {
      errors.push(
        `ARTIFACT_DEPENDS_ON_MAP declares "${row.artifact}" but no dependency-map region does — ` +
          `file it under its DAG phase`,
      );
    }
  }
  for (const [name, hit] of declaredDependencies) {
    if (!mapKeys.has(name)) {
      errors.push(
        `region "${hit.region.id}" declares "${name}", which ARTIFACT_DEPENDS_ON_MAP does not ` +
          `(a leaf input has no row of its own)`,
      );
    }
  }

  return errors;
}

// ── rendering ────────────────────────────────────────────────────────────────

export const beginMarker = (id) =>
  `<!-- BEGIN GENERATED spec-mirror ${id} — scripts/shared/generate-spec-mirrors.mjs — DO NOT EDIT BY HAND -->`;
export const endMarker = (id) => `<!-- END GENERATED spec-mirror ${id} -->`;

/** Pipe-safe markdown cell. Idempotent: an already-escaped pipe is left alone. */
const cell = (text) => String(text).replace(/(?<!\\)\|/g, "\\|");
const codeCell = (text) => `\`${text}\``;

/** The artifact cell, carrying a `doc-citation-exempt` comment when one is declared. */
function artifactCell(row) {
  const name = codeCell(row.artifact);
  return row.citationExempt
    ? `<!-- doc-citation-exempt: ${cell(row.citationExempt)} --> ${name}`
    : name;
}

function renderArtifactRegion(region, registries) {
  const byFileName = new Map(registries.artifacts.map((entry) => [entry.fileName, entry]));
  const header = region.deliverableColumn
    ? ["| Artifact | Format | Purpose | Deliverable? |", "|---|---|---|---|"]
    : ["| Artifact | Format | Purpose |", "|---|---|---|"];
  const lines = [...header];
  for (const row of region.rows) {
    const entry = byFileName.get(row.artifact);
    const format = entry ? entry.format : String(row.format);
    const cells = [artifactCell(row), format, cell(row.purpose)];
    if (region.deliverableColumn) cells.push(cell(row.deliverable ?? ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}

function renderExecutorRegion(region, registries) {
  const byId = new Map(registries.executors.map((executor) => [executor.id, executor]));
  const lines = ["| Executor | Kind | Obligation | Notes |", "|---|---|---|---|"];
  for (const row of region.rows) {
    const executor = byId.get(row.executor);
    if (!executor) {
      // Unreachable once reconciliation has run — kept as a refusal rather than a
      // silently blank row, since this renderer is exported and callable directly.
      throw new Error(`executor "${row.executor}" is not in EXECUTOR_REGISTRY`);
    }
    const obligations =
      executor.obligations.length > 0
        ? executor.obligations.map(codeCell).join(", ")
        : "*(none — `preferredExecutor` only)*";
    const note = typeof row.note === "string" && row.note.trim() !== "" ? cell(row.note) : "—";
    lines.push(`| ${codeCell(executor.id)} | ${executor.kind} | ${obligations} | ${note} |`);
  }
  return lines;
}

function renderDependencyRegion(region, registries) {
  const byArtifact = new Map(registries.dependencies.map((row) => [row.artifact, row]));
  const lines = ["| Artifact | Depends on |", "|---|---|"];
  for (const row of region.rows) {
    const declared = byArtifact.get(row.artifact);
    if (!declared) {
      throw new Error(`artifact "${row.artifact}" is not a key of ARTIFACT_DEPENDS_ON_MAP`);
    }
    lines.push(`| ${codeCell(declared.artifact)} | ${declared.dependsOn.map(codeCell).join(", ")} |`);
  }
  return lines;
}

/** One region's table, markers included. */
export function renderRegion(region, registries) {
  const rows =
    region.kind === "artifacts"
      ? renderArtifactRegion(region, registries)
      : region.kind === "executors"
        ? renderExecutorRegion(region, registries)
        : renderDependencyRegion(region, registries);
  return [beginMarker(region.id), ...rows, endMarker(region.id)].join("\n");
}

/** Replace one delimited region, leaving every other byte of the doc untouched. */
export function spliceRegion(docText, id, block) {
  return spliceGeneratedBlock(docText, block, {
    begin: beginMarker(id),
    end: endMarker(id),
    target: `the generated region "${id}"`,
  });
}

/** Every mirror doc's fully-rendered text, keyed by repo-relative path. */
export function renderDocs(root, registries, regions = SPEC_MIRROR_REGIONS) {
  const rendered = new Map();
  for (const region of regions) {
    const current =
      rendered.get(region.doc) ?? readFileSync(join(root, region.doc), "utf8");
    rendered.set(region.doc, spliceRegion(current, region.id, renderRegion(region, registries)));
  }
  return rendered;
}

/**
 * The CLI body, root-parameterized so a contract test can drive it against a
 * throwaway tree. Returns the process exit code.
 */
export function runGenerator({
  root = repoRoot,
  check = false,
  regions = SPEC_MIRROR_REGIONS,
  out = (text) => {
    process.stdout.write(text);
  },
  err = (text) => {
    process.stderr.write(text);
  },
} = {}) {
  const registries = readRegistries(root);
  const errors = reconcileRegions(regions, registries);
  if (errors.length > 0) {
    err(
      `\nthe spec-mirror declaration and the code registries describe different rows ` +
        `(${errors.length}):\n` +
        errors.map((error) => `  - ${error}`).join("\n") +
        `\nFix scripts/shared/spec-mirror-data.mjs — a registry row must never be missing ` +
        `from the spec, and the spec must never claim a row the code does not declare.\n\n`,
    );
    return 1;
  }

  const rendered = renderDocs(root, registries, regions);
  const stale = [];
  for (const [doc, text] of rendered) {
    if (readFileSync(join(root, doc), "utf8") !== text) stale.push(doc);
  }

  if (check) {
    if (stale.length > 0) {
      err(
        `\nGenerated spec-mirror region(s) are STALE:\n` +
          stale.map((doc) => `  - ${doc}`).join("\n") +
          `\nThe rendered tables no longer match ARTIFACT_DEFINITIONS / EXECUTOR_REGISTRY / ` +
          `ARTIFACT_DEPENDS_ON_MAP, so the spec states something the code does not.\n` +
          `Fix: node scripts/shared/generate-spec-mirrors.mjs, then re-stage the doc(s).\n` +
          `Never hand-edit inside the markers — the next regeneration overwrites it.\n\n`,
      );
      return 1;
    }
    const rows = regions.reduce((total, region) => total + region.rows.length, 0);
    out(
      `✓ spec-mirrors: ${rows} row(s) across ${regions.length} generated region(s) in ` +
        `${rendered.size} doc(s) match their registries\n`,
    );
    return 0;
  }

  // Only the stale docs are written: rewriting an identical file would churn its
  // mtime on every run, which the derived pre-commit preflight reads as a change.
  for (const doc of stale) {
    writeFileSync(join(root, doc), String(rendered.get(doc)), "utf8");
  }
  out(
    stale.length > 0
      ? `wrote ${stale.join(", ")}\n`
      : `no change — every generated spec-mirror region already matches its registry\n`,
  );
  return 0;
}

// Importable as a library (the drift test re-runs the render), so the CLI body runs
// ONLY on direct invocation — importing must never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(runGenerator({ check: process.argv.includes("--check") }));
}
