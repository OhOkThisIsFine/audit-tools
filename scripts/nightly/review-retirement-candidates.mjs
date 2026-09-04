#!/usr/bin/env node
// Retirement-candidate enumerator for docs/reviews/ (C-10, ceremony review
// 2026-08-29). The archive is excluded from every doc gate BY CONSTRUCTION
// (scripts/doc-manifest-data.mjs), so no staleness review can ever mark a
// dated record spent — which made the archive permanently growing: 27 files
// held zero citations from anywhere when first measured. This enumerator is
// the release valve, and it gates nothing.
//
// A candidate is a docs/reviews/*.md whose filename date is older than
// --days (default 30) and which is cited by NOTHING outside docs/reviews/ —
// not by a script, hook, skill, src, test, config, another doc, or the
// external per-project memory store. A citation from a SIBLING review does
// not keep a record alive: sibling-only clusters are exactly the class that
// never retires (the ceremony review's Class C).
//
// STANDING RULE, NOT A PER-BATCH QUESTION (owner decision c47dc1bf930484be,
// answered 2026-09-03). "Retire a dated review after 30 days when no tracked
// canonical document, backlog item, or current handoff cites it. Git remains
// the historical archive. Apply the rule automatically rather than returning
// each batch for another owner decision." Returning each batch was the defect:
// the same 17-18 records were re-proposed night after night, and re-asking a
// settled question is what teaches the channel to be ignored. So `--retire`
// EXECUTES the rule; bare invocation still only enumerates, because the
// enumeration is also read by humans.
//
//   node scripts/nightly/review-retirement-candidates.mjs [--days N] [--retire]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (/** @type {string} */ p) => p.replace(/\\/g, "/");

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  return out.split("\0").filter(Boolean).map(norm);
}

/** Best-effort external memory dir for this repo's project slug; null if absent. */
function memoryDir() {
  const slug = norm(repoRoot).replace(/[:/]/g, "-");
  const conventional = join(homedir(), ".claude", "projects", slug, "memory");
  return existsSync(conventional) ? conventional : null;
}

export function filenameDate(name) {
  const m = /(\d{4}-\d{2}-\d{2})[a-z]?\.md$/.exec(name);
  return m ? new Date(`${m[1]}T00:00:00Z`) : null;
}

function main() {
  const daysArg = process.argv.indexOf("--days");
  const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) : 30;
  const retire = process.argv.includes("--retire");
  if (!Number.isFinite(days) || days < 0) {
    process.stderr.write(`--days must be a non-negative number\n`);
    process.exit(2);
  }

  const tracked = trackedFiles();
  const reviews = tracked.filter((f) => f.startsWith("docs/reviews/") && f.endsWith(".md"));
  const outside = tracked.filter((f) => !f.startsWith("docs/reviews/"));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // One read pass over the outside corpus, then substring checks per basename.
  const outsideText = outside
    .map((f) => {
      try {
        return readFileSync(join(repoRoot, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  const memDir = memoryDir();
  const memoryText = memDir
    ? readdirSync(memDir)
        .map((f) => {
          try {
            return readFileSync(join(memDir, f), "utf8");
          } catch {
            return "";
          }
        })
        .join("\n")
    : "";

  const skippedUndated = [];
  const candidates = [];
  for (const review of reviews) {
    const name = basename(review);
    const dated = filenameDate(name);
    if (!dated) {
      skippedUndated.push(review);
      continue;
    }
    if (dated.getTime() > cutoff) continue; // inside the grace window
    // Match the STEM, not the filename: a citation that drops the `.md` (a bare
    // `docs/reviews/foo-2026-07-19` reference, a prose mention) is still a
    // citation, and missing one now DELETES the record rather than merely
    // over-proposing it. Widening the match can only ever spare a record, which
    // is the safe direction for a destructive rule.
    const stem = name.replace(/\.md$/, "");
    if (outsideText.includes(stem) || memoryText.includes(stem)) continue;
    candidates.push(review);
  }

  if (skippedUndated.length) {
    process.stdout.write(
      `note: ${skippedUndated.length} review file(s) carry no filename date and were skipped:\n` +
        skippedUndated.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }
  if (!memDir) {
    process.stdout.write("note: no external memory dir found — memory citations not checked this run\n");
  }
  if (candidates.length === 0) {
    process.stdout.write(`✓ review-retirement: no candidate older than ${days}d with zero outside citations\n`);
    return;
  }
  if (!retire) {
    process.stdout.write(
      `${candidates.length} retirement candidate(s) — dated review docs older than ${days}d that nothing outside ` +
        `docs/reviews/ cites. The standing rule retires these; re-run with --retire to apply it. ` +
        `Git history keeps the content:\n` +
        candidates.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
    return;
  }

  // A retired record's SURVIVING siblings still link to it, and a relative link
  // that resolves to nothing is a red `check:doc-links` — so the rule as first
  // written produced a broken build every time it fired. Retiring a
  // sibling-only cluster is the rule's whole point, so the fix is to de-link
  // rather than to spare the record: rewrite `[label](retired.md)` down to
  // `label` plus a pointer at the history that still holds the content.
  const retiring = new Set(candidates.map((c) => basename(c)));
  const relinked = [];
  for (const survivor of reviews.filter((r) => !candidates.includes(r))) {
    const abs = join(repoRoot, survivor);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const next = text.replace(/\[([^\]]+)\]\(([^)]+\.md)\)/g, (whole, label, target) =>
      retiring.has(basename(target)) ? `${label} (retired — in git history)` : whole,
    );
    if (next !== text) {
      writeFileSync(abs, next);
      relinked.push(survivor);
    }
  }

  // The standing rule applies itself. `git rm` rather than unlink so the
  // deletion is staged as one reviewable set and the content stays in history.
  execFileSync("git", ["rm", "--quiet", "--", ...candidates], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (relinked.length) {
    process.stdout.write(
      `de-linked ${relinked.length} surviving review(s) that pointed at a retired record:\n` +
        relinked.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
  }
  process.stdout.write(
    `retired ${candidates.length} dated review record(s) older than ${days}d with zero outside citations ` +
      `(standing rule c47dc1bf930484be); git history keeps the content:\n` +
      candidates.map((f) => `  - ${f}`).join("\n") +
      "\n",
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
