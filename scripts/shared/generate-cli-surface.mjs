#!/usr/bin/env node
// Regenerate the installer-verb block inside `docs/audit-pkg/product.md`.
//
// WHY THIS EXISTS. product.md introduced its list as "the supported user-facing
// surfaces" and then named neither `verify-install` nor `install-host`;
// operator-guide.md named `verify-install` but not `install-host`. Two
// hand-written copies of one verb set, each incomplete, disagreeing with each
// other and with the bins — the classic shape of a list that something else can
// generate.
//
// The verbs and their one-line summaries are DECLARED in
// `wrapper/installer-verb-help.mjs`, which is the same module both shipped bins
// read to answer `<verb> --help`. Rendering from it means a verb added there
// cannot go undocumented, and the doc cannot describe a verb the bins do not
// route. operator-guide.md keeps no second copy: it points here.
//
// SCOPE. The block covers the wrapper-intercepted INSTALLER verbs only. The
// other product surfaces (the slash-command, the one-time global install,
// `prompt-path`, the repo-local backend fallback) are prose in the same section
// and stay hand-written — they are not a list this module declares.
//
//   node scripts/shared/generate-cli-surface.mjs           # write
//   node scripts/shared/generate-cli-surface.mjs --check    # verify only
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INSTALLER_VERBS, installerVerbSummary } from "../../wrapper/installer-verb-help.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SOURCE_FILE = "wrapper/installer-verb-help.mjs";
export const RENDER_FILE = "docs/audit-pkg/product.md";
/** The bin whose surface this page documents (docs/audit-pkg is the audit package). */
const BIN = "audit-code";
const PRODUCT = "/audit-code";

export const BEGIN_MARKER =
  "<!-- BEGIN GENERATED CLI SURFACE — scripts/shared/generate-cli-surface.mjs — DO NOT EDIT BY HAND -->";
export const END_MARKER = "<!-- END GENERATED CLI SURFACE -->";

/** The rendered block, markers included. */
export function renderCliSurface() {
  if (INSTALLER_VERBS.length === 0) {
    throw new Error("INSTALLER_VERBS is empty — refusing to render an empty surface list");
  }
  return [
    BEGIN_MARKER,
    "",
    `> Rendered from \`${SOURCE_FILE}\` — the module both shipped bins read to answer`,
    "> `<verb> --help`. Add a verb there and this list follows.",
    "",
    ...INSTALLER_VERBS.map((verb) => `- \`${BIN} ${verb}\` — ${installerVerbSummary(verb, PRODUCT)}`),
    "",
    END_MARKER,
  ].join("\n");
}

/** Replace the delimited block, leaving every other byte of the page untouched. */
export function spliceCliSurface(pageText, block) {
  const begin = pageText.indexOf(BEGIN_MARKER);
  const end = pageText.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `${RENDER_FILE} is missing the generated CLI-surface markers (or they are out of order).\n` +
        `Restore this pair around the generated block:\n  ${BEGIN_MARKER}\n  ${END_MARKER}`,
    );
  }
  if (
    pageText.indexOf(BEGIN_MARKER, begin + BEGIN_MARKER.length) !== -1 ||
    pageText.indexOf(END_MARKER, end + END_MARKER.length) !== -1
  ) {
    throw new Error(`${RENDER_FILE} contains multiple CLI-surface markers; refusing to choose one block.`);
  }
  return pageText.slice(0, begin) + block + pageText.slice(end + END_MARKER.length);
}

function main() {
  const outputPath = join(repoRoot, RENDER_FILE);
  const current = readFileSync(outputPath, "utf8");
  const next = spliceCliSurface(current, renderCliSurface());

  if (process.argv.includes("--check")) {
    if (current !== next) {
      process.stderr.write(
        `\n${RENDER_FILE}'s CLI-surface block is stale.\n` +
          `It no longer matches the verbs declared in ${SOURCE_FILE}, so the page describes a ` +
          `surface the bins do not route.\n` +
          `Fix: node scripts/shared/generate-cli-surface.mjs, then re-stage ${RENDER_FILE}\n\n`,
      );
      process.exit(1);
    }
    process.stdout.write("✓ cli-surface: product.md matches the declared installer verbs\n");
    return;
  }

  writeFileSync(outputPath, next, "utf8");
  process.stdout.write(`wrote ${outputPath}\n`);
}

// Importable as a library (the drift test re-runs the render), so the CLI body
// runs ONLY on direct invocation — importing must never write to the tree.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
