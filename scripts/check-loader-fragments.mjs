#!/usr/bin/env node
// check:loader-fragments — reconcile the four shipped loader assets against the
// canonical fragment declarations in `scripts/shared/loader-fragments-data.mjs`.
//
// The property (see that module's header for the full argument): across a
// loader pair, each instruction has ONE full statement and the other asset
// POINTS at it; a genuinely universal paragraph is verbatim in all four. Before
// this check, the "Read the returned JSON only far enough…" paragraph existed in
// four drifted copies and the `--input` / `--guidance-file` rule twice inside
// one pair — a property held by an instruction to remember, which is the thing
// this repository bans.
//
// Comparison is whitespace-normalized (markdown re-wraps; line breaks are
// presentation), and exact otherwise: a reworded copy fails.
//
//   node scripts/check-loader-fragments.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOADER_FRAGMENTS,
  loaderFragmentAssets,
  normalizeFragmentText,
  pointerPhrase,
} from "./shared/loader-fragments-data.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{ fragments?: typeof LOADER_FRAGMENTS, readFile: (path: string) => string }} input
 * @returns {string[]} human-readable failures; empty means the tree is consistent
 */
export function checkLoaderFragments({ fragments = LOADER_FRAGMENTS, readFile }) {
  const failures = [];
  const normalized = new Map();
  const textOf = (path) => {
    if (!normalized.has(path)) {
      normalized.set(path, normalizeFragmentText(readFile(path)));
    }
    return normalized.get(path);
  };

  for (const fragment of fragments) {
    const needle = normalizeFragmentText(fragment.text);
    if (needle.length === 0) {
      failures.push(`${fragment.id}: fragment text is empty`);
      continue;
    }
    const verbatimIn = fragment.verbatimIn ?? [];
    if (verbatimIn.length === 0) {
      failures.push(`${fragment.id}: declares no verbatimIn asset to state the rule`);
      continue;
    }

    // Every declared carrier holds the text verbatim.
    for (const path of verbatimIn) {
      if (!textOf(path).includes(needle)) {
        failures.push(
          `${fragment.id}: ${path} must carry the canonical fragment verbatim ` +
            `(it has drifted, or is missing it)`,
        );
      }
    }

    // No OTHER reconciled asset restates it: an asset that is not a declared
    // carrier must point instead, so a second full statement cannot quietly
    // reappear (the axis-1 drift).
    for (const path of loaderFragmentAssets(fragments)) {
      if (verbatimIn.includes(path)) continue;
      if ((fragment.pointers ?? []).some((pointer) => pointer.path === path)) continue;
      if (textOf(path).includes(needle)) {
        failures.push(
          `${fragment.id}: ${path} restates the rule instead of pointing at ` +
            `${verbatimIn.join(" / ")} — a second full statement is the drift this guards`,
        );
      }
    }

    // Every pointer names the asset holding the statement, and does not also
    // restate it (pointing AND restating is the belt-and-braces copy).
    for (const { path, home } of fragment.pointers ?? []) {
      const phrase = normalizeFragmentText(pointerPhrase(home));
      if (!textOf(path).includes(phrase)) {
        failures.push(
          `${fragment.id}: ${path} must point at ${home} — expected the phrase ` +
            `"${pointerPhrase(home)}"`,
        );
      }
      if (!verbatimIn.includes(home)) {
        failures.push(
          `${fragment.id}: ${path} points at ${home}, which is not a declared verbatimIn carrier`,
        );
      }
      if (textOf(path).includes(needle)) {
        failures.push(
          `${fragment.id}: ${path} both points at ${home} AND restates the rule`,
        );
      }
    }
  }
  return failures;
}

function main() {
  const failures = checkLoaderFragments({
    readFile: (path) => readFileSync(join(repoRoot, path), "utf8"),
  });
  if (failures.length > 0) {
    process.stderr.write(
      `check:loader-fragments: ${failures.length} problem(s):\n` +
        failures.map((failure) => `  - ${failure}`).join("\n") +
        `\n\nFragments are declared in scripts/shared/loader-fragments-data.mjs.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `✓ loader-fragments: ${LOADER_FRAGMENTS.length} fragment(s) reconciled across ` +
      `${loaderFragmentAssets().length} shipped loader asset(s)\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
