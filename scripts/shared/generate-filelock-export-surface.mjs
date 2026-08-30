#!/usr/bin/env node
// cdc-06 export-signature snapshot pin for the shared file lock (work item
// CP-BLOCK-CP-NODE-25; host decision option (a) RE-SCOPED: the proper-lockfile
// swap was DECLINED — the current directory-lockfile implementation in
// src/shared/io/fileLock.ts stays, including CP-NODE-1's stale-steal /
// atomic-write fixes from 62af2c8d). What lands instead is THIS pin: a
// generated snapshot of the module's exported surface, so CP-NODE-18's
// green-unmodified check can prove the surface stayed IDENTICAL mechanically
// instead of by inspection.
//
// WHAT IS PINNED. Every top-level `export` of src/shared/io/fileLock.ts —
// name, kind, and a structurally rendered signature: parameter names with
// their declared types, generic bounds, heritage clauses, interface/class
// member shapes, and the exported const's value. Deliberately NOT pinned:
// implementation bodies, doc comments, private helpers (RETRY_INTERVAL_*,
// STEAL_CLAIM_SUFFIX, stealStaleLock, the heartbeat), and function-parameter
// DEFAULT EXPRESSIONS — `timeoutMs: number` pins the shape while
// `DEFAULT_TIMEOUT_MS` is a private binding whose rename is not surface drift;
// the position still records ` = <default>` so defaultedness itself is pinned.
//
// Extraction is STRUCTURAL (the `typescript` compiler API, already a
// devDependency), not a hand-rolled scanner: a regex over declarations is the
// dropped-input scanner shape this repo bans. An unrecognized top-level export
// shape or member kind is REFUSED loudly, never silently skipped, and a zero-
// export extraction refuses outright (an empty pin would read as coverage).
//
//   node scripts/shared/generate-filelock-export-surface.mjs           # write
//
// There is deliberately NO --check arm (an unwired one existed and was deleted —
// F7, ceremony review 2026-08-29): enforcement is the drift test alone.
// Drift is pinned by tests/shared/filelock-export-surface.test.ts, which
// re-runs the extraction against the live source, diffs it against the tracked
// render, and holds mutation controls proving the diff actually fires.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const SOURCE_FILE = "src/shared/io/fileLock.ts";
export const RENDER_FILE = "scripts/shared/filelock-export-surface.generated.json";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Collapse formatting so the pin tracks shape, not layout. */
const norm = (text) => text.replace(/\s+/g, " ").trim();

function hasModifier(node, kind) {
  return (node.modifiers ?? []).some((m) => m.kind === kind);
}

function renderTypeParams(typeParameters, sf) {
  if (!typeParameters?.length) return "";
  const inner = typeParameters
    .map((p) => {
      let out = p.name.getText(sf);
      if (p.constraint) out += ` extends ${norm(p.constraint.getText(sf))}`;
      if (p.default) out += ` = ${norm(p.default.getText(sf))}`;
      return out;
    })
    .join(", ");
  return `<${inner}>`;
}

function renderParameter(param, sf) {
  const parts = [
    param.dotDotDotToken ? "..." : "",
    param.name.getText(sf),
    param.questionToken ? "?" : "",
  ];
  if (param.type) parts.push(`: ${norm(param.type.getText(sf))}`);
  // Defaultedness is surface; the default EXPRESSION is not (see header).
  if (param.initializer) parts.push(" = <default>");
  return parts.join("");
}

function renderMembers(members, sf, { includeBodies = false } = {}) {
  return members.map((m) => {
    let out;
    switch (m.kind) {
      case ts.SyntaxKind.PropertySignature:
      case ts.SyntaxKind.PropertyDeclaration:
        out = `${hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) ? "readonly " : ""}${m.name.getText(sf)}${m.questionToken ? "?" : ""}: ${m.type ? norm(m.type.getText(sf)) : "<inferred>"}`;
        break;
      case ts.SyntaxKind.MethodSignature:
        out = `${m.name.getText(sf)}${renderTypeParams(m.typeParameters, sf)}(${(m.parameters ?? []).map((p) => renderParameter(p, sf)).join(", ")})${m.returnType ? `: ${norm(m.returnType.getText(sf))}` : ": <inferred>"}`;
        break;
      case ts.SyntaxKind.MethodDeclaration: {
        const params = (m.parameters ?? []).map((p) => renderParameter(p, sf)).join(", ");
        out = `${hasModifier(m, ts.SyntaxKind.StaticKeyword) ? "static " : ""}${m.name.getText(sf)}${renderTypeParams(m.typeParameters, sf)}(${params})${m.returnType ? `: ${norm(m.returnType.getText(sf))}` : ": <inferred>"}`;
        break;
      }
      case ts.SyntaxKind.Constructor:
        out = `constructor(${(m.parameters ?? []).map((p) => renderParameter(p, sf)).join(", ")})`;
        break;
      default:
        throw new Error(
          `unsupported member kind ${ts.SyntaxKind[m.kind]} in ${SOURCE_FILE} — extend renderMembers rather than silently dropping it`,
        );
    }
    return out + (includeBodies ? "" : "");
  });
}

