import test from "node:test";
import assert from "node:assert/strict";

const { UnionFind } = await import("../src/orchestrator/unionFind.ts");

test("UnionFind: find() returns the key itself when it is its own root", () => {
  const uf = new UnionFind(["a", "b"]);
  assert.equal(uf.find("a"), "a");
  assert.equal(uf.find("b"), "b");
});

test("UnionFind: find() returns the passed key for an unknown key (fallback ?? key)", () => {
  const uf = new UnionFind([]);
  assert.equal(uf.find("unknown"), "unknown");
});

test("UnionFind: find() applies path compression so intermediate nodes point directly to root", () => {
  const uf = new UnionFind(["a", "b", "c"]);
  uf.union("a", "b");
  uf.union("b", "c");
  // After chained unions, find('c') must return 'a' (the lex-smallest root).
  assert.equal(uf.find("c"), "a");
  // Path compression: a second call is O(1) because intermediates now point directly to root.
  assert.equal(uf.find("c"), "a");
});

test("UnionFind: union() picks the lexicographically smaller root as canonical", () => {
  // union('b', 'a') → 'a' < 'b' so 'a' is kept as root
  const uf1 = new UnionFind(["a", "b"]);
  uf1.union("b", "a");
  assert.equal(uf1.find("b"), "a");

  // union('a', 'b') → same result regardless of argument order
  const uf2 = new UnionFind(["a", "b"]);
  uf2.union("a", "b");
  assert.equal(uf2.find("b"), "a");

  // union('z', 'm') → 'm' < 'z' so 'm' is kept as root
  const uf3 = new UnionFind(["z", "m"]);
  uf3.union("z", "m");
  assert.equal(uf3.find("z"), "m");
});

test("UnionFind: union() is idempotent — calling it twice on the same pair does not change the root", () => {
  const uf = new UnionFind(["a", "b"]);
  uf.union("a", "b");
  uf.union("a", "b");
  assert.equal(uf.find("b"), "a");
});

test("UnionFind: groups() returns a Map where each entry's key is the canonical root and the value array contains all members", () => {
  // No unions → 3 singleton groups
  const uf1 = new UnionFind(["a", "b", "c"]);
  const g1 = uf1.groups();
  assert.equal(g1.size, 3);
  assert.ok(g1.has("a"));
  assert.ok(g1.has("b"));
  assert.ok(g1.has("c"));

  // After union('a', 'b') → 2 groups: root 'a' has ['a','b'], root 'c' has ['c']
  const uf2 = new UnionFind(["a", "b", "c"]);
  uf2.union("a", "b");
  const g2 = uf2.groups();
  assert.equal(g2.size, 2);
  const groupA = g2.get("a");
  assert.ok(groupA !== undefined);
  assert.deepEqual([...groupA].sort(), ["a", "b"]);
  const groupC = g2.get("c");
  assert.ok(groupC !== undefined);
  assert.deepEqual(groupC, ["c"]);

  // After union('a','b') and union('b','c') → 1 group containing all three
  const uf3 = new UnionFind(["a", "b", "c"]);
  uf3.union("a", "b");
  uf3.union("b", "c");
  const g3 = uf3.groups();
  assert.equal(g3.size, 1);
  const groupAll = g3.get("a");
  assert.ok(groupAll !== undefined);
  assert.deepEqual([...groupAll].sort(), ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// COR-b6f68ad7: iterative path compression must not stack-overflow on deep chains
// ---------------------------------------------------------------------------

test("COR-b6f68ad7: find() handles deep chains (1000 items) without stack overflow", () => {
  // Build a degenerate chain: 0→1→2→…→999 via sequential unions, which
  // before the iterative fix would recurse 999 levels deep on find(0).
  const keys = Array.from({ length: 1000 }, (_, i) => String(i));
  const uf = new UnionFind(keys);
  // Chain: union(0,1), union(1,2), …, union(998, 999) — all resolve to "0" (lex smallest).
  for (let i = 0; i < 999; i++) {
    uf.union(String(i), String(i + 1));
  }
  // find on any key must return "0" without stack overflow.
  assert.doesNotThrow(() => {
    for (const key of keys) {
      assert.equal(uf.find(key), "0");
    }
  }, "find() on a 1000-item chain must not throw (no stack overflow)");
  // groups() must also complete and return exactly 1 group.
  const groups = uf.groups();
  assert.equal(groups.size, 1, "1000-item chain must produce a single group");
  const allMembers = groups.get("0");
  assert.ok(allMembers !== undefined, "root must be '0'");
  assert.equal(allMembers.length, 1000, "all 1000 members must be in the group");
});

test("UnionFind: groups() root keys are lexicographically smallest in their group", () => {
  // Chain: union z→m, then m→a; root of all three should be 'a'
  const uf = new UnionFind(["a", "b", "c", "m", "z"]);
  uf.union("z", "m");
  uf.union("m", "a");
  const g = uf.groups();
  // The group containing 'z' must be keyed by 'a' (lex smallest)
  assert.ok(g.has("a"));
  const groupZMA = g.get("a");
  assert.ok(groupZMA !== undefined);
  assert.ok([...groupZMA].includes("z"));
  assert.ok([...groupZMA].includes("m"));
  assert.ok([...groupZMA].includes("a"));
  // Every key in groups() satisfies key === find(key)
  for (const key of g.keys()) {
    assert.equal(key, uf.find(key));
  }
});
