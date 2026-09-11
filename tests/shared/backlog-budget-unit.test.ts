/**
 * Three properties of the backlog size gate are pinned here, because each was a
 * regression waiting to happen and none is visible from reading the script.
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
 *
 * 3. `--update-baseline` CANNOT RAISE A CEILING. The enforce run refuses a file that grew
 *    past its recorded ceiling — and `--update-baseline` used to re-record whatever the
 *    file currently measured, so that one refusal was a single flag away from being
 *    erased by the same command whose legitimate job (locking in a shrink) reads
 *    identically. The only thing standing between them was a prose caution in HANDOFF,
 *    which is host discretion, not a guarantee. Both directions are driven below, at the
 *    pure-function level AND end-to-end through the CLI, because the defect lived in the
 *    argv wiring as much as in the computation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSyncHidden, execFileSyncHidden } from "../helpers/spawn.mjs";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const BACKLOG_DIR = join(REPO_ROOT, "docs", "backlog");
const SCRIPT = join(REPO_ROOT, "scripts", "check-backlog-budget.mjs");
const ENTRY_GRAMMAR = join(REPO_ROOT, "scripts", "shared", "backlog-entry-grammar.mjs");
const PRIMITIVES = join(REPO_ROOT, "scripts", "shared", "primitives.mjs"); // the script imports it since the primitives were single-sourced

const {
  sizeOf,
  parseEntries,
  entryKey,
  entryParagraphs,
  evaluateBacklog,
  normalizeBaseline,
  planBaselineUpdate,
  prescribedFixShapes,
  ENTRY_BUDGET_BYTES,
  FILE_BUDGET_BYTES,
} = await import(SCRIPT);

/** A synthetic top-level entry of an exact byte size (ASCII only, so bytes == chars). */
function entry(title: string, bytes: number) {
  const head = `- **${title}**`;
  const padding = bytes - sizeOf(head) - 3; // "\n  " joins the continuation line
  return `${head}\n  ${"x".repeat(padding)}`;
}

/** A file whose entries sum, with the joining blank lines, to a known total. */
function file(...entries: string[]) {
  return `${entries.join("\n\n")}\n`;
}

/** Enough filler entries to push a synthetic file past the per-FILE budget. */
function bulk(count: number, bytesEach: number) {
  return Array.from({ length: count }, (_, i) => entry(`Filler ${i}`, bytesEach));
}

/**
 * The backlog as HEAD holds it — the corpus the live assertions judge.
 *
 * WHY HEAD AND NOT THE WORKTREE. The budget baseline is a ratchet that is RECORDED at
 * commit, and a lap routinely shrinks the backlog mid-flight. Judging the worktree
 * meant that recording a shrink and then deleting more entries turned this file RED in
 * a way that read as a code regression — it cost a full-suite investigation once
 * (2026-07-24). The committed pair (baseline, corpus) is the only pair that was ever
 * meant to agree: mid-edit the two are legitimately out of step, and the gate itself
 * refuses the stale half at commit. Nothing here is skipped when HEAD is unreadable —
 * a repo with no commits falls back to the worktree, so the assertion is never
 * silently vacuous.
 *
 * THE PAIR MOVES TOGETHER, never one half alone. When HEAD's baseline predates a
 * declared amnesty key (see `baselineIsCommitted`), HEAD's corpus predates that
 * leg's prescriptions too — so both halves fall back to the worktree and the
 * assertions still judge a baseline and a corpus that were recorded together.
 */
let committedCache: { file: string; text: string }[] | null = null;
function committedBacklog(): { file: string; text: string }[] {
  if (committedCache) return committedCache;
  let files: string[];
  try {
    if (!baselineIsCommitted()) throw new Error("HEAD predates a declared baseline key");
    files = execFileSyncHidden("git", ["ls-tree", "--name-only", "HEAD", "docs/backlog/"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".md"))
      .map((line) => line.slice(line.lastIndexOf("/") + 1))
      .sort();
  } catch {
    files = [];
  }
  committedCache =
    files.length > 0
      ? files.map((file) => ({
          file,
          text: execFileSyncHidden("git", ["show", `HEAD:docs/backlog/${file}`], {
            cwd: REPO_ROOT,
            encoding: "utf8",
          }),
        }))
      : readdirSync(BACKLOG_DIR)
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((file) => ({ file, text: readFileSync(join(BACKLOG_DIR, file), "utf8") }));
  return committedCache;
}

