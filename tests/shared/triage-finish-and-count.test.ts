// Packet 28 (nightly 2eefa66ab7c9bd64, 98f93995eb770e05) — finish nightly
// normalization and the premise counters together.
//
// The transport is agent-dispatch in production. Exercise the shared driver
// with the exported triage record fold and counters, using a local fake answer
// source so no agent-dispatch service is needed for this regression test.
//
// The five premise classes are single-sourced (`PREMISE_STAMP_CLASSES`), the
// finish fold is single-sourced (`finishTriageRecord`, used by BOTH the write
// and the revive path), and the counts are read from the returned stamp — which
// is the same stamp the routine reads from `<out>-coverage.json`. Assertions
// below own three properties, one per accepted bullet:
//
//   - ORDER identity → premise → path classification → downgrade, with the
//     unresolved guessed paths restored before a revived record is re-folded.
//   - one `finishTriageRecord` for new AND revived records, downgrading an
//     unearned shipped claim on both paths.
//   - counts: revived retained records and newly produced records are each
//     counted exactly once, invocation attempts stay separate from the
//     persisted classified totals, and the premise-class totals equal the
//     complete classified population.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";

import { dispatchBoundedItems } from "../../scripts/shared/lane-dispatch.mjs";
import {
  PREMISE_STAMP_CLASSES,
  TRIAGE_STAMP_INIT,
  UNVERIFIED_SHIPPED_VERDICT,
  buildTriageRecord,
  countTriageStamp,
  finishTriageRecord,
} from "../../scripts/shared/triage-backlog.mjs";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh fixture workdir whose `root` doubles as the tree AND the sweep cwd. */
function fixture() {
  const d = mkdtempSync(join(tmpdir(), "triage-finish-"));
  dirs.push(d);
  return d;
}

function git(root: string, ...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

// The TREE the premise probes run against, committed so `git ls-files`/
// `git grep`/`git log` can attest to it (a premise probe aimed at a path git
// cannot see abstains as untrackable/unusable, so the tree must be a real repo).
// The only fragment that MUST hold is `LIVE_SYMBOL` in `src/audit/dispatch.ts`;
// every other probe is aimed at a missing/record path so its class is controlled
// deterministically.
function writeTree(root: string) {
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, "src", "audit"), { recursive: true });
  mkdirSync(join(root, "docs", "backlog"), { recursive: true });
  writeFileSync(join(root, "src", "audit", "dispatch.ts"), "export const LIVE_SYMBOL = 1;\n");
  writeFileSync(join(root, "docs", "backlog", "open-bugs.md"), "quotes LIVE_SYMBOL\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
}

// A lane that answers by the entry TEXT embedded in the task, so each entry
// triggers a chosen terminal shape: a valid JSON record, a non-JSON answer
// (rejected), or a terminal failure. `text` is unique per entry, so it keys the
// answer; the preflight (a fixed "single word" question) always completes.
function fakeLane(answers: Record<string, (e: { id: string }) => { raw: string; finishReason: string; lane: string; error?: string }>) {
  return {
    async close() {},
    async dispatch(task: string) {
      if (task.includes("single word")) {
        return { status: "completed", lane: "preflight", raw: "ok" };
      }
      const key = Object.keys(answers).find((k) => task.includes(k));
      if (!key) throw new Error(`no fake answer for task: ${task.slice(-80)}`);
      const r = answers[key]({ id: key });
      return { status: r.finishReason, lane: r.lane, raw: r.raw, error: r.error };
    },
  };
}

function triageDriverOptions({ root, lane, outPath, items }: {
  root: string;
  lane: ReturnType<typeof fakeLane>;
  outPath: string;
  items: Array<{ id: string; file: string; text: string }>;
}) {
  return {
    items,
    outPath,
    concurrency: 1,
    stampSeed: { model: "agent-dispatch dispatch" },
    stampInit: { ...TRIAGE_STAMP_INIT, lanes: {} },
    stampExtra: countTriageStamp,
    preflight: async () => {
      const result = await lane.dispatch("Reply with the single word: ok");
      if (result.status !== "completed") throw new Error(`preflight ${result.status}`);
    },
    callLane: async (entry: { id: string; file: string; text: string }) => {
      const result = await lane.dispatch(entry.text);
      return {
        raw: result.raw,
        finishReason: result.status,
        lane: result.lane,
        error: result.error,
      };
    },
    buildRecord: (entry: { id: string; file: string }, result: {
      raw: string; finishReason: string; lane: string; error?: string;
    }) => {
      if (result.finishReason !== "completed") throw new Error(`dispatch ${result.finishReason}`);
      return finishTriageRecord(buildTriageRecord(entry, result.raw), { lane: result.lane, root });
    },
    reviveRecord: (record: { code_paths?: string[]; code_paths_unresolved?: Array<{ written: string }> }) =>
      finishTriageRecord({
        ...record,
        code_paths: [
          ...(record.code_paths ?? []),
          ...(record.code_paths_unresolved ?? []).map((path) => path.written),
        ],
      }, { root }),
  };
}