function renderHeritage(clauses, sf) {
  if (!clauses?.length) return [];
  return clauses.flatMap((c) =>
    c.types.map((t) => `${c.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements"} ${norm(t.getText(sf))}`),
  );
}

/**
 * Extract the exported surface of SOURCE_FILE as structured records. Pure —
 * reads the source, returns data; the CLI body and the drift test both call
 * this. Refuses loudly on any export shape it does not recognize (never a
 * silent skip — that is how a pin stops covering what it claims to).
 */
export function extractFileLockExportSurface(sourceText = readFileSync(join(repoRoot, SOURCE_FILE), "utf8")) {
  const sf = ts.createSourceFile(SOURCE_FILE, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const diags = /** @type {any} */ (sf).parseDiagnostics ?? [];
  if (diags.length) {
    throw new Error(`${SOURCE_FILE} failed to parse: ${diags[0].message}`);
  }

  const exports = [];
  for (const statement of sf.statements) {
    // The switch below exhaustively validates the concrete declaration kind.
    const stmt = /** @type {any} */ (statement);
    const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) {
      throw new Error(`unsupported default export in ${SOURCE_FILE}`);
    }

    switch (stmt.kind) {
      case ts.SyntaxKind.VariableStatement: {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            throw new Error(`unsupported destructured export ${decl.name.getText(sf)} in ${SOURCE_FILE}`);
          }
          exports.push({
            name: decl.name.getText(sf),
            kind: "const",
            type: decl.type ? norm(decl.type.getText(sf)) : "<inferred>",
            value: decl.initializer ? norm(decl.initializer.getText(sf)) : null,
          });
        }
        break;
      }
      case ts.SyntaxKind.FunctionDeclaration: {
        exports.push({
          name: stmt.name.getText(sf),
          kind: "function",
          signature: `function ${stmt.name.getText(sf)}${renderTypeParams(stmt.typeParameters, sf)}(${(stmt.parameters ?? [])
            .map((p) => renderParameter(p, sf))
            .join(", ")})${stmt.type ? `: ${norm(stmt.type.getText(sf))}` : ": <inferred>"}`,
        });
        break;
      }
      case ts.SyntaxKind.ClassDeclaration: {
        exports.push({
          name: stmt.name.getText(sf),
          kind: "class",
          heritage: renderHeritage(stmt.heritageClauses, sf),
          members: renderMembers(
            (stmt.members ?? []).filter((m) => !hasModifier(m, ts.SyntaxKind.PrivateKeyword)),
            sf,
          ),
        });
        break;
      }
      case ts.SyntaxKind.InterfaceDeclaration: {
        exports.push({
          name: stmt.name.getText(sf),
          kind: "interface",
          heritage: renderHeritage(stmt.heritageClauses, sf),
          members: renderMembers(stmt.members ?? [], sf),
        });
        break;
      }
      case ts.SyntaxKind.TypeAliasDeclaration: {
        exports.push({
          name: stmt.name.getText(sf),
          kind: "type_alias",
          definition: norm(stmt.type.getText(sf)),
        });
        break;
      }
      default:
        throw new Error(
          `unsupported top-level export shape (${ts.SyntaxKind[stmt.kind]}) in ${SOURCE_FILE} — ` +
            `extend extractFileLockExportSurface rather than silently dropping it`,
        );
    }
  }

  if (exports.length === 0) {
    throw new Error(`no exports found in ${SOURCE_FILE} — refusing to write an empty surface pin`);
  }
  // Stable, content-derived order (the repo's extractor invariant): declaration
  // order IS the authorial order and is stable under re-extraction; assert it.
  const names = exports.map((e) => e.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`duplicate exported name in ${SOURCE_FILE}: ${names.join(", ")}`);
  }
  return { module: SOURCE_FILE, exports };
}

/** Render the surface as the tracked JSON pin, with a content hash for quick eyeball diffs. */
export function renderSurfacePin(surface) {
  const body = { module: surface.module, exports: surface.exports };
  return (
    JSON.stringify(
      {
        $comment: [
          "@generated by scripts/shared/generate-filelock-export-surface.mjs — DO NOT EDIT.",
          `Exported surface of ${SOURCE_FILE} (cdc-06 snapshot pin).`,
          "Regenerate: node scripts/shared/generate-filelock-export-surface.mjs",
          "Drift test: tests/shared/filelock-export-surface.test.ts",
        ],
        ...body,
        sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
      null,
      2,
    ) + "\n"
  );
}

function main() {
  const rendered = renderSurfacePin(extractFileLockExportSurface());
  writeFileSync(join(repoRoot, RENDER_FILE), rendered, "utf8");
  process.stdout.write(`wrote ${RENDER_FILE}\n`);
}

// Importable as a library (the drift test re-runs the extraction), so the CLI
// body runs ONLY on direct invocation — importing must never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

