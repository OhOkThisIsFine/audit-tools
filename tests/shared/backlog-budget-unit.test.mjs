/**
 * Two properties of the backlog size gate are pinned here, because both were
 * regressions waiting to happen and neither is visible from reading the script.
 *
 * 1. IT MEASURES UTF-8 BYTES, NOT JS STRING LENGTH. The two silently disagreed:
 *    `check-backlog-budget.mjs` counted `text.length` while every tool a maintainer
 *    would reach for (`wc -c`, `ls -l`, an editor status bar) reports bytes — and on
 *    `open-bugs.md`, which is full of `⚠` / `→` / `⇒` / em-dashes, the two differ by
 *    ~1000. Comparing a `wc -c` figure against a recorded ceiling therefore read as a
 *    violation that was not there, and a real growth could read as headroom. Bytes are
 *    also the better proxy for what is actually budgeted — the token cost of reading
 *    the file — and match the project's own `estimateTokensFromBytes` convention.
 *
 * 2. THE RATCHET IS PER-FILE; THE PER-ENTRY NUMBER IS A PLAIN THRESHOLD. The gate used
 *    to record a shrink-only ceiling per ENTRY, and that ratchet twice refused a
 *    factually correct edit — once for 14 bytes, once for 15 bytes × 5 — with no way
 *    forward except re-recording a HIGHER ceiling. A gate that makes correcting a fact
 *    cost more than leaving it wrong is worse than no gate. The fix moved the ratchet to
 *    the file total and left entries amnestied BY NAME with no recorded size.
 *
 *    That fix has an obvious failure mode — dropping the per-entry snapshot could
 *    silently un-guard growth — so the two halves are asserted together below: a grown
 *    FILE is still refused, and an entry that grows while its file shrinks is accepted.
 *    The second case is the entire point of the change and would go red if the per-entry
 *    ratchet were ever reinstated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");
const SCRIPT = join(REPO_ROOT, "scripts", "check-backlog-budget.mjs");

const {
  sizeOf,
  parseEntries,
  entryKey,
  evaluateBacklog,
  normalizeBaseline,
  ENTRY_BUDGET_BYTES,
  FILE_BUDGET_BYTES,
} = await import(SCRIPT);

/** A synthetic top-level entry of an exact byte size (ASCII only, so bytes == chars). */
function entry(title, bytes) {
  const head = `- **${title}**`;
  const padding = bytes - sizeOf(head) - 3; // "\n  " joins the continuation line
  return `${head}\n  ${"x".repeat(padding)}`;
}

/** A file whose entries sum, with the joining blank lines, to a known total. */
function file(...entries) {
  return `${entries.join("\n\n")}\n`;
}

/** Enough filler entries to push a synthetic file past the per-FILE budget. */
function bulk(count, bytesEach) {
  return Array.from({ length: count }, (_, i) => entry(`Filler ${i}`, bytesEach));
}

describe("backlog budget measures bytes", () => {
  it("sizeOf counts UTF-8 bytes, so a multi-byte glyph costs more than one unit", () => {
    // The exact confusion: one CHARACTER, three BYTES.
    expect("⚠".length).toBe(1);
    expect(sizeOf("⚠")).toBe(3);
    expect(sizeOf("→")).toBe(3);
    // ASCII is unaffected, so the change only bites where it should.
    expect(sizeOf("plain ascii")).toBe("plain ascii".length);
  });

  it("an entry's recorded size exceeds its character count when it carries non-ASCII", () => {
    const body = "- **Entry ⚠ with arrows → and ⇒ plus an em-dash —**\n  continuation.";
    const [parsed] = parseEntries(body);
    expect(parsed.bytes).toBe(sizeOf(body));
    expect(parsed.bytes).toBeGreaterThan(body.length);
  });

  it("a recorded FILE ceiling is in bytes — it agrees with the real file size", () => {
    // The property that makes the gate trustworthy from the shell: what the baseline
    // says is what `wc -c` says. If someone reverts the metric to `.length`, every
    // over-budget file's recorded ceiling drifts below its true size and this goes red.
    const raw = JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8"));
    const ceilings = Object.entries(raw.file_ceilings ?? {});
    expect(ceilings.length, "at least one file is over budget and thus baselined").toBeGreaterThan(0);
    for (const [name, ceiling] of ceilings) {
      const text = readFileSync(join(BACKLOG_DIR, name), "utf8");
      expect(ceiling, `${name} ceiling must be a BYTE count`).toBe(sizeOf(text));
    }
  });

  it("budgets are declared in bytes and the whole backlog is measured by one function", () => {
    expect(ENTRY_BUDGET_BYTES).toBe(2600);
    expect(FILE_BUDGET_BYTES).toBe(120_000);
    // Every section file parses, and no entry is measured by string length.
    const files = readdirSync(BACKLOG_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const e of parseEntries(readFileSync(join(BACKLOG_DIR, f), "utf8"))) {
        expect(typeof e.bytes, `${f}:${e.line} must expose a byte size`).toBe("number");
        expect(e.bytes).toBeGreaterThan(0);
      }
    }
  });
});

