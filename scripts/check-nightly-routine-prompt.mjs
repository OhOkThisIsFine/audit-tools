#!/usr/bin/env node
// Whole-file generator + parity gate for the nightly scheduler prompt.
//
// `docs/nightly-routine.md` owns the routine and
// `docs/doc-review-guidelines.md` owns leg 1. The scheduler target used to
// restate both by hand behind a precedence rule; that second copy drifted into
// banning the helper the canonical guidance requires. The target now embeds the
// two sources, so a fact is edited once and every scheduler sees the same text.
//
// Usage:
//   node scripts/check-nightly-routine-prompt.mjs          # verify parity
//   node scripts/check-nightly-routine-prompt.mjs --write  # regenerate target
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCE_ROUTINE = "docs/nightly-routine.md";
export const SOURCE_GUIDELINES = "docs/doc-review-guidelines.md";
export const TARGET_PROMPT = "docs/nightly-routine-prompt.md";
export const PACKAGE_JSON = "package.json";
export const CHECK_SCRIPT = "node scripts/check-nightly-routine-prompt.mjs";

function normalizedSource(text, path) {
  const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
  if (normalized.length === 0) {
    throw new Error(`${path} is empty; refusing to render a partial scheduler prompt.`);
  }
  return normalized;
}

/** Render the complete generated scheduler prompt from its two canonical docs. */
export function renderNightlyRoutinePrompt(routineText, guidelinesText) {
  const routine = normalizedSource(routineText, SOURCE_ROUTINE);
  const guidelines = normalizedSource(guidelinesText, SOURCE_GUIDELINES);
  return [
    "# Nightly maintenance routine — generated scheduler prompt",
    "",
    `> **GENERATED from [\`${SOURCE_ROUTINE}\`](nightly-routine.md) and ` +
      `[\`${SOURCE_GUIDELINES}\`](doc-review-guidelines.md); do not hand-edit.**`,
    "> The scheduler consumes this standalone rendering. Every operational fact lives in one of",
    "> those two sources; this file adds no summary or precedence rule.",
    "> Regenerate: `node scripts/check-nightly-routine-prompt.mjs --write`.",
    "",
    "The two canonical contracts follow verbatim. Apply them together; the routine document owns",
    "cross-leg execution and the review-guidelines document owns leg 1.",
    "",
    `=== BEGIN ${SOURCE_ROUTINE} ===`,
    routine,
    `=== END ${SOURCE_ROUTINE} ===`,
    "",
    `=== BEGIN ${SOURCE_GUIDELINES} ===`,
    guidelines,
    `=== END ${SOURCE_GUIDELINES} ===`,
    "",
  ].join("\n");
}

/** Refuse a parity gate that is present on disk but absent from the release path. */
export function assertPackageWiring(packageText) {
  let pkg;
  try {
    pkg = JSON.parse(packageText);
  } catch (error) {
    throw new Error(`${PACKAGE_JSON} is not valid JSON: ${error.message}`);
  }

  if (pkg?.scripts?.["check:nightly-routine-prompt"] !== CHECK_SCRIPT) {
    throw new Error(
      `${PACKAGE_JSON} must define "check:nightly-routine-prompt": "${CHECK_SCRIPT}"`,
    );
  }

  const verifyChecks = pkg?.scripts?.["verify:checks"];
  const verifySteps = typeof verifyChecks === "string" ? verifyChecks.trim().split(/\s+/) : [];
  if (!verifySteps.includes("check:nightly-routine-prompt")) {
    throw new Error(
      `${PACKAGE_JSON} verify:checks must include check:nightly-routine-prompt`,
    );
  }
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--write" && arg !== "--check");
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")}; use --write or --check`);
  }

  const routine = readFileSync(join(root, SOURCE_ROUTINE), "utf8");
  const guidelines = readFileSync(join(root, SOURCE_GUIDELINES), "utf8");
  assertPackageWiring(readFileSync(join(root, PACKAGE_JSON), "utf8"));
  const rendered = renderNightlyRoutinePrompt(routine, guidelines);
  const targetPath = join(root, TARGET_PROMPT);
  const targetExists = existsSync(targetPath);
  const current = targetExists
    ? readFileSync(targetPath, "utf8").replace(/\r\n?/g, "\n")
    : null;

  if (args.includes("--write")) {
    if (current !== rendered) writeFileSync(targetPath, rendered, "utf8");
    process.stdout.write(
      `wrote ${TARGET_PROMPT} from ${SOURCE_ROUTINE} + ${SOURCE_GUIDELINES}\n`,
    );
    return;
  }

  if (!targetExists) {
    process.stderr.write(
      `${TARGET_PROMPT} is MISSING — regenerate it from ${SOURCE_ROUTINE} + ` +
        `${SOURCE_GUIDELINES}.\n` +
        `Run: node scripts/check-nightly-routine-prompt.mjs --write\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (current !== rendered) {
    process.stderr.write(
      `${TARGET_PROMPT} is STALE — it must be generated from ${SOURCE_ROUTINE} + ` +
        `${SOURCE_GUIDELINES}.\n` +
        `Edit the owning source, then run: node scripts/check-nightly-routine-prompt.mjs --write\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`✓ nightly-routine-prompt: generated target matches both sources\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`nightly-routine-prompt check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
