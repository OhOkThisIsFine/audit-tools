/**
 * The backlog size gate measures UTF-8 BYTES, not JS string length.
 *
 * This exists because the two silently disagreed. `check-backlog-budget.mjs`
 * counted `text.length` while every tool a maintainer would reach for (`wc -c`,
 * `ls -l`, an editor status bar) reports bytes — and on `open-bugs.md`, which is
 * full of `⚠` / `→` / `⇒` / em-dashes, the two differ by ~1000. Comparing a
 * `wc -c` figure against a recorded ceiling therefore read as a violation that
 * was not there, and a real growth could read as headroom.
 *
 * Bytes are also the better proxy for what is actually being budgeted — the token
 * cost of reading the file — and match the project's own `estimateTokensFromBytes`
 * convention. A regression to `.length` would silently under-price exactly the
 * decorated prose these entries accrete, so it is pinned here rather than trusted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");
const SCRIPT = join(REPO_ROOT, "scripts", "check-backlog-budget.mjs");

const { sizeOf, parseEntries, ENTRY_BUDGET_BYTES, FILE_BUDGET_BYTES } = await import(SCRIPT);

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
    const [entry] = parseEntries(body);
    expect(entry.bytes).toBe(sizeOf(body));
    expect(entry.bytes).toBeGreaterThan(body.length);
  });

  it("the recorded baseline is in bytes — it agrees with the real file size", () => {
    // The property that makes the gate trustworthy from the shell: what the
    // baseline says is what `wc -c` says. If someone reverts the metric to
    // `.length`, every over-budget file's recorded ceiling drifts below its true
    // size and this goes red.
    const baseline = JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8"));
    const fileKeys = Object.keys(baseline).filter((k) => k.endsWith("::__FILE__"));
    expect(fileKeys.length, "at least one file is over budget and thus baselined").toBeGreaterThan(0);
    for (const key of fileKeys) {
      const file = key.replace("::__FILE__", "");
      const text = readFileSync(join(BACKLOG_DIR, file), "utf8");
      expect(baseline[key], `${file} ceiling must be a BYTE count`).toBe(sizeOf(text));
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
