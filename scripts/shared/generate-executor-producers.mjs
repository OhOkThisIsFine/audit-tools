#!/usr/bin/env node
// Regenerate `spec/audit/executor-producers.generated.md` — the by-artifact
// render of the executor→artifact producer relation.
//
// WHY THIS EXISTS. The relation used to be a hand-written table inside
// `spec/audit/dependency-map.md`, whose own prose called the registries "the
// machine-readable ground truth" while neither encoded a producer edge. The
// relation is now DECLARED on `EXECUTOR_REGISTRY[].produces`
// (`src/audit/orchestrator/executors.ts`), with `LIFECYCLE_PRODUCTIONS` in the
// same module covering the artifacts written outside every executor, and this
// generator renders it — the project's standing "never hand-maintain a table
// something else can generate" rule.
//
// The render deliberately does NOT live in dependency-map.md: that doc is
// constitutional (`src/shared/constitutionalDocPaths.ts`), and a generator
// rewriting it on every registry edit would turn a routine executor change into
// an owner-escalation event — the exact thing the constitutional refusal exists
// to prevent. dependency-map.md and executor-catalog.md point here instead.
//
// Extraction is STRUCTURAL (the `typescript` compiler API, already a
// devDependency and the idiom of generate-filelock-export-surface.mjs): the
// registry is a nested object literal, which a regex cannot read without
// silently dropping what it fails to match.
//
//   node scripts/shared/generate-executor-producers.mjs           # write
//   node scripts/shared/generate-executor-producers.mjs --check   # verify only
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export const SOURCE_FILE = "src/audit/orchestrator/executors.ts";
export const RENDER_FILE = "spec/audit/executor-producers.generated.md";

/** Byte-order sort — locale-independent, so the render is identical everywhere. */
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Read one top-level `export const <name> = [ … ]` array literal as plain data. */
function readArrayLiteral(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`${name} in ${SOURCE_FILE} is not an array literal`);
      }
      return initializer.elements.map((element) => readObject(element, name));
    }
  }
  throw new Error(`could not find \`export const ${name}\` in ${SOURCE_FILE}`);
}

/** One object literal → a plain object of string / string[] / object[] values. */
function readObject(node, context) {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error(`${context} contains a non-object element — refusing to guess its shape`);
  }
  const out = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${context} uses an unsupported property form — refusing to guess its shape`);
    }
    const key = property.name.getText().replace(/^["']|["']$/g, "");
    const value = property.initializer;
    if (ts.isStringLiteral(value)) out[key] = value.text;
    else if (ts.isArrayLiteralExpression(value)) {
      out[key] = value.elements.map((element) =>
        ts.isStringLiteral(element) ? element.text : readObject(element, context),
      );
    } else {
      // Never "deliberately ignored": an unreadable initializer (a concatenated
      // note, a `*_FILENAME` identifier, a call) would drop the property and
      // still render a plausible row — the silent-drop shape this module's
      // header bans. Refuse instead, like the three refusals above.
      throw new Error(
        `${context} property "${key}" is not a readable literal — the render would silently ` +
          `drop it. Accepted forms: a plain double- or single-quoted string, an array of such ` +
          `strings, or an array of object literals whose properties are themselves such ` +
          `values. Anything else — a template literal, a ` +
          `concatenation, an identifier such as a *_FILENAME constant, a call — refuses; keep ` +
          `producer declarations literal`,
      );
    }
  }
  return out;
}

/**
 * The declared relation, as plain data, from TypeScript source TEXT.
 *
 * Separate from `readProducerDeclaration` so the refusals above can be
 * exercised against a scratch source string rather than by mutating the tracked
 * registry.
 *
 * @param {string} sourceText contents of a module declaring both registries.
 * @returns {{executors: object[], lifecycle: object[]}}
 */
export function parseProducerDeclaration(sourceText) {
  const sourceFile = ts.createSourceFile(SOURCE_FILE, sourceText, ts.ScriptTarget.Latest, true);
  const executors = readArrayLiteral(sourceFile, "EXECUTOR_REGISTRY");
  const lifecycle = readArrayLiteral(sourceFile, "LIFECYCLE_PRODUCTIONS");
  if (executors.length === 0 || lifecycle.length === 0) {
    throw new Error("the producer declaration parsed as empty — refusing to generate an empty table");
  }
  for (const executor of executors) {
    if (!Array.isArray(executor.produces)) {
      throw new Error(`executor ${executor.id} declares no \`produces\` — the render would omit its artifacts`);
    }
  }
  return { executors, lifecycle };
}