/**
 * A recorded baseline file's key set is only comparable to a corpus that was
 * recorded BESIDE it, and introducing a new amnesty list — as the
 * states-the-property leg did — makes HEAD's pair stale for exactly one lap:
 * HEAD's baseline predates the key while the worktree's corpus already carries
 * the prescriptions it amnesties, so the committed pair disagrees and the gate
 * refuses until both are committed together.
 *
 * That is the same mid-lap drift `committedBacklog` doc explains, one key over.
 * The rule: read HEAD's pair, and fall back to the WORKTREE pair when HEAD's
 * baseline is missing a key the code declares — which can only mean HEAD
 * predates that leg. This is not a loosening: once the pair is committed it is
 * read from HEAD verbatim, and a baseline that is merely WRONG (rather than
 * pre-dating a leg) is still judged as HEAD holds it.
 */
const WORKTREE_BASELINE_KEYS = () =>
  Object.keys(JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8"))).sort();

/**
 * HEAD's copy of the recorded baseline when it carries every declared key, else
 * the worktree's (see WORKTREE_BASELINE_KEYS). Deliberately `any`: the assertion
 * below is about the file's KEY SET, so typing the shape here would let the test
 * agree with a declaration instead of with the file.
 */
function committedBaseline(): any {
  const worktree = () => JSON.parse(readFileSync(join(BACKLOG_DIR, ".size-baseline.json"), "utf8"));
  let head: any;
  try {
    head = JSON.parse(
      execFileSyncHidden("git", ["show", "HEAD:docs/backlog/.size-baseline.json"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    );
  } catch {
    return worktree();
  }
  const declared = WORKTREE_BASELINE_KEYS();
  const missing = declared.filter((key) => !(key in head));
  return missing.length > 0 ? worktree() : head;
}

/**
 * Whether the baseline judged above came from HEAD (false = the worktree
 * fallback). `committedBacklog` must follow the SAME choice, or the test would
 * judge a HEAD corpus against a worktree baseline — a pair that never existed
 * anywhere, which is worse than either consistent choice.
 */
function baselineIsCommitted(): boolean {
  try {
    const head = JSON.parse(
      execFileSyncHidden("git", ["show", "HEAD:docs/backlog/.size-baseline.json"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }),
    );
    return WORKTREE_BASELINE_KEYS().every((key) => key in head);
  } catch {
    return false;
  }
}

/**
 * What a recorded file ceiling promises: it is a BYTE count that caps the file.
 *
 * Measured against `Buffer.byteLength`, never against the script's own `sizeOf` — `sizeOf`
 * is the function under suspicion here, so comparing a ceiling to it is self-referential
 * and a revert to `.length` would agree with itself and pass.
 */
function ceilingIsInBytes(ceiling: number, text: string) {
  return ceiling >= Buffer.byteLength(text, "utf8");
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

  it("a recorded FILE ceiling is in bytes — it caps the real file size", () => {
    // The property that makes the gate trustworthy from the shell: what the baseline
    // says is what `wc -c` says, in the same unit.
    //
    // It is a CEILING, not a snapshot. The gate lets an over-budget file shrink beneath
    // its recorded number without re-recording (that is the whole ratchet), so closing an
    // entry legitimately puts the ceiling ABOVE the file. Pinning equality here made that
    // ordinary event read as a code regression — twice, each time costing a full-suite
    // investigation. The direction is what the gate actually promises, and it is still the
    // direction the metric revert breaks: a baseline re-recorded under `.length` lands
    // BELOW the file's true byte size. Proven both ways in the next test.
    const raw: { file_ceilings?: Record<string, number>; entries_over_budget?: string[] } = committedBaseline();
    //
    // NOT "at least one ceiling exists". That was a MEASUREMENT of the corpus on the day
    // this was written — open-bugs.md was over the file budget then — and it went red the
    // moment the backlog came back under budget on its own and `--update-baseline`
    // recorded no ceiling at all. An empty `file_ceilings` is the gate WORKING: nothing is
    // over budget, so there is nothing to ratchet, and the ratchet re-arms by itself if a
    // file goes over again. Requiring a ceiling to exist made shrinking the backlog fail
    // the suite. The metric property stays covered non-vacuously by the synthetic-content
    // test below, which is exactly why that one was written against synthetic content.
    const ceilings = Object.entries(raw.file_ceilings ?? {});
    const committed = new Map(committedBacklog().map((f) => [f.file, f.text]));
    for (const [name, ceiling] of ceilings) {
      const text = committed.get(name) ?? "";
      const bytes = Buffer.byteLength(text, "utf8");
      expect(
        ceilingIsInBytes(ceiling, text),
        `${name} ceiling ${ceiling} must be a BYTE count capping the file's ${bytes} bytes`,
      ).toBe(true);
    }
  });

  it("a ceiling re-recorded under a reverted (character-count) metric is still refused", () => {
    // Why the direction above is not a loosening. On decorated prose — which every backlog
    // file is, being full of ⚠ / → / ⇒ / — — a character count lands strictly below the
    // byte count, so it fails the cap it was supposed to be. Synthetic content, so this
    // stays true no matter how the live backlog is edited.
    const decorated = `- **Entry ⚠ with arrows → and ⇒ plus an em-dash —**\n  ${"body ".repeat(100)}\n`;
    expect(decorated.length, "the two metrics must disagree, or this proves nothing").toBeLessThan(
      sizeOf(decorated),
    );

    expect(ceilingIsInBytes(sizeOf(decorated), decorated), "a byte ceiling holds").toBe(true);
    expect(ceilingIsInBytes(decorated.length, decorated), "a char ceiling is refused").toBe(false);

    // And a legitimate shrink — the case that kept going false-red — is accepted.
    const shrunk = decorated.replace(`  ${"body ".repeat(100)}`, `  ${"body ".repeat(60)}`);
    expect(sizeOf(shrunk)).toBeLessThan(sizeOf(decorated));
    expect(ceilingIsInBytes(sizeOf(decorated), shrunk), "a shrink under its ceiling holds").toBe(true);
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
    // and a per-entry ratchet is what taxed two correct edits. The second amnesty
    // list obeys the same shape for the same reason: it names entries, never sizes.
    const raw = committedBaseline();
    expect(Object.keys(raw).sort()).toEqual([
      "entries_over_budget",
      "entries_prescribing_mechanism",
      "file_ceilings",
    ]);
    for (const v of Object.values(raw.file_ceilings)) expect(typeof v).toBe("number");
    expect(Array.isArray(raw.entries_over_budget)).toBe(true);
    for (const k of raw.entries_over_budget) expect(typeof k).toBe("string");
    expect(Array.isArray(raw.entries_prescribing_mechanism)).toBe(true);
    for (const k of raw.entries_prescribing_mechanism) expect(typeof k).toBe("string");
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

  it("a refusal names what to cut, so satisfying it is one pass rather than a rerun loop", () => {
    // The defect: the gate printed a total and a ceiling, so the remedy was a blind
    // trim followed by a whole-file re-scan — seven full re-runs in one lap, the last
    // three moving 11, 2 and 1 bytes. It already holds the entry's own text.
    const paragraphs = ["a".repeat(1800), "b".repeat(900), "c".repeat(300)];
    const body = `- **Sprawling (2026-09-10, low).**\n  ${"lead in ".repeat(4)}\n\n  ${paragraphs[0]}\n\n  ${paragraphs[1]}\n\n  ${paragraphs[2]}`;
    const [parsed] = parseEntries(body);
    expect(parsed.bytes).toBeGreaterThan(ENTRY_BUDGET_BYTES);

    const result = evaluateBacklog([{ file: "small.md", text: `${body}\n` }], normalizeBaseline(null));
    const violation = result.violations.find((v: string) => v.includes("NEW entry"));
    expect(violation, result.violations.join("\n")).toBeTruthy();
    // The overage is stated as a number, not left to be derived from two others.
    expect(violation).toContain(`${parsed.bytes - ENTRY_BUDGET_BYTES} over`);
    // …and the entry's own paragraphs are named, largest first.
    expect(violation).toContain("Largest paragraphs in this entry");
    type Paragraph = { bytes: number; lead: string };
    const ranked: Paragraph[] = entryParagraphs(body);
    expect(ranked.map((p: Paragraph) => p.bytes)).toEqual(
      [...ranked.map((p: Paragraph) => p.bytes)].sort((a, z) => z - a),
    );
    for (const paragraph of ranked.slice(0, 3)) {
      expect(violation).toContain(`${paragraph.bytes} bytes`);
    }
  });

  it("a refusal states how far the file has moved since HEAD, and drops the line when there is no HEAD", () => {
    // "since HEAD", never "this edit": a worktree may hold several uncommitted edits,
    // so the number is the file's real drift. A previous copy that cannot be read
    // (a brand-new file, a fixture repo with no commits) yields no line at all — a
    // refusal is never invented out of an unreadable previous copy.
    const text = file(entry("Brand new sprawl", BIG));
    const baseline = normalizeBaseline(null);
    const withHead = evaluateBacklog(
      [{ file: "small.md", text, previousText: file(entry("Brand new sprawl", BIG - 400)) }],
      baseline,
    );
    expect(withHead.violations[0]).toContain("bytes since HEAD (");
    expect(withHead.violations[0]).toContain("+400 bytes");

    const withoutHead = evaluateBacklog([{ file: "small.md", text }], baseline);
    expect(withoutHead.violations[0]).not.toContain("since HEAD");
  });

  it("the live backlog passes the gate it ships with", () => {
    // COMMITTED content, both halves — see `committedBacklog` for why mid-lap drift
    // between the recorded baseline and the worktree is not a regression.
    //
    // ⚠ This one DOES read HEAD, so a lap that introduces a new refusal (as the
    // states-the-property leg below did) is red here until the baseline and the
    // corpus are committed TOGETHER — which is the whole point of judging the
    // committed pair: the remedy is `--update-baseline` + commit, not an edit to
    // this assertion. Measured red at the moment the leg landed, green after.
    const baseline = normalizeBaseline(committedBaseline());
    const committed = committedBacklog();
    expect(evaluateBacklog(committed, baseline).violations).toEqual([]);
    // …and the committed baseline amnesties exactly the committed corpus's
    // prescriptions, so the two halves cannot drift into a disagreement where
    // the gate is green only because the amnesty is stale.
    const flaggedCommitted = committed
      .flatMap(({ file, text }) =>
        parseEntries(text).map((e: ReturnType<typeof parseEntries>[number]) => ({ file, e })),
      )
      .filter(({ e }) => e.prescribedFix.length > 0 && !e.statesProperty)
      .map(({ file, e }) => entryKey(file, e))
      .sort();
    expect(flaggedCommitted).toEqual([...baseline.entriesPrescribingMechanism].sort());
  });
});

describe("an entry states the property, not the mechanism — the mechanical half", () => {
  /**
   * The second-backlog-clearance lap (2026-07-24). A backlog entry can name a fix
   * whose PREMISE is sound and whose CONSEQUENCE is unshippable: the per-node
   * token estimate entry described its defect correctly and the fix it prescribed
   * would have regressed the run. An entry should state the PROPERTY, because the
   * mechanism is the part that does not survive contact with the tree.
   *
   * WHAT IS ENFORCED, and why it is this narrow. "Is this a property" is a
   * reading. What is checkable is the MARKER: an entry that prescribes a fix must
   * also carry `**Property:**` — a form 96 entries already write unprompted. The
   * rule is deliberately one-directional: half the corpus is measurements,
   * residual lists and live-run watches that prescribe nothing, and requiring the
   * marker there would red 100+ entries for a rule they cannot satisfy.
   *
   * THE SEMANTIC HALF IS UNCOVERED and stated in the gate header: the marker's
   * PRESENCE is checked, never whether the sentence after it states a property
   * rather than a mechanism in different words.
   */
  /** An entry with a prescribed fix plus the property marker that answers for it. */
  const withProp = (property: string) =>
    file(`- **An entry.** The fix is to move the list into one module.\n\n  **Property:** ${property}`);

  it("flags an entry that prescribes a fix without stating its property", () => {
    // The same prescription, the marker present vs. absent — the pair is the
    // assertion, so a rule that stopped reading either half would fail here.
    const flagged = evaluateBacklog(
      [{ file: "small.md", text: file("- **An entry.** The fix is to move the list into one module.") }],
      normalizeBaseline(null),
    );
    expect(flagged.violations).toHaveLength(1);
    expect(flagged.violations[0]).toContain("prescribes a fix mechanism");
    expect(flagged.violations[0]).toContain("without stating its PROPERTY");
    // The refusal tells the writer what to add, not merely what is wrong.
    expect(flagged.violations[0]).toContain("**Property:**");

    const clean = evaluateBacklog(
      [{ file: "small.md", text: withProp("The list lives in ONE place, reachable in one read.") }],
      normalizeBaseline(null),
    );
    expect(clean.violations).toEqual([]);
  });

  it("names WHICH prescription shape fired, so the refusal is actionable", () => {
    expect(prescribedFixShapes("- **E.** The fix: route it through resolveExecArgv.")).toEqual([
      "the-fix-is",
    ]);
    expect(prescribedFixShapes("- **E.** Anchor a deletion on the next bullet instead of a count.")).toEqual([
      "anchor-the-deletion",
    ]);
    expect(prescribedFixShapes("- **E.** The scaffold should state which MODE it serves.")).toEqual([
      "should-do",
    ]);
  });

  it("stays QUIET on the prose shapes that only look like prescriptions", () => {
    // The false-positive surface, measured against sentences this corpus uses.
    // A gate that cries wolf on its own entries gets deleted, and then nothing
    // is guarded — so each of these must be silent.
    expect(prescribedFixShapes("- **E.** The tree should change under every edit.")).toEqual([]);
    expect(prescribedFixShapes("- **E.** Anything that should happen will happen.")).toEqual([]);
    expect(prescribedFixShapes("- **E.** A prefix, not a fix, is what this needs.")).toEqual([]);
    expect(prescribedFixShapes("- **E.** The fixer ran twice.")).toEqual([]);
  });

  it("the Property marker's own prose cannot supply the match it is meant to answer", () => {
    // The marker is the ANSWER to this question, so everything from it onward is
    // stripped before the scan — otherwise an entry whose PROPERTY sentence reads
    // "the fix is …" would satisfy the rule with the very sentence the rule is
    // asking it to write, and the marker's presence would prove nothing.
    const body =
      "- **An entry.** A measurement, prescribing nothing at all.\n\n  **Property:** the fix is in the tree.";
    expect(prescribedFixShapes(body), "the body prescribes nothing").toEqual([]);
    // The same marker text placed BEFORE the marker would match — which is what
    // makes the strip the load-bearing half rather than a tidy-up.
    expect(prescribedFixShapes("- **An entry.** The fix is in the tree.")).toEqual(["the-fix-is"]);
  });

  it("grandfathers a pre-existing prescription BY NAME, and drops it once satisfied", () => {
    // ONE entry, edited in place — the amnesty key is its TITLE, so gaining the
    // marker must be what drops the key, not a rename.
    const amended = (body: string) =>
      file(`- **An old prescription.** ${body}`);
    const key = entryKey("small.md", parseEntries(amended("The fix is to inline the constant."))[0]);

    // Amnestied by name: no violation, and the key stays live in the next baseline.
    const kept = evaluateBacklog(
      [{ file: "small.md", text: amended("The fix is to inline the constant.") }],
      normalizeBaseline({ file_ceilings: {}, entries_over_budget: [], entries_prescribing_mechanism: [key] }),
    );
    expect(kept.violations).toEqual([]);
    expect(kept.nextBaseline.entries_prescribing_mechanism).toEqual([key]);

    // The SAME entry gains its Property: the key is no longer recorded, and the
    // amnesty is reported stale so `--update-baseline` drops it in one pass.
    const satisfied = amended(
      "The fix is to inline the constant.\n\n  **Property:** one constant, one home, one read.",
    );
    const dropped = evaluateBacklog(
      [{ file: "small.md", text: satisfied }],
      normalizeBaseline({ file_ceilings: {}, entries_over_budget: [], entries_prescribing_mechanism: [key] }),
    );
    expect(dropped.violations).toEqual([]);
    expect(dropped.nextBaseline.entries_prescribing_mechanism).toEqual([]);
    expect(dropped.staleMechanismAmnesty).toEqual([key]);
  });

  it("a mechanism amnesty for an entry that no longer exists is dead data, and is refused", () => {
    // Same defect class as the byte amnesty: a key that can never match widens
    // the gate invisibly rather than reddening it.
    const result = evaluateBacklog(
      [{ file: "small.md", text: file(entry("Live one", 500)) }],
      normalizeBaseline({
        file_ceilings: {},
        entries_over_budget: [],
        entries_prescribing_mechanism: ["small.md::Deleted with the retired substrate"],
      }),
    );
    expect(result.vanishedMechanismAmnesty).toEqual(["small.md::Deleted with the retired substrate"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("Deleted with the retired substrate");
    expect(result.violations[0]).toContain("no entry with that title exists");
  });

  it("the gate holds the rule at BOTH ends — the marker is required, not inferred", () => {
    // Reverting the rule to "emit the marker's presence as data but never
    // refuse" would leave this green; asserting the REFUSAL is what pins it.
    const text = file("- **An entry.** Switch to the shared lock instead of a second store.");
    const result = evaluateBacklog([{ file: "small.md", text }], normalizeBaseline(null));
    expect(result.violations).toHaveLength(1);
  });
});

describe("the baseline cannot hold a claim that stopped being true", () => {
  /**
   * The defect this closes (2026-08-27): the recorded baseline grandfathers an entry
   * the backlog no longer holds and caps a file at a size it long ago fell under. A
   * stale amnesty never matches, and a stale ceiling caps nothing — both are dead data
   * that silently widens the gate (the ceiling permits that much growth before the
   * budget can fire). Neither is visible by reading the file: it takes comparing the
   * baseline against the corpus it claims to describe.
   */

  it("an amnesty naming an entry that no longer exists is RED, not a silent no-op", () => {
    // The live entry is over the budget, so its amnesty is doing real work and must
    // survive the pass untouched — only the dead key is refused.
    const files = [{ file: "small.md", text: file(entry("Still here", ENTRY_BUDGET_BYTES + 400)) }];
    const baseline = normalizeBaseline({
      file_ceilings: {},
      entries_over_budget: ["small.md::Still here", "small.md::Deleted with the retired substrate"],
    });

    const result = evaluateBacklog(files, baseline);
    expect(result.vanishedAmnesty).toEqual(["small.md::Deleted with the retired substrate"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("Deleted with the retired substrate");
    expect(result.violations[0]).toContain("no entry with that title exists");
    // The live key is untouched — a real amnesty is not collateral.
    expect(result.nextBaseline.entries_over_budget).toEqual(["small.md::Still here"]);
  });

  it("an amnesty for a RENAMED entry is caught too — the title is the identity, not the line", () => {
    const files = [{ file: "small.md", text: file(entry("Renamed since", 500)) }];
    const baseline = normalizeBaseline({
      file_ceilings: {},
      entries_over_budget: ["small.md::Its former title"],
    });
    expect(evaluateBacklog(files, baseline).vanishedAmnesty).toEqual(["small.md::Its former title"]);
  });

  it("an amnesty naming a file that is gone is caught as well", () => {
    const files = [{ file: "small.md", text: file(entry("Still here", 500)) }];
    const baseline = normalizeBaseline({
      file_ceilings: {},
      entries_over_budget: ["deleted-section.md::Anything"],
    });
    expect(evaluateBacklog(files, baseline).vanishedAmnesty).toEqual(["deleted-section.md::Anything"]);
  });

  it("a recorded ceiling for a file that fell back UNDER the budget is RED — it caps nothing", () => {
    // The second half of the same entry: `open-bugs.md` was capped at 129,162 bytes
    // against a file well under 90,000, i.e. ~48% of permitted growth.
    const small = file(...bulk(10, 500));
    expect(sizeOf(small)).toBeLessThan(FILE_BUDGET_BYTES);

    const baseline = normalizeBaseline({ file_ceilings: { "small.md": FILE_BUDGET_BYTES }, entries_over_budget: [] });
    const result = evaluateBacklog([{ file: "small.md", text: small }], baseline);
    expect(result.staleCeilings).toEqual(["small.md"]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("caps small.md at");
    expect(result.violations[0]).toContain("only bounds a file that is OVER the budget");
    // …and the ratchet re-arms live the moment the file goes back over.
    expect(result.nextBaseline.file_ceilings).toEqual({});
  });

  it("a ceiling for a file that is STILL over budget is the ratchet working, never a refusal", () => {
    const big = file(...bulk(60, 2000));
    expect(sizeOf(big)).toBeGreaterThan(FILE_BUDGET_BYTES);
    const baseline = normalizeBaseline({ file_ceilings: { "big.md": sizeOf(big) }, entries_over_budget: [] });
    const result = evaluateBacklog([{ file: "big.md", text: big }], baseline);
    expect(result.staleCeilings).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.nextBaseline.file_ceilings).toEqual({ "big.md": sizeOf(big) });
  });

  it("--update-baseline drops BOTH dead key kinds, so the remedy clears them in one pass", () => {
    const raw = committedBaseline();
    expect(Object.keys(raw).sort()).toEqual([
      "entries_over_budget",
      "entries_prescribing_mechanism",
      "file_ceilings",
    ]);
    const baseline = normalizeBaseline({
      file_ceilings: { "ghost.md": 200_000 },
      entries_over_budget: ["ghost.md::Long deleted"],
      entries_prescribing_mechanism: ["ghost.md::Also long deleted"],
    });
    const result = evaluateBacklog([{ file: "small.md", text: file(entry("Live one", 500)) }], baseline);
    const plan = planBaselineUpdate(result.nextBaseline, baseline, { raiseCeiling: false });
    expect(plan.baseline.file_ceilings).toEqual({});
    expect(plan.baseline.entries_over_budget).toEqual([]);
    expect(plan.baseline.entries_prescribing_mechanism).toEqual([]);
    // The remedy is one command with no extra intent flag: nothing here is a raise.
    expect(plan.refused).toEqual([]);
  });

  it("the live baseline carries no dead claim — the gate it ships with is green on its own data", () => {
    const result = evaluateBacklog(committedBacklog(), normalizeBaseline(committedBaseline()));
    expect(result.vanishedAmnesty).toEqual([]);
    expect(result.staleCeilings).toEqual([]);
  });
});

describe("--update-baseline may lower a ceiling, never raise one", () => {
  /** An over-budget synthetic file, plus a recorded ceiling `delta` bytes away from it. */
  function overBudget(delta: number) {
    const text = file(...bulk(60, 2000));
    expect(sizeOf(text)).toBeGreaterThan(FILE_BUDGET_BYTES);
    return { text, measured: sizeOf(text), recorded: sizeOf(text) + delta };
  }

  function plan(text: string, fileCeilings: Record<string, number>, raiseCeiling: boolean | string) {
    const baseline = normalizeBaseline({ file_ceilings: fileCeilings, entries_over_budget: [] });
    const result = evaluateBacklog([{ file: "big.md", text }], baseline);
    return planBaselineUpdate(result.nextBaseline, baseline, { raiseCeiling });
  }

  it("keeps the recorded ceiling when the file GREW, and says what it refused", () => {
    const { text, measured, recorded } = overBudget(-500);
    const { baseline, refused, raised } = plan(text, { "big.md": recorded }, false);

    expect(baseline.file_ceilings["big.md"], "the grown size must not reach disk").toBe(recorded);
    expect(refused).toEqual([{ file: "big.md", recorded, measured }]);
    expect(raised).toEqual([]);
  });

  it("re-records a SHRINK with no flag at all — the legitimate half is untouched", () => {
    const { text, measured, recorded } = overBudget(+500);
    const { baseline, refused } = plan(text, { "big.md": recorded }, false);

    expect(baseline.file_ceilings["big.md"]).toBe(measured);
    expect(refused).toEqual([]);
  });

  it("records a first ceiling for a file that has none — there is nothing to raise yet", () => {
    const { text, measured } = overBudget(0);
    const { baseline, refused } = plan(text, {}, false);

    expect(baseline.file_ceilings["big.md"]).toBe(measured);
    expect(refused).toEqual([]);
  });

  it("--raise-ceiling writes the grown size and names it, so the raise is on the record", () => {
    const { text, measured, recorded } = overBudget(-500);
    const { baseline, refused, raised } = plan(text, { "big.md": recorded }, true);

    expect(baseline.file_ceilings["big.md"]).toBe(measured);
    expect(refused).toEqual([]);
    expect(raised).toEqual([{ file: "big.md", recorded, measured }]);
  });

  it("refuses a non-boolean intent rather than treating a truthy string as consent", () => {
    // `"false"` is truthy. A caller that forwards an unparsed argv value would otherwise
    // wave every raise through, silently, in the direction that loses data.
    const { text, recorded } = overBudget(-500);
    expect(() => plan(text, { "big.md": recorded }, "false")).toThrow(/boolean/);
  });

  describe("end-to-end through the CLI, where the defect actually lived", () => {
    // A throwaway repo skeleton: the script resolves its backlog dir from its OWN
    // location, so a copy under <tmp>/scripts reads <tmp>/docs/backlog and cannot
    // touch the real baseline. Driving argv is the point — the pure planner can be
    // correct while `main()` never calls it.
    let dir: string;
    let script: string;
    let baselineFile: string;
    let measured: number;
    let recorded: number;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "backlog-budget-"));
      mkdirSync(join(dir, "scripts", "shared"), { recursive: true });
      mkdirSync(join(dir, "docs", "backlog"), { recursive: true });
      script = join(dir, "scripts", "check-backlog-budget.mjs");
      baselineFile = join(dir, "docs", "backlog", ".size-baseline.json");
      copyFileSync(SCRIPT, script);
      // The script imports the shared entry grammar; the skeleton has to carry it
      // too, or the copy dies at import time instead of exercising the CLI.
      copyFileSync(ENTRY_GRAMMAR, join(dir, "scripts", "shared", "backlog-entry-grammar.mjs"));
      copyFileSync(PRIMITIVES, join(dir, "scripts", "shared", "primitives.mjs"));

      const text = file(...bulk(60, 2000));
      measured = sizeOf(text);
      recorded = measured - 500;
      writeFileSync(join(dir, "docs", "backlog", "big.md"), text, "utf8");
      writeFileSync(
        baselineFile,
        JSON.stringify({ file_ceilings: { "big.md": recorded }, entries_over_budget: [] }, null, 2) + "\n",
        "utf8",
      );
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const run = (...args: string[]) =>
      spawnSyncHidden(process.execPath, [script, ...args], { encoding: "utf8" });

    const ceilingOnDisk = () => JSON.parse(readFileSync(baselineFile, "utf8")).file_ceilings["big.md"];

    it("refuses the raise, leaves the recorded ceiling on disk, and exits non-zero", () => {
      const r = run("--update-baseline");
      expect(r.status, "a refused update must not read as success").toBe(1);
      expect(r.stderr).toContain("REFUSED");
      expect(r.stderr).toContain("--raise-ceiling");
      expect(ceilingOnDisk()).toBe(recorded);

      // …and the enforce run still fails, i.e. the violation was not laundered.
      expect(run().status).toBe(1);
    });

    it("raises only when asked out loud, and then the enforce run passes", () => {
      const r = run("--update-baseline", "--raise-ceiling");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("raised");
      expect(ceilingOnDisk()).toBe(measured);
      expect(run().status).toBe(0);
    });

    it("refuses --raise-ceiling on its own instead of silently ignoring it", () => {
      const r = run("--raise-ceiling");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--update-baseline");
    });
  });
});
