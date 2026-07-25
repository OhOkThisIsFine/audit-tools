/**
 * A backlog entry's code citation must still point at the code it cites.
 *
 * WHY THIS IS A TEST AND NOT A CAUTION. A backlog entry is read as a lead: the next pass
 * opens the cited range to decide whether the work is real. When the range drifts — and it
 * drifts on every edit above it — the lead points at whatever moved into those line
 * numbers, and the reader either re-derives the whole premise or believes the wrong code.
 * The G5 entry is the measured instance: it cited `auditorSources.ts:147-148` for the
 * `lies reachably` quarantine, and by the time it was re-checked those two lines were the
 * tail of an unrelated HTTP liveness probe, while the paragraph that actually states the
 * open property had moved to 390-394. Nothing detected that, because nothing was looking.
 *
 * THE ASSERTIONS ARE TWO-SIDED, deliberately — the same shape as
 * `backlog-tooling-closed-frictions.test.mjs`. Asserting only that the entry contains a
 * citation token would pass on a token pointing anywhere; asserting only the entry's
 * SILENCE about a settled clause would pass vacuously if that clause were un-built. So
 * each row proves BOTH halves against source: the anchor's line range still contains the
 * claim, and every clause the entry no longer carries is one the source shows is settled.
 * Build the auditor-id stamp for real and the `settled` half goes red, naming the clause
 * the backlog is allowed to carry again.
 *
 * The table is the extension point: add a row when an entry's premise is narrowed against
 * verified code. It stays small on purpose — an anchor is a ratchet on the source file's
 * line numbers, so a row is worth its cost only where the citation is the entry's load.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");

const ANCHORED_ENTRIES = [
  {
    what: "G5 — the `lies reachably` quarantine",
    // Locates the entry; must match exactly one, so a retitle fails loudly instead of
    // silently guarding nothing.
    locator: /lies[-\s]reachabl/i,
    file: "open-bugs.md",
    /** `path:from-to` tokens the entry must carry, each proven against the cited range. */
    anchors: [
      {
        token: "src/shared/providers/auditorSources.ts:390-394",
        evidence: [
          /\*\*Inline `api_key` is refused\.\*\*/,
          /only catcher \(the reactive `lies reachably`[\s\S]{0,24}quarantine\) is G5, not yet built/,
        ],
      },
    ],
    /**
     * Clauses the entry must NOT carry, each anchored to the source state that settles it.
     * `settledBy` runs first: it is what keeps the silence from being vacuous.
     */
    settled: [
      {
        clause: "declared ∩ ambient-verifiable reach (shipped as G2.5)",
        settledBy: () => {
          const src = readFileSync(join(REPO_ROOT, "src/shared/providers/auditorSources.ts"), "utf8");
          expect(
            /export function resolveAmbientSources\b/.test(src),
            "resolveAmbientSources is gone — the reach clause is open work again, so the " +
              "backlog may legitimately carry it. Delete this row rather than the assertion.",
          ).toBe(true);
        },
        restatement: /resolveAmbientSources|declared ∩ ambient/,
      },
      {
        clause: "the auditor-id stamp (a write-only field, dead as specced)",
        settledBy: () => {
          // The stamp is "built" only in the write-only sense: parsed, declared, and read
          // at exactly one non-emptiness site. A fourth file touching `auditor_id` means
          // someone gave it a consumer, which is the event that reopens the clause.
          expect(sourceFilesMentioning(/\bauditor_id\b/)).toEqual([
            "src/audit/cli/args.ts",
            "src/audit/cli/prompts.ts",
            "src/shared/types/auditorDescriptor.ts",
          ]);
        },
        restatement: /auditor.id stamp|auditor_id/,
      },
    ],
  },
];

/** Every backlog file, read once. */
function backlogFiles() {
  return readdirSync(BACKLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(BACKLOG_DIR, file), "utf8") }));
}

/** Top-level `- **…` entries of one backlog file, each with its continuation lines. */
function parseEntries(text) {
  const lines = text.split(/\r?\n/);
  const starts = lines.flatMap((l, i) => (/^- \*\*/.test(l) ? [i] : []));
  return starts.map((start, k) => ({
    line: start + 1,
    body: lines.slice(start, k + 1 < starts.length ? starts[k + 1] : lines.length).join("\n"),
  }));
}

/** The one entry a locator matches, or a failure naming how many it actually matched. */
function locateEntry({ file, locator }) {
  const found = backlogFiles()
    .filter((f) => f.file === file)
    .flatMap(({ text }) => parseEntries(text))
    .filter((e) => locator.test(e.body));
  expect(
    found.length,
    `${locator} must match exactly one entry in docs/backlog/${file} — a guard that ` +
      `matches none guards nothing, and one that matches several is checking the wrong text.`,
  ).toBe(1);
  return found[0];
}

/** Repo-relative, POSIX-separated, content-sorted source paths whose text matches `pattern`. */
function sourceFilesMentioning(pattern) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && pattern.test(readFileSync(full, "utf8"))) {
        hits.push(relative(REPO_ROOT, full).split("\\").join("/"));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return hits.sort();
}

/** The source text a `path:from-to` citation token points at, 1-indexed and inclusive. */
function citedRange(token) {
  const m = /^(.+):(\d+)-(\d+)$/.exec(token);
  expect(m, `"${token}" is not a path:from-to citation`).not.toBeNull();
  const [, path, from, to] = m;
  const lines = readFileSync(join(REPO_ROOT, path), "utf8").split(/\r?\n/);
  expect(
    lines.length,
    `${path} has ${lines.length} lines — the citation's range ends past the end of the file.`,
  ).toBeGreaterThanOrEqual(Number(to));
  return lines.slice(Number(from) - 1, Number(to)).join("\n");
}

describe("a backlog entry's code citation still points at the code it cites", () => {
  it("the table is non-empty, or this file is guarding nothing", () => {
    expect(ANCHORED_ENTRIES.length).toBeGreaterThan(0);
  });

  for (const row of ANCHORED_ENTRIES) {
    for (const anchor of row.anchors) {
      it(`${row.what} cites ${anchor.token}`, () => {
        const entry = locateEntry(row);
        expect(
          entry.body.includes(anchor.token),
          `docs/backlog/${row.file}:${entry.line} must cite ${anchor.token} — a reader ` +
            `follows the citation to decide whether the work is still open.`,
        ).toBe(true);
      });

      it(`${row.what}'s cited range still contains the claim`, () => {
        const text = citedRange(anchor.token);
        for (const pattern of anchor.evidence) {
          expect(
            pattern.test(text),
            `${anchor.token} no longer matches ${pattern} — the lines moved. Re-point the ` +
              `citation in docs/backlog/${row.file} at where the claim lives now.`,
          ).toBe(true);
        }
      });
    }

    for (const { clause, settledBy, restatement } of row.settled) {
      it(`${clause} is settled in the source`, settledBy);

      it(`${row.what} does not restate ${clause}`, () => {
        const entry = locateEntry(row);
        const hit = entry.body.match(restatement);
        expect(
          hit === null ? [] : [`docs/backlog/${row.file}:${entry.line}: ${JSON.stringify(hit[0])}`],
          `A settled clause read as open work sends the next pass to re-solve a solved ` +
            `problem. Trim the entry to its open remainder; the disposition belongs in the ` +
            `docs/reviews/ record the entry links.`,
        ).toEqual([]);
      });
    }
  }
});
