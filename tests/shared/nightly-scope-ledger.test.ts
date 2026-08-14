// Leg 1's scope ledger (owner determination 285b804c0aef617d, 2026-08-12): the
// coverage stamp and diff window `docs/doc-review-guidelines.md` has specified
// since the routine was written and nothing implemented. The properties under
// test are the ones that make a stamp trustworthy — an unanchored stamp is
// refused, a never-examined item reports NO window rather than a fake one, a
// reword changes identity, and the coverage record carries the real counts
// including `aborted`. Lives under tests/ because vitest excludes `.claude/**`.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  coveragePath,
  diffWindow,
  docItems,
  headCommit,
  inScopeDocs,
  itemHash,
  normalizeItemText,
  readCoverage,
  readScopeLedger,
  splitDocItems,
  stampExamined,
  writeCoverage,
  writeScopeLedger,
} from "../../scripts/nightly/scope-ledger.mjs";

let root: string;

function git(...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scope-ledger-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "concept.md"), "# Concept\n\nOne claim.\n\nAnother claim.\n");
  writeFileSync(join(root, "src.ts"), "export const A = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("item identity", () => {
  it("treats a reflow as the same item and a reword as a new one", () => {
    expect(itemHash("a  claim\nthat wraps")).toBe(itemHash("a claim that wraps"));
    expect(itemHash("the gate fires")).not.toBe(itemHash("the gate does not fire"));
  });

  it("keeps case and punctuation — an item hash detects text change, unlike a subject key", () => {
    expect(normalizeItemText("  A\r\n B ")).toBe("A B");
    expect(itemHash("The Gate")).not.toBe(itemHash("the gate"));
  });

  it("holds a fenced code block together as one item", () => {
    const items = splitDocItems("Intro para.\n\n```bash\nnpm test\n\nnpm run build\n```\n\nTail.");
    expect(items).toHaveLength(3);
    expect(items[1]).toContain("npm test");
    expect(items[1]).toContain("npm run build");
  });

  it("splits a doc into blocks in file order", () => {
    const items = docItems(root, "docs/concept.md");
    expect(items.map((i) => i.text)).toEqual(["# Concept", "One claim.", "Another claim."]);
    expect(items.every((i) => i.path === "docs/concept.md")).toBe(true);
  });

  it("returns nothing for an absent doc rather than throwing", () => {
    expect(docItems(root, "docs/gone.md")).toEqual([]);
  });
});

describe("the ledger", () => {
  it("refuses an unanchored stamp — a stamp with no commit has no window", () => {
    expect(() => stampExamined({ items: {} }, ["abc"], { commit: "" })).toThrow(/commit is required/);
  });

  it("round-trips a stamp and reports the examining commit", () => {
    const head = headCommit(root);
    const [first] = docItems(root, "docs/concept.md");
    writeScopeLedger(root, stampExamined(readScopeLedger(root), [first.hash], { commit: head, path: "docs/concept.md" }));

    const reloaded = readScopeLedger(root);
    expect(reloaded.items[first.hash].lastCheckedCommit).toBe(head);
    expect(reloaded.items[first.hash].path).toBe("docs/concept.md");
    expect(reloaded.items[first.hash].lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reads an absent or malformed ledger as empty instead of throwing", () => {
    expect(readScopeLedger(root).items).toEqual({});
    mkdirSync(join(root, ".audit-tools", "nightly"), { recursive: true });
    writeFileSync(join(root, ".audit-tools", "nightly", "scope-ledger.json"), "{ not json");
    expect(readScopeLedger(root).items).toEqual({});
  });
});

describe("the diff window", () => {
  it("reports no window for a never-examined item rather than inventing one", () => {
    const window = diffWindow(root, itemHash("never seen"), readScopeLedger(root));
    expect(window).toEqual({ since: null, files: null, reason: "never-examined" });
  });

  it("names only the files that changed since the item was examined", () => {
    const at = headCommit(root);
    const [first] = docItems(root, "docs/concept.md");
    const ledger = stampExamined(readScopeLedger(root), [first.hash], { commit: at });

    writeFileSync(join(root, "src.ts"), "export const A = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "change");

    const window = diffWindow(root, first.hash, ledger);
    expect(window.reason).toBe("window");
    expect(window.since).toBe(at);
    expect(window.files).toEqual(["src.ts"]);
  });

  it("abstains rather than trusting a stale window when the commit is unresolvable", () => {
    const ledger = stampExamined(readScopeLedger(root), ["h"], { commit: "0".repeat(40) });
    const window = diffWindow(root, "h", ledger);
    expect(window.reason).toBe("unresolvable-commit");
    expect(window.files).toBeNull();
  });
});

describe("the coverage stamp", () => {
  it("persists the real counts, and carries `aborted` so a partial run cannot read as complete", () => {
    writeCoverage(root, "2026-08-14", {
      head: "abc1234",
      docs_in_scope: 53,
      docs_examined: 12,
      items_in_scope: 1856,
      items_examined: 400,
      aborted: "lane died at doc 12",
    });
    const record = readCoverage(root, "2026-08-14");
    expect(record).toMatchObject({
      run: "2026-08-14",
      docs_in_scope: 53,
      docs_examined: 12,
      aborted: "lane died at doc 12",
    });
    expect(readFileSync(coveragePath(root, "2026-08-14"), "utf8")).toContain('"aborted"');
  });

  it("defaults `aborted` to null and the counts to zero — an unwritten field never reads as coverage", () => {
    const record = writeCoverage(root, "2026-08-14", {});
    expect(record.aborted).toBeNull();
    expect(record.docs_examined).toBe(0);
    expect(record.items_examined).toBe(0);
  });

  it("reads a missing stamp as null — absent coverage is not zero coverage", () => {
    expect(readCoverage(root, "1999-01-01")).toBeNull();
  });
});

describe("the in-scope corpus", () => {
  it("resolves through the doc manifest, dropping the excluded row", () => {
    const manifest = [
      { type: "design / concept", files: ["docs/concept.md"], check: "c", autoApply: "yes" },
      { type: "excluded", files: ["docs/reviews/**/*.md"], check: "—", autoApply: "—" },
    ];
    mkdirSync(join(root, "docs", "reviews"), { recursive: true });
    writeFileSync(join(root, "docs", "reviews", "rec.md"), "# Record\n");
    writeFileSync(join(root, "docs", "unrouted.md"), "# Unrouted\n");
    git("add", "-A");
    git("commit", "-qm", "docs");

    const scoped = inScopeDocs(root, { manifest });
    expect(scoped.map((d) => d.path)).toEqual(["docs/concept.md"]);
  });

  it("reads tracked files only — an untracked doc is not silently reviewed", () => {
    const manifest = [{ type: "design / concept", files: ["docs/**/*.md"], check: "c", autoApply: "yes" }];
    writeFileSync(join(root, "docs", "scratch.md"), "# Scratch\n");
    expect(inScopeDocs(root, { manifest }).map((d) => d.path)).toEqual(["docs/concept.md"]);
  });
});
