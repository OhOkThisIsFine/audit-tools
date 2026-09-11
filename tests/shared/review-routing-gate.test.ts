// Contract tests for the `docs/reviews/` routing declaration.
//
// WHY. Seven dated review records were cited by nothing tracked — over 1,500
// lines of identified, prioritized work no queue knew about. Nothing could catch
// it: no gate reconciled `docs/reviews/` against `docs/backlog/`, and the
// failure is silent by construction, because the reviews were well-formed and
// the backlog was well-formed and only the EDGE between them was missing.
//
// The obvious gate is the wrong one ("every review is cited from somewhere" reds
// a dogfood log and a measurement record, and a false red gets a gate disabled),
// so the mechanism is a DECLARATION the author writes once and the gate checks
// for existence and shape — never for truth. These cases pin that boundary: what
// is enforced, and what is deliberately left to the reader.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// INV-WH: never a raw child_process entry point in a test file — a windowless
// parent spawning a console child flashes a window on win32.
import { execFileSyncHidden } from "../helpers/spawn.mjs";
import {
  BASELINE_PATH,
  baselineAdditions,
  classifyReviewRecords,
  deadDestinationRows,
  evaluateRatchet,
  HEADER_LINES,
  ROUTING_DECLARATION,
} from "../../scripts/check-review-routing.mjs";
import { REVIEW_ROUTING_ROWS } from "../../scripts/review-routing-data.mjs";

const CHECKER = resolve(process.cwd(), "scripts/check-review-routing.mjs");

/** Flatten a `{ path: body }` map into the shape `classifyReviewRecords` takes. */
const classify = (records: Record<string, string>) =>
  classifyReviewRecords({
    files: Object.keys(records),
    read: (file: string) => records[file],
  });

describe("the routing declaration — the ONE form, in the record's HEADER", () => {
  it("recognizes the declaration form", () => {
    const match = ROUTING_DECLARATION.exec("<!-- review-routing: backlog-bugs -->");
    expect(match?.[1]).toBe("backlog-bugs");
  });

  it("classifies a declared record, and one with no declaration at all", () => {
    const { declared, undeclared } = classify({
      "docs/reviews/a-2026-01-01.md":
        "# Review\n\n<!-- review-routing: backlog-bugs -->\n\nFindings.\n",
      "docs/reviews/b-2026-01-02.md": "# Review\n\nFindings, no declaration.\n",
    });
    expect(declared).toEqual([{ file: "docs/reviews/a-2026-01-01.md", row: "backlog-bugs" }]);
    expect(undeclared).toEqual(["docs/reviews/b-2026-01-02.md"]);
  });

  it("refuses a declaration buried BELOW the header — the reader must meet it first", () => {
    const body = Array.from({ length: HEADER_LINES + 5 }, (_, i) => `line ${i}`).join("\n");
    const { undeclared } = classify({
      "docs/reviews/deep-2026-01-01.md": `# Review\n\n${body}\n<!-- review-routing: memory -->\n`,
    });
    expect(undeclared).toEqual(["docs/reviews/deep-2026-01-01.md"]);
  });

  it("separates an UNKNOWN row from an undeclared record — different fixes", () => {
    // A typo must not read as "declared": it would silently route nowhere.
    const { declared, undeclared, unknownRow } = classify({
      "docs/reviews/typo-2026-01-01.md": "<!-- review-routing: backlog-bugz -->\n",
    });
    expect(declared).toEqual([]);
    expect(undeclared).toEqual([]);
    expect(unknownRow).toEqual([
      { file: "docs/reviews/typo-2026-01-01.md", row: "backlog-bugz" },
    ]);
  });
});

