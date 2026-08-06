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
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateProbes, writeOpenItems } from "../../scripts/nightly/items.mjs";

let root: string;

/** A real git repo — the probe evidence chain shells out to git, so a fake tree proves nothing. */
function git(...args: string[]): void {
  const out = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
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
    expect(probes.map((p) => p.state).sort()).toEqual(["holds", "present"]);
  });

  it("resolves when the CODE side moves (the negative string appears)", () => {
    writeFileSync(
      join(root, "src", "thing.ts"),
      "export const KEPT = 1;\nexport const FIXED = 2;\n",
    );
    const { status, probes } = evaluateProbes(root, divergence());
    expect(probes.find((p) => p.form === "absent")?.state).toBe("appeared");
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