describe("the ratchet is per-FILE; the per-entry budget is a plain threshold", () => {
  const BIG = ENTRY_BUDGET_BYTES + 400;

  it("the recorded baseline carries file SIZES but only entry NAMES", () => {
    // The shape IS the guarantee. A number beside an entry key is a per-entry ratchet,
    // and a per-entry ratchet is what taxed two correct edits.
    const raw = JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["entries_over_budget", "file_ceilings"]);
    for (const v of Object.values(raw.file_ceilings)) expect(typeof v).toBe("number");
    expect(Array.isArray(raw.entries_over_budget)).toBe(true);
    for (const k of raw.entries_over_budget) expect(typeof k).toBe("string");
  });

  it("an over-budget FILE that GREW is still refused — dropping the entry snapshot did not un-guard growth", () => {
    const before = file(...bulk(60, 2000));
    const after = file(...bulk(60, 2000), entry("One more", 2000));
    expect(sizeOf(before)).toBeGreaterThan(FILE_BUDGET_BYTES);
    expect(sizeOf(after)).toBeGreaterThan(sizeOf(before));

    const baseline = normalizeBaseline({ file_ceilings: { "big.md": sizeOf(before) }, entries_over_budget: [] });
    expect(evaluateBacklog([{ file: "big.md", text: before }], baseline).violations).toEqual([]);

    const grown = evaluateBacklog([{ file: "big.md", text: after }], baseline).violations;
    expect(grown).toHaveLength(1);
    expect(grown[0]).toContain("GREW");
  });

  it("an entry that GROWS while its file SHRINKS is accepted — the whole point of the change", () => {
    // Same grandfathered entry, 500 bytes bigger; a neighbour was condensed to pay for
    // it, so the file total fell. Under the per-entry ratchet this was a hard refusal.
    const key = entryKey("big.md", parseEntries(entry("Grandfathered", BIG))[0]);
    const baseline = normalizeBaseline({
      file_ceilings: { "big.md": FILE_BUDGET_BYTES + 10_000 },
      entries_over_budget: [key],
    });

    const after = file(entry("Grandfathered", BIG + 500), ...bulk(60, 2000));
    expect(sizeOf(after)).toBeGreaterThan(FILE_BUDGET_BYTES);
    expect(sizeOf(after)).toBeLessThan(baseline.fileCeilings["big.md"]);

    const result = evaluateBacklog([{ file: "big.md", text: after }], baseline);
    expect(result.violations).toEqual([]);
    expect(result.grandfathered).toBeGreaterThan(0);
  });

  it("a NEW entry over the budget is still refused outright — the threshold survived", () => {
    const baseline = normalizeBaseline({ file_ceilings: {}, entries_over_budget: [] });
    const result = evaluateBacklog(
      [{ file: "small.md", text: file(entry("Brand new sprawl", BIG)) }],
      baseline,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("NEW entry");
  });

  it("an amnestied entry that fell under budget is reported stale, so the list cannot ossify", () => {
    const baseline = normalizeBaseline({
      file_ceilings: {},
      entries_over_budget: ["small.md::Once sprawling"],
    });
    const result = evaluateBacklog(
      [{ file: "small.md", text: file(entry("Once sprawling", 500)) }],
      baseline,
    );
    expect(result.violations).toEqual([]);
    expect(result.staleAmnesty).toEqual(["small.md::Once sprawling"]);
    expect(result.nextBaseline.entries_over_budget).toEqual([]);
  });

  it("the live backlog passes the gate it ships with", () => {
    const files = readdirSync(BACKLOG_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ file: f, text: readFileSync(join(BACKLOG_DIR, f), "utf8") }));
    const baseline = normalizeBaseline(
      JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8")),
    );
    expect(evaluateBacklog(files, baseline).violations).toEqual([]);
  });
});