describe("the routing rows are data with checked destinations", () => {
  it("every row is well-formed, and `no-forward-work` is the one null destination", () => {
    for (const row of REVIEW_ROUTING_ROWS) {
      expect(row.id, row.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(typeof row.means === "string" && row.means.length > 20, row.id).toBe(true);
    }
    const nulls = REVIEW_ROUTING_ROWS.filter((row) => row.destination === null);
    expect(nulls.map((row) => row.id)).toEqual(["no-forward-work"]);
  });

  it("a row pointing at a destination no tracked file matches is a DEAD RULE", () => {
    const rows = [
      { id: "live", means: "x".repeat(30), destination: "docs/backlog/open-bugs.md" },
      { id: "dead", means: "x".repeat(30), destination: "docs/backlog/retired-file.md" },
      { id: "none", means: "x".repeat(30), destination: null },
    ];
    const dead = deadDestinationRows(rows, (d: string) => d === "docs/backlog/open-bugs.md");
    expect(dead.map((row: { id: string }) => row.id)).toEqual(["dead"]);
  });

  it("the repo's own rows all point at destinations that exist", () => {
    // The live-tree half: a destination retired without the row following is
    // exactly the dead rule that would green a record routed nowhere.
    const repoRoot = resolve(import.meta.dirname, "..", "..");
    for (const row of REVIEW_ROUTING_ROWS) {
      if (row.destination === null) continue;
      expect(
        existsSync(resolve(repoRoot, row.destination)),
        `${row.id} → ${row.destination}`,
      ).toBe(true);
    }
  });
});

describe("the baseline is a RATCHET, never an exemption", () => {
  it("a NEW undeclared record is an error; a baselined one is not", () => {
    const errors = evaluateRatchet({
      undeclared: ["docs/reviews/old-2026-01-01.md", "docs/reviews/new-2026-09-10.md"],
      baseline: ["docs/reviews/old-2026-01-01.md"],
    });
    const joined = errors.join("\n");
    expect(joined).toMatch(/added since this mechanism landed[\s\S]*new-2026-09-10\.md/);
    // The baselined record is NOT named as an offence...
    expect(joined).not.toMatch(/added since[\s\S]*old-2026-01-01\.md/);
    // ...but its presence in the baseline is exactly why it is allowed, so it
    // must NOT also be reported as stale.
    expect(joined).not.toMatch(/no longer undeclared/);
  });

  it("a baseline entry that is no longer undeclared is an error — the list only shrinks", () => {
    const errors = evaluateRatchet({
      undeclared: [],
      baseline: ["docs/reviews/declared-since-2026-01-01.md"],
    });
    expect(errors.join("\n")).toMatch(/no longer undeclared[\s\S]*declared-since-2026-01-01\.md/);
  });

  it("is silent when the baseline and the undeclared set agree exactly", () => {
    expect(
      evaluateRatchet({
        undeclared: ["docs/reviews/a-2026-01-01.md"],
        baseline: ["docs/reviews/a-2026-01-01.md"],
      }),
    ).toEqual([]);
  });

  // The READ side reds a stale entry and a new undeclared record, but the
  // WRITER had no guard of its own: `--update-baseline` recorded whatever was
  // undeclared, so one run could put a record ON the list and the next run would
  // find the baseline and the tree in perfect agreement. The teeth have to be on
  // the command that widens the list, or the ratchet only bites after the damage.
  it("the WRITER refuses an entry that would be ADDED — the list only shrinks", () => {
    expect(
      baselineAdditions({
        previous: ["docs/reviews/old-2026-01-01.md"],
        next: ["docs/reviews/old-2026-01-01.md", "docs/reviews/new-2026-09-10.md"],
      }),
    ).toEqual(["docs/reviews/new-2026-09-10.md"]);
  });

  // The pure-function cases above pin the RULE; this one pins that the rule is
  // actually WIRED into `--update-baseline`. A guard that exists and is never
  // called is the shape these findings keep taking, and only a run of the real
  // script can tell the two apart.
  it("`--update-baseline` REFUSES on a real repo when it would add an entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-baseline-"));
    const git = (...args: string[]) =>
      execFileSyncHidden("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    const write = (relPath: string, body: string) => {
      const abs = join(dir, relPath);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(abs, body, "utf8");
    };
    try {
      git("init", "-q");
      write("docs/reviews/old-2026-01-01.md", "# Review\n\nNo declaration, pre-mechanism.\n");
      write(
        "docs/reviews/new-2026-09-10.md",
        "# Review\n\n<!-- review-routing: backlog-bugs -->\n\nDeclared, so not debt.\n",
      );
      git("add", "-A");

      // The baseline already records `old` — the tree is in agreement with it.
      write(
        BASELINE_PATH,
        JSON.stringify({ note: "x", files: ["docs/reviews/old-2026-01-01.md"] }, null, 2) + "\n",
      );

      // A new undeclared record arrives. Writing the baseline now would ADD it.
      write("docs/reviews/added-2026-09-11.md", "# Review\n\nUndeclared and new.\n");
      git("add", "-A");

      const before = readFileSync(join(dir, BASELINE_PATH), "utf8");
      let code = 0;
      let out = "";
      try {
        out = execFileSyncHidden("node", [CHECKER, dir, "--update-baseline"], {
          cwd: dir,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string; stderr?: string };
        code = e.status ?? 1;
        out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      }
      expect(code, `expected refusal, got:\n${out}`).toBe(1);
      expect(out).toMatch(/would ADD 1 entry/);
      expect(out).toMatch(/added-2026-09-11\.md/);
      // The refusal is inert: the baseline on disk is untouched, so the next run
      // still reds the record rather than inheriting a silently widened list.
      expect(readFileSync(join(dir, BASELINE_PATH), "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the WRITER accepts a strict shrink, and a re-record of the same set", () => {
    expect(
      baselineAdditions({
        previous: ["docs/reviews/a-2026-01-01.md", "docs/reviews/b-2026-01-01.md"],
        next: ["docs/reviews/a-2026-01-01.md"],
      }),
    ).toEqual([]);
    expect(
      baselineAdditions({
        previous: ["docs/reviews/a-2026-01-01.md"],
        next: ["docs/reviews/a-2026-01-01.md"],
      }),
    ).toEqual([]);
    // An EMPTY previous baseline (the mechanism landing on a clean tree) is the
    // one case where every entry is an addition — and that is correct: there is
    // no debt to shrink, so a first write may only be empty.
    expect(baselineAdditions({ previous: [], next: ["docs/reviews/a-2026-01-01.md"] })).toEqual([
      "docs/reviews/a-2026-01-01.md",
    ]);
  });
});