/** The declared relation, as plain data: { executors, lifecycle }. */
export function readProducerDeclaration(root = repoRoot) {
  return parseProducerDeclaration(readFileSync(join(root, SOURCE_FILE), "utf8"));
}

/** `exec` or `exec` (note), pipe-safe for a markdown table cell. */
const producerCell = (executorId, note) =>
  `\`${executorId}\`${note ? ` (${note.replace(/\|/g, "\\|")})` : ""}`;

export function renderProducerTable({ executors, lifecycle }) {
  /** artifact → { primary: [], refresh: [] } */
  const byArtifact = new Map();
  const sideChannel = [];
  for (const executor of executors) {
    for (const production of executor.produces) {
      if (production.role === "side_channel") {
        sideChannel.push({ ...production, executor: executor.id });
        continue;
      }
      if (!byArtifact.has(production.artifact)) {
        byArtifact.set(production.artifact, { primary: [], refresh: [] });
      }
      byArtifact.get(production.artifact)[production.role].push({
        executor: executor.id,
        note: production.note,
      });
    }
  }

  const lines = [
    "<!-- @generated by scripts/shared/generate-executor-producers.mjs — DO NOT EDIT. -->",
    "<!-- Source of truth: src/audit/orchestrator/executors.ts (EXECUTOR_REGISTRY[].produces + LIFECYCLE_PRODUCTIONS). -->",
    "",
    "# Which executor produces each artifact",
    "",
    "The by-artifact render of the executor→artifact producer relation. The relation",
    "is declared on `EXECUTOR_REGISTRY` in `src/audit/orchestrator/executors.ts`; this",
    "file is its projection and is regenerated from it, never hand-edited.",
    "",
    "*Primary* = the executor that authoritatively writes the artifact; *also written /",
    "refreshed by* = executors that rewrite it later in the pipeline (staleness-driven).",
    "",
    "| Artifact | Primary producer | Also written / refreshed by |",
    "|---|---|---|",
  ];

  for (const artifact of [...byArtifact.keys()].sort(byKey)) {
    const { primary, refresh } = byArtifact.get(artifact);
    const primaryCell =
      primary.length > 0
        ? primary
            .sort((a, b) => byKey(a.executor, b.executor))
            .map((p) => producerCell(p.executor, p.note))
            .join(", ")
        : "—";
    const refreshCell =
      refresh.length > 0
        ? refresh
            .sort((a, b) => byKey(a.executor, b.executor))
            .map((r) => producerCell(r.executor, r.note))
            .join(", ")
        : "—";
    lines.push(`| \`${artifact}\` | ${primaryCell} | ${refreshCell} |`);
  }

  lines.push(
    "",
    "## Written outside every executor",
    "",
    "Artifacts the run lifecycle writes directly, so no executor declares them in",
    "its `produces`.",
    "",
    "| Artifact | Writer | Why |",
    "|---|---|---|",
  );
  for (const entry of [...lifecycle].sort((a, b) => byKey(a.artifact, b.artifact))) {
    lines.push(
      `| \`${entry.artifact}\` | ${entry.writer.replace(/\|/g, "\\|")} | ${entry.reason.replace(/\|/g, "\\|")} |`,
    );
  }

  lines.push(
    "",
    "## Side-channel writes",
    "",
    "Files an executor writes to disk that are deliberately outside the artifact",
    "registry and the staleness DAG.",
    "",
    "| File | Written by | Why |",
    "|---|---|---|",
  );
  for (const entry of sideChannel.sort(
    (a, b) => byKey(a.artifact, b.artifact) || byKey(a.executor, b.executor),
  )) {
    lines.push(
      `| \`${entry.artifact}\` | \`${entry.executor}\` | ${(entry.note ?? "").replace(/\|/g, "\\|")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const outputPath = join(repoRoot, RENDER_FILE);
  const rendered = renderProducerTable(readProducerDeclaration());

  if (process.argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(outputPath, "utf8");
    } catch {
      /* missing */
    }
    if (current !== rendered) {
      process.stderr.write(
        `\n${RENDER_FILE} is stale or missing.\n` +
          `The rendered producer table no longer matches EXECUTOR_REGISTRY[].produces, so the ` +
          `spec would credit the wrong executor with writing an artifact.\n` +
          `Fix: node scripts/shared/generate-executor-producers.mjs, then re-stage ${RENDER_FILE}\n\n`,
      );
      process.exit(1);
    }
    process.stdout.write("✓ executor-producers: the rendered table matches the registry declaration\n");
    return;
  }

  writeFileSync(outputPath, rendered, "utf8");
  process.stdout.write(`wrote ${outputPath}\n`);
}

// Importable as a library (the drift test re-runs the render), so the CLI body
// runs ONLY on direct invocation — importing must never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
