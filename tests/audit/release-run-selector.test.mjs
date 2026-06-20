import test from "node:test";
import assert from "node:assert/strict";

// Importing the release script must be side-effect free: `main()` only runs when
// the module is invoked as the entry script, so importing the pure selector
// here does NOT push/tag/publish.
import { selectReleaseRun } from "../../scripts/release-and-publish.mjs";

const TAG = "v1.2.3";

// created_at helper: ms epoch -> ISO string the GitHub API returns.
const iso = (ms) => new Date(ms).toISOString();

test("(a) identity select: head_sha-matching post-push run wins over stale same-name run", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const stale = {
    id: 100,
    run_number: 10,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "oldsha000",
    created_at: iso(pushedAt - 60 * 60 * 1000), // an hour before push (reverted release)
  };
  const genuine = {
    id: 200,
    run_number: 11,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "newsha111",
    created_at: iso(pushedAt + 30 * 1000),
  };
  const selected = selectReleaseRun([stale, genuine], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: "newsha111",
  });
  assert.equal(selected.id, 200);
});

test("(b) order-independence: reversing the array selects the same genuine run", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const stale = {
    id: 100,
    run_number: 10,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "oldsha000",
    created_at: iso(pushedAt - 60 * 60 * 1000),
  };
  const genuine = {
    id: 200,
    run_number: 11,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "newsha111",
    created_at: iso(pushedAt + 30 * 1000),
  };
  const opts = { tag: TAG, tagPushedAtMs: pushedAt, headSha: "newsha111" };
  const forward = selectReleaseRun([stale, genuine], opts);
  const reversed = selectReleaseRun([genuine, stale], opts);
  assert.equal(forward.id, 200);
  assert.equal(reversed.id, 200);
});

test("(c) no qualifying run -> null (waiter times out, no stale-name fallback)", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const stale = {
    id: 100,
    run_number: 10,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "oldsha000",
    created_at: iso(pushedAt - 60 * 60 * 1000), // before push, wrong SHA
  };
  const selected = selectReleaseRun([stale], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: "newsha111", // no run matches this SHA; stale is too old for timestamp fallback
  });
  assert.equal(selected, null);
});

test("(d) headSha absent: selects newest run with created_at > tagPushedAtMs, no throw", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const stale = {
    id: 100,
    run_number: 10,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "oldsha000",
    created_at: iso(pushedAt - 60 * 60 * 1000),
  };
  const fresh1 = {
    id: 200,
    run_number: 11,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "sha-a",
    created_at: iso(pushedAt + 10 * 1000),
  };
  const fresh2 = {
    id: 300,
    run_number: 12,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "sha-b",
    created_at: iso(pushedAt + 40 * 1000), // newest
  };
  const selected = selectReleaseRun([fresh2, stale, fresh1], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: undefined,
  });
  assert.equal(selected.id, 300);
});

test("(e) same-SHA re-push: newest among identical-head_sha runs", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const first = {
    id: 200,
    run_number: 11,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "samesha",
    created_at: iso(pushedAt + 10 * 1000),
  };
  const second = {
    id: 300,
    run_number: 12,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "samesha",
    created_at: iso(pushedAt + 90 * 1000), // newest re-run of the same commit
  };
  const selected = selectReleaseRun([first, second], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: "samesha",
  });
  assert.equal(selected.id, 300);
});

test("skew: a genuine run stamped a few seconds before push is still selected", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  // No SHA keying available; run created 3s BEFORE the local push instant.
  const genuine = {
    id: 400,
    run_number: 20,
    head_branch: TAG,
    display_title: TAG,
    head_sha: "sha-x",
    created_at: iso(pushedAt - 3 * 1000),
  };
  const selected = selectReleaseRun([genuine], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: null,
  });
  assert.equal(selected.id, 400);
});

test("different-tag runs are never selected even when fresh", () => {
  const pushedAt = Date.parse("2026-06-19T12:00:00.000Z");
  const otherTag = {
    id: 500,
    run_number: 21,
    head_branch: "v9.9.9",
    display_title: "v9.9.9",
    head_sha: "sha-y",
    created_at: iso(pushedAt + 30 * 1000),
  };
  const selected = selectReleaseRun([otherTag], {
    tag: TAG,
    tagPushedAtMs: pushedAt,
    headSha: null,
  });
  assert.equal(selected, null);
});
