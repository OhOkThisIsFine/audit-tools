/**
 * backlog-line-numbers.test.ts — the guard that keeps line numbers out of backlog citations.
 *
 * The durable-traps rule is explicit: "Cite a SYMBOL, never a bare line number — and when
 * no good symbol exists, cite the file alone." Line numbers drift repo-wide while the
 * symbol names beside them still resolve (77 suffixes dropped 2026-07-28, two wrong ones
 * deleted 2026-08-18, two more found the same day), so the rule was written down and then
 * violated anyway — the standing lesson that a rule depending on the writer remembering it
 * decays. `scripts/check-backlog-line-numbers.mjs` is that rule, enforced.
 *
 * The hard part is NOT detecting `:<digits>` — it is separating a line-number CITATION
 * from the legitimate colon-digit forms this corpus actually contains (`127.0.0.1:3001`
 * lives in durable-traps today). Each positive below pins a citation form found in the
 * backlog; each negative pins a form that must never fire, because a gate that cries wolf
 * gets disabled and then nothing is guarded at all.
 */
import { describe, test, expect } from "vitest";
import { findLineNumberCitations } from "../../scripts/check-backlog-line-numbers.mjs";

const hits = (text: string): number => findLineNumberCitations(text).length;

describe("backlog line-number guard — citation forms FIRE", () => {
  test("a backticked repo path with a line suffix", () => {
    // The live open-bugs form: `src/audit/orchestrator/hostInputPause.ts:31`.
    expect(hits("- **Entry.** `src/audit/orchestrator/hostInputPause.ts:31` documents consent")).toBe(1);
  });
  test("a line RANGE suffix", () => {
    // The other live open-bugs form: `…runtimeCommand.ts:48-55`.
    expect(hits("- `src/audit/orchestrator/runtimeCommand.ts:48-55` buffers unboundedly")).toBe(1);
  });
  test("a line:col suffix", () => {
    expect(hits("- thrown from `scripts/audit/generate-schemas.mjs:21:7` under load")).toBe(1);
  });
  test("an extension-shaped citation with no slash still fires", () => {
    expect(hits("- see `nextStep.ts:210` for the branch")).toBe(1);
  });
  test("a bare backticked line number — the (defined `:21`) form", () => {
    // The exact pair 4cbce643 deleted from durable-traps.
    expect(hits("- the list lives in `scripts/audit/smoke-packaged-audit-code.mjs` (defined `:21`, asserted `:505`)")).toBe(2);
  });
  test("a multi-token span cannot hide a citation", () => {
    expect(hits("- compare `src/a/b.ts:12 and src/c/d.ts:15` side by side")).toBeGreaterThan(0);
  });
  test("a hit carries what the refusal message quotes", () => {
    const found = findLineNumberCitations("clean first line\n- `src/x/y.ts:9` broke\n");
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(2);
    expect(found[0].span).toBe("src/x/y.ts:9");
    expect(found[0].source).toContain("`src/x/y.ts:9` broke");
  });
});

describe("backlog line-number guard — legitimate colon-digits STAY QUIET", () => {
  test("host:port is not a citation", () => {
    // Verbatim in durable-traps today — the measured false-positive surface.
    expect(hits("- FreeLLMAPI on `127.0.0.1:3001` pools free tiers")).toBe(0);
  });
  test("a URL with a port is not a citation, slash and all", () => {
    expect(hits("- dashboard at `http://127.0.0.1:3001/stats` and `https://host.example:8443`")).toBe(0);
  });
  test("times, ratios and ISO timestamps", () => {
    expect(hits("- ran at `12:30`, ratio `4:1`, stamped `2026-08-18T20:07:28`")).toBe(0);
  });
  test("a plain identifier prefix does not qualify (the localhost:3001 class)", () => {
    expect(hits("- headroom serves `localhost:8787` only")).toBe(0);
  });
  test("a fenced block quoting OUTPUT is skipped whole", () => {
    expect(hits("- the trace:\n\n```\n  at run (src/audit/x.ts:123:7)\n```\n")).toBe(0);
  });
  test("a path citation with no suffix is the fix shape, not a violation", () => {
    expect(hits("- `runCommand` (`src/audit/orchestrator/runtimeCommand.ts`) buffers output")).toBe(0);
  });
  test("colon-digits outside any code span are not scanned", () => {
    // Scope is the backticked citation form; unbackticked prose stays a stated residual.
    expect(hits("- split at nextStep.ts:210 in prose")).toBe(0);
  });
});
