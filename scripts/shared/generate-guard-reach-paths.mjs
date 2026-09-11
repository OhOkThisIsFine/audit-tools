#!/usr/bin/env node
// Regenerate `scripts/shared/guard-reach-derived-paths.generated.mjs` — the
// pre-build twins of two declarations the guard-reach registry needs and cannot
// import.
//
// WHY A TWIN AT ALL. `scripts/guard-reach-data.mjs` is loaded by the commit gate
// under plain node, BEFORE any build, so it cannot import the TypeScript module
// that declares the schema producers. That argues for ONE generated sibling it
// imports — never a hand-kept second copy. Same arrangement, and the same rule,
// as `generate-constitutional-doc-paths.mjs` and
// `generate-loop-core-patterns.mjs`.
//
// WHY DERIVE AND NOT JUST WRITE. A hand-kept list beside a derived one is the
// drift this repository bans outright: the registry's reach would silently stop
// covering a schema the moment someone added a third one. So both halves are
// EXTRACTED from their real sources —
//
//   SITES_PINNED_PATHS              ← the PINNED_PATHS array literal in
//                                     scripts/check-sites-pinned.mjs
//   CONTRACT_SCHEMA_PRODUCER_SCHEMAS ← the tracked `schemas/*.schema.json` files
//                                     named by CONTRACT_SCHEMA_PRODUCERS in
//                                     src/audit/contracts/workerSchemas.ts
//
// — and `--check` (wired into verify:checks as `check:guard-reach-paths`) fails
// the build when the committed twin no longer matches.
//
// The second extraction reads the TS SOURCE TEXT rather than importing it: this
// script runs in the pre-commit skeleton too, where `tsx` resolution of the
// package subpath is not guaranteed. Reading a string literal out of source is
// what `generate-constitutional-doc-paths.mjs` does for the same reason, and it
// is safe here because the thing being read is a plain object literal of string
// keys — a shape `tests/shared/contract-construction-sites.test.ts` independently
// holds the REAL module to.
//
//   node scripts/shared/generate-guard-reach-paths.mjs           # write
//   node scripts/shared/generate-guard-reach-paths.mjs --check   # verify only
//
// sites-pinned: tests/shared/contract-construction-sites.test.ts
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The repo-wide argument rule. Without it a mistyped flag (`--chek`) is read as
// consent to do the DEFAULT action, which here is a durable write to a tracked
// file — the shape the guard exists to refuse.
import { guardArgv } from "./argvGuard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

export const GENERATED_PATH = "scripts/shared/guard-reach-derived-paths.generated.mjs";
const SITES_SOURCE = "scripts/check-sites-pinned.mjs";
const PRODUCERS_SOURCE = "src/audit/contracts/workerSchemas.ts";

/**
 * Pull the string entries out of the `PINNED_PATHS` array literal.
 * @param {string} source
 */
export function extractPinnedPaths(source) {
  const match = source.match(/export const PINNED_PATHS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error(
      `could not find the PINNED_PATHS array literal in ${SITES_SOURCE} — the extraction ` +
        `is stale, not the source. Fix the pattern rather than hand-writing the twin.`,
    );
  }
  // Both quote styles: the array is authored with whoever's style the file uses,
  // and a single-quote-only extractor silently reads an empty list — which the
  // guard below turns into a refusal rather than a narrowed reach.
  const paths = [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (paths.length === 0) {
    throw new Error("PINNED_PATHS parsed as empty — refusing to generate an empty scan set");
  }
  return paths;
}

/**
 * The schema filenames named as KEYS of `CONTRACT_SCHEMA_PRODUCERS`.
 *
 * Keys, not values: each key is a `schemas/<name>.json` path, and the reach row
 * needs the FILE, not the contract it renders from.
 * @param {string} source
 */
export function extractSchemaProducerFiles(source) {
  const block = source.match(
    /export const CONTRACT_SCHEMA_PRODUCERS[^=]*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!block) {
    throw new Error(
      `could not find the CONTRACT_SCHEMA_PRODUCERS object literal in ${PRODUCERS_SOURCE}`,
    );
  }
  const files = [...block[1].matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]);
  if (files.length === 0) {
    throw new Error(
      "CONTRACT_SCHEMA_PRODUCERS parsed as empty — refusing to generate an empty reach row",
    );
  }
  return files;
}

/** Render the twin module. Sorted, so the file is stable across runs. */
export function renderDerivedPaths({ pinnedPaths, schemaFiles }) {
  const list = (items) => items.map((item) => `  ${JSON.stringify(item)},`).join("\n");
  return `// GENERATED — do not edit. Run \`node scripts/shared/generate-guard-reach-paths.mjs\`.
//
// The pre-build twins of two declarations the guard-reach registry needs but
// cannot import: the registry is loaded by the commit gate under plain node,
// with no build, so a \`.ts\` import would not resolve.
//
//   SITES_PINNED_PATHS               ← PINNED_PATHS in ${SITES_SOURCE}
//   CONTRACT_SCHEMA_PRODUCER_SCHEMAS ← the schema files named by
//                                      CONTRACT_SCHEMA_PRODUCERS in
//                                      ${PRODUCERS_SOURCE}
//
// \`npm run check:guard-reach-paths\` fails the build when this drifts from
// either source, so the twin can never silently narrow the reach it declares.
//
// It asserts no behaviour of its own — it is a data projection, and the two
// sources it projects are pinned by tests/shared/contract-construction-sites.test.ts
// and tests/shared/sites-pinned-gate.test.ts.

// sites-pinned: none — GENERATED data twin. Its content is derived from
// PINNED_PATHS and CONTRACT_SCHEMA_PRODUCERS, each pinned by its own suite, and
// check:guard-reach-paths refuses any drift from those sources. Editing this file
// by hand is exactly what that gate exists to catch.

/** The staged paths the per-site pinning gate pins. */
export const SITES_PINNED_PATHS = [
${list(pinnedPaths)}
];

/** The rendered schema files this repo's worker-schema producer writes. */
export const CONTRACT_SCHEMA_PRODUCER_SCHEMAS = [
${list([...schemaFiles].sort())}
];
`;
}

/** @param {{check: boolean}} options */
function main({ check }) {
  const pinnedPaths = extractPinnedPaths(readFileSync(join(repoRoot, SITES_SOURCE), "utf8"));
  const schemaFiles = extractSchemaProducerFiles(
    readFileSync(join(repoRoot, PRODUCERS_SOURCE), "utf8"),
  );
  const wanted = renderDerivedPaths({ pinnedPaths, schemaFiles });
  const target = join(repoRoot, GENERATED_PATH);

  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // Absent reads as stale, never as "nothing to compare".
  }

  if (current === wanted) {
    console.log(
      `✓ guard-reach-paths: ${pinnedPaths.length} pinned path(s) + ${schemaFiles.length} schema ` +
        `file(s) in ${GENERATED_PATH} match their sources`,
    );
    return;
  }
  if (check) {
    console.error(
      `✗ guard-reach-paths: ${GENERATED_PATH} is STALE — the guard-reach registry's reach no ` +
        `longer matches the declarations it is derived from. The reach row would silently stop ` +
        `covering a path.\n  → node scripts/shared/generate-guard-reach-paths.mjs`,
    );
    process.exit(1);
  }
  writeFileSync(target, wanted, "utf8");
  console.log(`rewrote ${GENERATED_PATH}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  const args = guardArgv(process.argv.slice(2), {
    name: "generate-guard-reach-paths",
    usage: "node scripts/shared/generate-guard-reach-paths.mjs [--check]",
    flags: ["--check"],
  });
  main({ check: args.has("--check") });
}
