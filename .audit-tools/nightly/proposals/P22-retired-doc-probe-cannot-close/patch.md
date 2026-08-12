# P22 — ready-to-apply patch

Two edits to `scripts/nightly/items.mjs`, plus one new test file. Both were
applied to a working tree and run before this was written; the results are at the
bottom. The tree was then reverted — the nightly landed nothing.

## 1. `scripts/nightly/items.mjs` — import

```diff
-import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
+import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
```

## 2. `scripts/nightly/items.mjs` — in `evaluateOneProbe`, the untracked refusal

```diff
-  if (!isTrackedPath(root, probe.file)) return { state: 'untrackable', reason: 'untracked' };
+  // An untracked target abstains only when it is untracked AND PRESENT — that
+  // is the gitignored runtime artifact this refusal was built for: a file whose
+  // content varies per run and so can never be evidence.
+  //
+  // An untracked path that is also ABSENT from disk is the opposite case, and
+  // collapsing the two is what made "retire this doc" unclosable: the doc gets
+  // deleted, its path stops being tracked, and the item that ASKED for the
+  // deletion abstains forever. Fall through instead — the missing-file chain
+  // below already answers this exact question with git evidence, separating
+  // 'absent' (history has the file: deleted) from 'bad_path' (no history: a
+  // typo'd probe) and yielding to 'moved' when the prose reappears elsewhere.
+  // Those three verdicts were unreachable while this check preempted them.
+  if (!isTrackedPath(root, probe.file) && existsSync(join(root, probe.file))) {
+    return { state: 'untrackable', reason: 'untracked' };
+  }
```

Nothing else changes. The missing-file chain further down (`moved` → `absent` +
commit → `bad_path`, with `unknown` on any git failure) is untouched; this only
stops preempting it.

## 3. New file — `tests/shared/nightly-probe-retired-doc.test.ts`

```ts
// P22: a `contains` probe whose target doc was RETIRED (deleted) must resolve,
// not abstain. The untracked-target refusal exists to reject a gitignored
// runtime artifact — a path that EXISTS on disk but carries no evidence. A
// deleted tracked file is the opposite case: it is absent from disk, and the
// downstream history check already distinguishes "deleted" from "never existed".
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluateProbes } from "../../scripts/nightly/items.mjs";

let root: string;

function git(...args: string[]): void {
  const out = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "probe-retired-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(root, ".gitignore"), ".audit-tools/*/*\n");
  mkdirSync(join(root, "spec"), { recursive: true });
  writeFileSync(join(root, "spec", "doomed.md"), "This spec owns the whole quota model\n");
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a retired doc closes the item that asked for its retirement", () => {
  const item = {
    id: "docs-1",
    premise_probes: [{ file: "spec/doomed.md", contains: "This spec owns the whole quota model" }],
  };

  it("holds the item open while the doc still exists", () => {
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("present");
    expect(status).toBe("open");
  });

  it("RESOLVES once the doc is deleted and the prose is nowhere in the tree", () => {
    git("rm", "-q", "spec/doomed.md");
    git("commit", "-qm", "retire the spec");
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("absent");
    expect(probes[0]?.commit).toBeTruthy();
    expect(status).toBe("resolved");
  });

  it("stays OPEN when the prose merely MOVED to another doc", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "new-home.md"), "This spec owns the whole quota model\n");
    git("rm", "-q", "spec/doomed.md");
    git("add", "-A");
    git("commit", "-qm", "move it");
    const { status, probes } = evaluateProbes(root, item);
    expect(probes[0]?.state).toBe("moved");
    expect(status).toBe("open");
  });

  it("still ABSTAINS on a gitignored runtime artifact that exists on disk", () => {
    mkdirSync(join(root, ".audit-tools", "remediation"), { recursive: true });
    writeFileSync(join(root, ".audit-tools", "remediation", "state.json"), '{"s":"idle"}\n');
    const { status, probes } = evaluateProbes(root, {
      id: "x",
      premise_probes: [{ file: ".audit-tools/remediation/state.json", contains: '"s":"idle"' }],
    });
    expect(probes[0]?.state).toBe("untrackable");
    expect(status).toBe("open");
  });

  it("reports bad_path for a probe naming a file that NEVER existed", () => {
    const { status, probes } = evaluateProbes(root, {
      id: "y",
      premise_probes: [{ file: "spec/typo.md", contains: "anything" }],
    });
    expect(probes[0]?.state).toBe("bad_path");
    expect(status).toBe("open");
  });
});
```

## Red-green record

**RED — the test against unpatched HEAD** (`npx vitest run` on the new file):

```
 ✓ holds the item open while the doc still exists
 × RESOLVES once the doc is deleted and the prose is nowhere in the tree
   → expected 'untrackable' to be 'absent'
 × stays OPEN when the prose merely MOVED to another doc
   → expected 'untrackable' to be 'moved'
 ✓ still ABSTAINS on a gitignored runtime artifact that exists on disk
 × reports bad_path for a probe naming a file that NEVER existed
   → expected 'untrackable' to be 'bad_path'
 Tests  3 failed | 2 passed (5)
```

Note what the two failures beyond the headline one prove: `moved` and `bad_path`
are also unreachable today. The mis-close protection that makes the close path
safe has never executed in the deleted-file scenario.

**GREEN — with both edits applied**, the new file plus the three existing nightly
suites:

```
npx vitest run tests/shared/nightly-probe-retired-doc.test.ts \
  tests/shared/nightly-probe-target.test.ts \
  tests/shared/nightly-routine.test.ts \
  tests/shared/nightly-completion-ledger.test.ts

 Test Files  4 passed (4)
      Tests  90 passed (90)
```

The pre-existing P8 untracked-target suite (`nightly-probe-target.test.ts`) passes
unchanged — the gitignored-runtime-artifact refusal it owns is preserved.

## If accepted

Landing this makes `docs-1` auto-close on its own, so the manual drop recorded in
the proposal becomes unnecessary going forward. The full green gate
(`npm run build && npm run check && npm test`) has NOT been run against these
edits — only the four suites above — so run it before committing.