/** A minimal valid lane answer: a shipped claim quoting nothing checkable. */
function shippedAnswer(verdict = "already_shipped_or_stale") {
  return {
    raw: JSON.stringify({
      title: "t",
      verdict,
      why: "the entry says shipped",
      action: "delete",
      effort: "S",
      code_paths: [],
      premise_probes: [],
    }),
    finishReason: "completed",
    lane: "litellm/medium",
  };
}

// The ONE entry this sweep will classify, reused so revive/resume behaviour is
// exercised against a known id. `text` is also the fake lane's answer key: the
// task embeds the entry text verbatim, so a distinct text names a distinct answer.
const ENTRY = { id: "open-bugs#aaaa", file: "open-bugs.md", text: "entry-alpha" };

describe("the triage finish fold and premise counters through the shared driver", () => {
  it("names all five premise classes in one frozen list, each with a counter", () => {
    expect(PREMISE_STAMP_CLASSES).toEqual([
      "holds",
      "partial",
      "premise_unconfirmed",
      "probes_unusable",
      "unprobed",
    ]);
    for (const cls of PREMISE_STAMP_CLASSES) {
      expect(TRIAGE_STAMP_INIT).toHaveProperty(cls, 0);
    }
  });

  it("downgrades an unearned shipped claim on the WRITE path, and counts it once", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    const lane = fakeLane({ [ENTRY.text]: () => shippedAnswer() });

    const { stamp, records } = await dispatchBoundedItems(
      triageDriverOptions({ root, lane, outPath, items: [ENTRY] }),
    );
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.verdict).toBe(UNVERIFIED_SHIPPED_VERDICT);
    expect(rec.premise).toBe("unprobed");
    expect(rec.lane).toBe("litellm/medium");
    expect(rec.served_by).toBeUndefined();
    // The write path counted the produced record once.
    expect(stamp.classified).toBe(1);
    expect(stamp.classified_total).toBe(1);
    expect(stamp.attempted).toBe(1);
    expect(stamp.unprobed).toBe(1);
    expect(stamp.premise_unconfirmed + stamp.probes_unusable + stamp.partial + stamp.holds).toBe(0);
  });

  it("classifies a HOLDING probe, and keeps a shipped verdict that earned its premise", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    const holding = {
      raw: JSON.stringify({
        title: "t",
        verdict: "already_shipped_or_stale",
        why: "shipped",
        action: "delete",
        effort: "S",
        code_paths: [],
        premise_probes: [{ file: "src/audit/dispatch.ts", contains: "LIVE_SYMBOL" }],
      }),
      finishReason: "completed",
      lane: "litellm/medium",
    };
    const lane = fakeLane({ [ENTRY.text]: () => holding });

    const { stamp, records } = await dispatchBoundedItems(
      triageDriverOptions({ root, lane, outPath, items: [ENTRY] }),
    );
    expect(records[0].premise).toBe("holds");
    // Earned: the shipped verdict survives.
    expect(records[0].verdict).toBe("already_shipped_or_stale");
    expect(stamp.holds).toBe(1);
    expect(stamp.classified).toBe(1);
  });

  it("does NOT count a rejected record, and keeps attempts separate from classified", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    // A lane answer that is not JSON → buildTriageRecord throws → error row.
    const garbage = { raw: "I cannot classify this.", finishReason: "completed", lane: "litellm/medium" };
    const lane = fakeLane({ [ENTRY.text]: () => garbage });

    const { stamp, records } = await dispatchBoundedItems(
      triageDriverOptions({ root, lane, outPath, items: [ENTRY] }),
    );
    expect(records[0].error).toBeTruthy();
    expect(stamp.attempted).toBe(1);
    expect(stamp.errored).toBe(1);
    expect(stamp.classified).toBe(0);
    expect(stamp.classified_total).toBe(0);
    // No premise counter moved for a row that never finished.
    for (const cls of PREMISE_STAMP_CLASSES) expect(stamp[cls]).toBe(0);
  });

  it("re-folds a REVIVED record, re-deriving its premise against the tree now", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    // First pass: classify the entry as a shipped claim with NO probes (unprobed),
    // which the write path downgrades.
    const lane1 = fakeLane({ [ENTRY.text]: () => shippedAnswer() });
    await dispatchBoundedItems(triageDriverOptions({ root, lane: lane1, outPath, items: [ENTRY] }));

    // Second pass over the SAME file with ZERO new items: the drive is a resume.
    // The stored record must be revived (re-folded) and counted as retained.
    const lane2 = fakeLane({ default: () => ({ raw: "{}", finishReason: "completed", lane: "unused" }) });
    const { stamp: stamp2 } = await dispatchBoundedItems(
      triageDriverOptions({ root, lane: lane2, outPath, items: [] }),
    );

    // Zero-new-item resume: nothing attempted or newly classified this pass,
    // but the retained record is still part of the classified population.
    expect(stamp2.attempted).toBe(0);
    expect(stamp2.classified).toBe(0);
    expect(stamp2.prior_classified).toBe(1);
    expect(stamp2.classified_total).toBe(1);

    // The revived record on disk was re-folded: it still carries the downgraded
    // verdict and the re-derived `unprobed` premise after restore + re-fold.
    const revived = JSON.parse(readFileSync(outPath, "utf8").trim());
    expect(revived.verdict).toBe(UNVERIFIED_SHIPPED_VERDICT);
    expect(revived.premise).toBe("unprobed");
  });

  it("counts revived retained and newly produced records exactly once each (mixed)", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");

    // Pass 1: classify one entry (unprobed/downgraded) and persist it.
    const lane1 = fakeLane({ [ENTRY.text]: () => shippedAnswer() });
    await dispatchBoundedItems(triageDriverOptions({ root, lane: lane1, outPath, items: [ENTRY] }));

    // Pass 2: a DIFFERENT entry is new; the first is retained and revived. Both
    // must be counted exactly once — no double count of the revived row.
    const NEW_ENTRY = { id: "open-bugs#bbbb", file: "open-bugs.md", text: "entry-beta" };
    const holding = {
      raw: JSON.stringify({
        title: "t",
        verdict: "actionable_now",
        why: "derivable",
        action: "fix",
        effort: "S",
        code_paths: [],
        premise_probes: [{ file: "src/audit/dispatch.ts", contains: "LIVE_SYMBOL" }],
      }),
      finishReason: "completed",
      lane: "litellm/medium",
    };
    const lane2 = fakeLane({ [NEW_ENTRY.text]: () => holding });
    const { stamp: stamp2 } = await dispatchBoundedItems(
      triageDriverOptions({ root, lane: lane2, outPath, items: [NEW_ENTRY] }),
    );

    // One prior retained, one newly produced → total two, counted once each.
    expect(stamp2.prior_classified).toBe(1);
    expect(stamp2.classified).toBe(1);
    expect(stamp2.classified_total).toBe(2);
    expect(stamp2.attempted).toBe(1);

    // The on-disk file holds exactly two records (revived + new), each counted
    // in its class exactly once: `unprobed` (the revived shipped claim) and
    // `holds` (the new actionable item).
    const rows = readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean);
    expect(rows).toHaveLength(2);
    expect(stamp2.unprobed).toBe(1);
    expect(stamp2.holds).toBe(1);

    // Premise-class totals equal the full classified population.
    const classTotal = PREMISE_STAMP_CLASSES.reduce((n, c) => n + stamp2[c], 0);
    expect(classTotal).toBe(stamp2.classified_total);
    expect(classTotal).toBe(2);
  });

  it("restores unresolved guessed paths before re-folding a revived record", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    // A record whose code_paths were partially resolved: one real path, one
    // unresolved guess the model invented. On revive, the guess must be restored
    // into code_paths so re-resolution does not lose it forever.
    const withGuess = {
      raw: JSON.stringify({
        title: "t",
        verdict: "actionable_now",
        why: "derivable",
        action: "fix",
        effort: "S",
        code_paths: ["src/audit/dispatch.ts", "src/nope/fabricated.ts"],
        premise_probes: [{ file: "src/audit/dispatch.ts", contains: "LIVE_SYMBOL" }],
      }),
      finishReason: "completed",
      lane: "litellm/medium",
    };
    const lane1 = fakeLane({ [ENTRY.text]: () => withGuess });
    await dispatchBoundedItems(triageDriverOptions({ root, lane: lane1, outPath, items: [ENTRY] }));

    // The written record resolved the real path and kept the guess unresolved.
    const written = JSON.parse(readFileSync(outPath, "utf8").trim());
    expect(written.code_paths).toEqual(["src/audit/dispatch.ts"]);
    expect(written.code_paths_unresolved.map((u: { written: string }) => u.written)).toEqual([
      "src/nope/fabricated.ts",
    ]);

    // Revive: re-fold restores the guess and re-resolves — the fabricated path is
    // still unresolved (not silently dropped), the real path still resolves.
    const lane2 = fakeLane({ default: () => ({ raw: "{}", finishReason: "completed", lane: "unused" }) });
    await dispatchBoundedItems(triageDriverOptions({ root, lane: lane2, outPath, items: [] }));
    const revived = JSON.parse(readFileSync(outPath, "utf8").trim());
    expect(revived.code_paths).toEqual(["src/audit/dispatch.ts"]);
    expect(revived.code_paths_unresolved.map((u: { written: string }) => u.written)).toEqual([
      "src/nope/fabricated.ts",
    ]);
  });

  it("is idempotent under repeated normalization — a second revive changes nothing", async () => {
    const root = fixture();
    writeTree(root);
    const outPath = join(root, "triage.jsonl");
    const lane1 = fakeLane({ [ENTRY.text]: () => shippedAnswer() });
    await dispatchBoundedItems(triageDriverOptions({ root, lane: lane1, outPath, items: [ENTRY] }));
    const first = readFileSync(outPath, "utf8");

    // Two more zero-new-item resumes over the same stored record.
    for (let i = 0; i < 2; i++) {
      const lane = fakeLane({ default: () => ({ raw: "{}", finishReason: "completed", lane: "unused" }) });
      await dispatchBoundedItems(triageDriverOptions({ root, lane, outPath, items: [] }));
    }
    const after = readFileSync(outPath, "utf8");
    expect(after).toBe(first);
  });
});
