import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findRetiredMentions } from "../scripts/check-retired-infrastructure.mjs";
import { rebaseRelativeLinks } from "../scripts/shared/rebase-relative-links.mjs";
import { BRIEF_BEGIN, BRIEF_END, markedPhilosophyBrief } from "../scripts/shared/philosophy-brief.mjs";

test("doc link gate reports a wrong ancestor even if the filename matches", async t => {
  const root = await mkdtemp(join(tmpdir(), "audit-docs-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (file, ...args) => {
    const result = spawnSync(file, args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.ifError(result.error);
    return result;
  };
  const git = (...args) => {
    const result = run("git", ...args);
    assert.equal(result.status, 0, result.stderr);
  };
  const check = fileURLToPath(new URL("../scripts/check-doc-links.mjs", import.meta.url));
  const readme = join(root, "README.md");
  const links = "[ok](Docs/Guide/Target.md#heading)\n[generated](dist/ignored.md)\n[external](https://example.com/absent)\n";
  git("init", "-q");
  await mkdir(join(root, "Docs", "Guide"), { recursive: true });
  await writeFile(join(root, "Docs", "Guide", "Target.md"), "# Heading\n");
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await writeFile(readme, links);
  git("add", "--", ".");
  const good = run(process.execPath, check);
  assert.equal(good.status, 0, good.stderr);
  await writeFile(readme, links + "[wrong ancestor](Docs/guide/Target.md)\n");
  const bad = run(process.execPath, check);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /1 unresolvable relative link/);
  assert.match(bad.stderr, /case-mismatch/);
  assert.match(bad.stderr, /Docs\/guide\/Target\.md/);
  assert.match(bad.stderr, /`Guide`/);
  assert.doesNotMatch(bad.stderr, /ignored\.md|example\.com/);
});

test("only a documented row-specific retirement reason exempts the same or next line", () => {
  const ids = (line, above) => findRetiredMentions(line, above).map(({ id }) => id);
  const marker = "<!-- retired-infrastructure-exempt: llm-relay — replaced by agent-dispatch -->";
  assert.deepEqual(ids(`llm-relay and FreeLLMAPI ${marker}`), ["freellmapi"]);
  assert.deepEqual(ids("llm-relay", marker), []);
  for (const malformed of [
    "<!-- retired-infrastructure-exempt: llm-relay -->",
    "<!-- retired-infrastructure-exempt: llm-relay —   -->",
    "<!-- retired-infrastructure-exempt: llm-relay - replaced by agent-dispatch -->",
  ]) {
    assert.deepEqual(ids("llm-relay", malformed), ["llm-relay"]);
    assert.deepEqual(ids(`llm-relay ${malformed}`), ["llm-relay"]);
  }
  assert.deepEqual(ids("llm-relay", "<!-- retired-infrastructure-exempt: unknown-row — replaced -->"),
    ["llm-relay", "unknown-row"]);
});

test("rebasing onto the destination directory uses an explicit local path", () => {
  const rebase = text => rebaseRelativeLinks(text, "docs/backlog/open.md", "docs/HANDOFF.md");
  assert.equal(rebase("[directory](..)\n[ref]: ../#heading\n[inline](..#heading)"),
    "[directory](./)\n[ref]: ./#heading\n[inline](./#heading)");
  const untouched = "[web](https://example.com/) [anchor](#h) [absolute](/docs/)\n[ref]: //example.com";
  assert.equal(rebase(untouched), untouched);
});

test("philosophy extraction requires an opening marker with its own terminator", () => {
  assert.equal(markedPhilosophyBrief(`prefix\n${BRIEF_BEGIN} — generated -->\n\n  body\n\n${BRIEF_END}\nsuffix`), "body");
  assert.equal(markedPhilosophyBrief(`prefix\n${BRIEF_BEGIN} — unclosed\nbody\n${BRIEF_END}`), null);
  assert.equal(markedPhilosophyBrief(`${BRIEF_BEGIN} — unclosed\n<!-- stray -->\nbody\n${BRIEF_END}`), null);
  assert.equal(markedPhilosophyBrief(`${BRIEF_BEGIN} — no comment terminator at all`), null);
});
