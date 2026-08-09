// P8 (nightly sol-1, owner decision 2026-08-06): premise probes only accept
// targets that can carry evidence. `absent` — the verdict that CLOSES an item —
// is git-evidenced, so a probe aimed at a path git cannot speak about (a
// gitignored runtime artifact, a record file that quotes the code it is about)
// must abstain (`untrackable`), and writeOpenItems must refuse to author it.
// Lives under tests/ because vitest excludes `.claude/**` and the other nightly
// tests already sit here.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluateProbes,
  partitionBySettled,
  writeOpenItems,
} from "../../scripts/nightly/items.mjs";

let root: string;

/** A real git repo — the probe evidence chain shells out to git, so a fake tree proves nothing. */
function git(...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "probe-target-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), ".audit-tools/*/*\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "thing.ts"), "export const KEPT = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // The runtime artifact: exists on disk, gitignored, content varies per run.
  mkdirSync(join(root, ".audit-tools", "remediation"), { recursive: true });
  writeFileSync(join(root, ".audit-tools", "remediation", "state.json"), '{"status":"idle"}\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("premise probes only accept targets that can carry evidence", () => {
  it("does not resolve an item off a gitignored runtime artifact", () => {
    const { status, probes } = evaluateProbes(root, {
      premise_probes: [
        { file: ".audit-tools/remediation/state.json", contains: "status: implementing" },
      ],
    });
    expect(status).not.toBe("resolved");
    expect(probes[0]?.state).toBe("untrackable");
  });

  it("does not resolve an item off a record file that merely quotes the code", () => {
    mkdirSync(join(root, "docs", "reviews"), { recursive: true });
    writeFileSync(join(root, "docs", "reviews", "run-2026-01-01.md"), "a record\n");
    git("add", "-A");
    git("commit", "-qm", "record");
    const { status, probes } = evaluateProbes(root, {
      premise_probes: [{ file: "docs/reviews/run-2026-01-01.md", contains: "#14" }],
    });
    expect(status).not.toBe("resolved");
    expect(probes[0]?.state).toBe("untrackable");
  });

  it("still resolves an item whose tracked source fragment genuinely went away", () => {
    // The property must not be bought by disabling the mechanism.
    writeFileSync(join(root, "src", "thing.ts"), "export const KEPT = 1;\n");
    const { status } = evaluateProbes(root, {
      premise_probes: [{ file: "src/thing.ts", contains: "export const REMOVED" }],
    });
    expect(status).toBe("resolved");
  });

  it("still reports a live premise on a tracked source file as open", () => {
    const { status, probes } = evaluateProbes(root, {
      premise_probes: [{ file: "src/thing.ts", contains: "export const KEPT" }],
    });
    expect(status).toBe("open");
    expect(probes[0]?.state).toBe("present");
  });

  it("refuses to WRITE an item probing an untracked target, naming why", () => {
    expect(() =>
      writeOpenItems(root, {
        items: [
          {
            id: "x-1",
            subject_key: "k1",
            premise_probes: [
              { file: ".audit-tools/remediation/state.json", contains: "status: implementing" },
            ],
          },
        ],
      }),
    ).toThrow(/carries no evidence|tracked SOURCE file/);
  });
});

// P12 (nightly sol-5, owner decision 2026-08-06): a divergence item carries one
// probe per SIDE — the positive {file, contains} pinning the prose that asserts
// the wrong thing, and the negative {file, absent} on the side that lacks it —
// and resolves as soon as EITHER side moves. A one-sided probe let an item
// survive its own resolution and re-serve options that would corrupt a
// now-correct doc.
describe("two-sided divergence probes", () => {
  const divergence = () => ({
    id: "d-1",
    subject_key: "kd",
    premise_probes: [
      // Doc side asserts the wrong thing...
      { file: "src/thing.ts", contains: "export const KEPT" },
      // ...code side does not yet contain the fix marker.
      { file: "src/thing.ts", absent: "export const FIXED" },
    ],
  });

  it("stays open while both sides hold", () => {
    const { status, probes } = evaluateProbes(root, divergence());
    expect(status).toBe("open");
    expect(probes.map((p: { state: string }) => p.state).sort()).toEqual(["holds", "present"]);
  });

  it("resolves when the CODE side moves (the negative string appears)", () => {
    writeFileSync(
      join(root, "src", "thing.ts"),
      "export const KEPT = 1;\nexport const FIXED = 2;\n",
    );
    const { status, probes } = evaluateProbes(root, divergence());
    expect(probes.find((p: { form?: string }) => p.form === "absent")?.state).toBe("appeared");
    expect(status).toBe("resolved");
  });

  it("resolves when the DOC side moves (the positive string vanishes), even though the negative side still holds", () => {
    writeFileSync(join(root, "src", "thing.ts"), "export const RENAMED = 1;\n");
    const { status } = evaluateProbes(root, divergence());
    expect(status).toBe("resolved");
  });

  it("refuses to WRITE a negative probe whose string is already present", () => {
    expect(() =>
      writeOpenItems(root, {
        items: [
          {
            id: "d-2",
            subject_key: "kd2",
            premise_probes: [
              { file: "src/thing.ts", contains: "export const KEPT" },
              { file: "src/thing.ts", absent: "export const KEPT" },
            ],
          },
        ],
      }),
    ).toThrow(/does not pass at HEAD/);
  });

  it("refuses to WRITE an item carrying only negative probes", () => {
    expect(() =>
      writeOpenItems(root, {
        items: [
          {
            id: "d-3",
            subject_key: "kd3",
            premise_probes: [{ file: "src/thing.ts", absent: "export const FIXED" }],
          },
        ],
      }),
    ).toThrow(/one probe per SIDE/);
  });

  it("keeps the every-fragment-vanished rule for positive-only multi-probe items", () => {
    // One of two positive fragments vanished; the other still present -> open.
    writeFileSync(join(root, "src", "thing.ts"), "export const KEPT = 1;\n");
    const { status } = evaluateProbes(root, {
      premise_probes: [
        { file: "src/thing.ts", contains: "export const KEPT" },
        { file: "src/thing.ts", contains: "export const GONE_FRAGMENT" },
      ],
    });
    expect(status).toBe("open");
  });
});

// P18 (nightly sol-4, owner decision 2026-08-09): the record-path refusal is
// split by DIRECTION. Closing and creating need opposite properties from the
// same probe — a record file's text vanishing must never CLOSE an item, but that
// text being present is exactly the premise a question ABOUT a record asserts,
// and must be checkable at CREATE. One rule enforcing both left leg 2 unable to
// write the escalations it is defined to produce: zero in three runs, four
// questions displaced into HANDOFF by hand.
describe("record-path probes are refused by direction, not outright", () => {
  const RECORD = "docs/backlog/open-bugs.md";
  const FRAGMENT = "the entry that has no code side";

  /** A tracked record file carrying the fragment an escalation would quote. */
  function seedRecord(text = `- ${FRAGMENT}\n`): void {
    mkdirSync(join(root, "docs", "backlog"), { recursive: true });
    writeFileSync(join(root, RECORD), text);
    git("add", "-A");
    git("commit", "-qm", "record");
  }

  const escalation = (overrides: Record<string, unknown> = {}) => ({
    id: "backlog-1",
    subject_key: "kb1",
    auto_close: false,
    premise_probes: [{ file: RECORD, contains: FRAGMENT }],
    ...overrides,
  });

  it("still refuses a record-path probe on an ordinary item (the flag is the only door)", () => {
    seedRecord();
    expect(() =>
      writeOpenItems(root, { items: [escalation({ auto_close: undefined })] }),
    ).toThrow(/carries no evidence|tracked SOURCE file/);
  });

  it("accepts a record-path contains probe when the item declares auto_close:false", () => {
    seedRecord();
    const payload = writeOpenItems(root, { items: [escalation()] });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.auto_close).toBe(false);
  });

  it("still VERIFIES the premise at write — a fragment absent from the record is refused", () => {
    seedRecord("- some other entry entirely\n");
    expect(() => writeOpenItems(root, { items: [escalation()] })).toThrow(
      /does not pass at HEAD/,
    );
  });

  it("refuses auto_close:false when any probe targets a non-record path", () => {
    seedRecord();
    expect(() =>
      writeOpenItems(root, {
        items: [
          escalation({
            premise_probes: [
              { file: RECORD, contains: FRAGMENT },
              { file: "src/thing.ts", contains: "export const KEPT" },
            ],
          }),
        ],
      }),
    ).toThrow(/declares auto_close:false but carries/);
  });

  it("refuses auto_close:false on a negative probe — a record cannot speak for the code side", () => {
    seedRecord();
    expect(() =>
      writeOpenItems(root, {
        items: [
          escalation({
            premise_probes: [
              { file: RECORD, contains: FRAGMENT },
              { file: RECORD, absent: "not in this record" },
            ],
          }),
        ],
      }),
    ).toThrow(/declares auto_close:false but carries/);
  });

  it("never auto-closes such an item, even once the quoted fragment is deleted", () => {
    // The guarantee the split must not buy its capability with. This is the
    // close path exactly as `partitionBySettled` walks it — no flag passed — so
    // the record probe abstains and `resolved` stays unreachable.
    seedRecord();
    const item = escalation();
    writeOpenItems(root, { items: [item] });

    expect(evaluateProbes(root, item).status).not.toBe("resolved");

    writeFileSync(join(root, RECORD), "- the entry was rewritten entirely\n");
    git("add", "-A");
    git("commit", "-qm", "rewrite record");

    expect(evaluateProbes(root, item).status).not.toBe("resolved");
    const { open, resolved } = partitionBySettled([item], {}, root);
    expect(resolved).toHaveLength(0);
    expect(open).toHaveLength(1);
  });
});
