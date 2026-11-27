// sites-pinned: tests/shared/generated-artifacts-write.test.ts
// The ONE generated-artifact substrate (F1, ceremony review 2026-08-29).
//
// Fifteen scripts independently implemented "read source → render → compare to
// the tracked file → report stale → exit 1", and eight of them independently
// implemented "find BEGIN/END markers, refuse missing or duplicated pairs,
// splice" — the exact defect class `check:shared-primitives` gates in src/,
// written N times in the one tree that gate could not see. This module is the
// single implementation; each generator keeps only its extraction, its
// render(), and its declaration.
//
// CLI convention (the ONE convention): bare invocation WRITES the target(s);
// `--check` verifies byte parity and exits 1 on drift, printing the
// generator's stale rationale plus the fix command.
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function replaceGeneratedFile(path, content) {
  const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
  const previous = statSync(target, { throwIfNoEntry: false });
  const temp = join(dirname(target), `.generated-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
    if (previous) chmodSync(temp, previous.mode & 0o777);
    renameSync(temp, target);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* preserve the publish error */ }
    throw error;
  }
}

/**
 * Replace the generated region between two exact marker lines.
 * Refuses a missing or duplicated marker pair — a silent whole-file overwrite
 * or a wrong-block splice are both worse than a loud stop.
 *
 * @param {string} pageText current full text of the target file
 * @param {string} block replacement text INCLUDING both marker lines
 * @param {{ begin: string, end: string, target: string, validateBlock?: boolean,
 *   foreignMarkers?: string[] }} markers `validateBlock` additionally requires
 *   the REPLACEMENT to be exactly one outer marker pair (refusing
 *   marker-shaped generated content), and `foreignMarkers` refuses a block
 *   that contains a marker owned by another generated slot of the same file.
 * @returns {string}
 */
export function spliceGeneratedBlock(pageText, block, { begin, end, target, validateBlock = false, foreignMarkers = [] }) {
  if (validateBlock) {
    const blockBegin = block.indexOf(begin);
    const blockEnd = block.indexOf(end);
    if (
      blockBegin !== 0 ||
      blockEnd === -1 ||
      blockEnd + end.length !== block.length ||
      block.indexOf(begin, begin.length) !== -1 ||
      block.indexOf(end, blockEnd + end.length) !== -1
    ) {
      throw new Error(
        `replacement block for ${target} must contain exactly one outer marker pair; ` +
          `refusing marker-shaped generated content.`,
      );
    }
  }
  for (const marker of foreignMarkers) {
    if (marker !== begin && marker !== end && block.includes(marker)) {
      throw new Error(
        `replacement block for ${target} contains a marker owned by another generated slot; ` +
          `refusing marker-shaped generated content.`,
      );
    }
  }
  const beginAt = pageText.indexOf(begin);
  const endAt = pageText.indexOf(end);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(
      `${target} is missing its generated-block markers (${begin} … ${end}); ` +
        `restore the marker pair rather than hand-writing the block.`,
    );
  }
  if (
    pageText.indexOf(begin, beginAt + begin.length) !== -1 ||
    pageText.indexOf(end, endAt + end.length) !== -1
  ) {
    throw new Error(`${target} contains multiple generated-block marker pairs; refusing to choose one.`);
  }
  return pageText.slice(0, beginAt) + block + pageText.slice(endAt + end.length);
}

/**
 * The shared main() of every generated-artifact CLI.
 *
 * @param {object} spec
 * @param {string} spec.repoRoot absolute repo root (targets resolve against it)
 * @param {Array<{ target: string, next: string }>} spec.files repo-relative
 *   target path + its fully-rendered NEXT content (the caller composes any
 *   splice through {@link spliceGeneratedBlock} before calling)
 * @param {string} spec.staleMessage WHY drift matters — printed above the fix
 *   command on a `--check` failure (no trailing "Fix:" line; appended here)
 * @param {string} spec.fixCommand e.g. "node scripts/shared/generate-x.mjs"
 * @param {string} spec.okMessage the `--check` success line (without "✓ ")
 * @param {string} [spec.wroteSuffix] appended to each "wrote <target>" line
 * @param {string[]} [spec.argv]
 * @returns {void}
 */
export function runGeneratedArtifactCli({
  repoRoot,
  files,
  staleMessage,
  fixCommand,
  okMessage,
  wroteSuffix = "",
  argv = process.argv.slice(2),
}) {
  const unknown = argv.find(option => option !== "--check");
  if (unknown !== undefined) throw new Error("Unknown generator option: " + unknown);
  if (argv.includes("--check")) {
    const stale = files.filter(({ target, next }) => {
      let current = null;
      try {
        current = readFileSync(join(repoRoot, target), "utf8");
      } catch {
        /* missing counts as stale */
      }
      return current !== next;
    });
    if (stale.length > 0) {
      process.stderr.write(
        `\n${stale.map((f) => f.target).join(", ")} ${stale.length === 1 ? "is" : "are"} stale or missing.\n` +
          `${staleMessage}\n` +
          `Fix: ${fixCommand}\n\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`✓ ${okMessage}\n`);
    return;
  }
  for (const { target, next } of files) {
    replaceGeneratedFile(join(repoRoot, target), next);
    process.stdout.write(`wrote ${target}${wroteSuffix}\n`);
  }
}
