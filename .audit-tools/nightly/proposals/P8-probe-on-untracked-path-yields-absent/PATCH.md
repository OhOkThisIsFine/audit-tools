# P8 — patch

Two files change: `scripts/nightly/items.mjs` (the mechanism) and a new
`tests/shared/nightly-probe-target.test.ts` (the red-green proof). Tests live under `tests/`
because vitest excludes `.claude/**`, and the existing nightly tests already sit there
(`tests/shared/nightly-routine.test.ts`, `nightly-completion-ledger.test.ts`).

## 1. `scripts/nightly/items.mjs`

### 1a. A tracked-path classifier, beside `gitLines`

```js
// Paths the evidence chain cannot reason about. `absent` is the strongest
// verdict this module emits — all-absent is what closes an item — and it is
// justified by GIT evidence: the rename-protection `git grep` and the removal
// citation both search the TRACKED tree. A file git does not track (a
// gitignored runtime artifact under `.audit-tools/`, a build output) can
// therefore only ever fall through to `absent` for reasons that have nothing to
// do with whether the defect was fixed. It must abstain instead.
//
// The RECORD channels are the same error one step earlier: a backlog entry, a
// dated review, HANDOFF or the inbox QUOTES the code it is about, so a probe
// aimed at one is probing the record, not the premise. They are already
// excluded from the rename-protection search below for exactly this reason.
const RECORD_PATH_PREFIXES = [
  'docs/backlog',
  'docs/reviews',
  'docs/HANDOFF.md',
  'docs/nightly-inbox.md',
  '.claude',
];

function isRecordPath(file) {
  const norm = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return RECORD_PATH_PREFIXES.some((p) => norm === p || norm.startsWith(`${p}/`));
}

// `git ls-files --error-unmatch` exits non-zero for an untracked path, so the
// okStatuses:[0] default already maps "untracked" to null. A git failure is
// indistinguishable from untracked here, which errs toward abstaining — the
// safe direction for a verdict that closes items.
function isTrackedPath(root, file) {
  return gitLines(root, ['ls-files', '--error-unmatch', '--', file]) !== null;
}
```

### 1b. Classify the target first, in `evaluateOneProbe`

```diff
 function evaluateOneProbe(root, probe) {
+  // Refuse the target before reading it: a probe that cannot produce evidence
+  // must not produce the verdict that closes an item.
+  if (isRecordPath(probe.file)) return { state: 'untrackable', reason: 'record_path' };
+  if (!isTrackedPath(root, probe.file)) return { state: 'untrackable', reason: 'untracked' };
+
   let fileText = null;
   let readErr = null;
```

`untrackable` needs no handling in `evaluateProbes`: `status` is
`evaluated.every((p) => p.state === 'absent') ? 'resolved' : 'open'`, so any `untrackable` probe
already keeps the item **open**. It joins the signal-free set in
`scripts/shared/triage-backlog.mjs`'s `premiseStamp`, which stamps `unprobed` rather than `gone`:

```diff
-  const signalFree = new Set(['bad_path', 'unknown', 'error']);
+  const signalFree = new Set(['bad_path', 'unknown', 'error', 'untrackable']);
```

### 1c. Refuse it at creation — the load-bearing half

In `writeOpenItems`, the existing loop already throws on a probe that does not pass. Give the new
state its own message, so the author is told what to probe instead rather than being told the
premise is false:

```diff
     const failing = probes.filter((p) => p.state !== 'present');
     if (failing.length > 0) {
+      const untrackable = failing.filter((p) => p.state === 'untrackable');
+      if (untrackable.length > 0) {
+        const detail = untrackable.map((p) => `${p.file} (${p.reason})`).join('; ');
+        throw new Error(
+          `writeOpenItems: item "${item?.id ?? '(no id)'}" has a premise probe whose TARGET carries ` +
+            `no evidence (${detail}). A gitignored runtime artifact under ".audit-tools/", a build ` +
+            `output, or a record file (docs/backlog, docs/reviews, docs/HANDOFF.md, ` +
+            `docs/nightly-inbox.md, .claude) says nothing about whether the defect is fixed. ` +
+            `Quote a fragment from the tracked SOURCE file the fix would touch.`,
+        );
+      }
       const detail = failing.map((p) => `${p.file} [${p.state}] "${p.contains.slice(0, 60)}"`).join('; ');
```

## 2. `tests/shared/nightly-probe-target.test.ts` (new)

Red against HEAD, green after the patch. Each test states the property, not the mechanism.

```ts
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
    // RED at HEAD: the file reads, the fragment is missing, git grep finds nothing
    // tracked, so evaluateOneProbe falls through to `absent` -> status `resolved`.
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
    ).toThrow(/carries\s+no evidence|tracked SOURCE file/);
  });
});
```

### Red-green validation

Run the new file against unpatched `items.mjs` first: tests 1, 2 and 5 must FAIL (1 and 2 report
`resolved`/`absent`; 5 throws the generic "does not pass at HEAD" message, so tighten the regex if
it accidentally matches). Tests 3 and 4 must PASS both before and after — they are the guard against
buying the fix by breaking resolution altogether. Then apply the patch and confirm all five pass.
