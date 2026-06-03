import test from "node:test";
import assert from "node:assert/strict";

const { CompositeQuotaSource, buildQuotaSource } = await import(
  "../dist/quota/compositeQuotaSource.js"
);

function makeSnapshot(source) {
  return {
    remaining_pct: null,
    reset_at: null,
    requests_remaining: 1,
    tokens_remaining: null,
    captured_at: "1970-01-01T00:00:00.000Z",
    source,
  };
}

function snapshotSource(name, snapshot) {
  return { name, queryCurrentUsage: async () => snapshot };
}

function nullSource(name) {
  return { name, queryCurrentUsage: async () => null };
}

function throwingSource(name) {
  return {
    name,
    queryCurrentUsage: async () => {
      throw new Error(`${name} boom`);
    },
  };
}

/** Silence (and capture) console.warn for a single async body. */
async function withSilencedWarn(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => {
    calls.push(args.map(String).join(" "));
  };
  try {
    return await fn(calls);
  } finally {
    console.warn = original;
  }
}

test("CompositeQuotaSource returns first non-null snapshot", async () => {
  const snap = makeSnapshot("second");
  const composite = new CompositeQuotaSource([
    nullSource("first"),
    snapshotSource("second", snap),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  assert.equal(result, snap);
});

test("CompositeQuotaSource returns first source's snapshot without consulting later ones", async () => {
  let secondConsulted = false;
  const snap = makeSnapshot("first");
  const composite = new CompositeQuotaSource([
    snapshotSource("first", snap),
    {
      name: "second",
      queryCurrentUsage: async () => {
        secondConsulted = true;
        return makeSnapshot("second");
      },
    },
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  assert.equal(result, snap);
  assert.equal(secondConsulted, false);
});

test("CompositeQuotaSource skips a synchronously throwing source and tries the next", async () => {
  await withSilencedWarn(async (warnings) => {
    const snap = makeSnapshot("second");
    const composite = new CompositeQuotaSource([
      throwingSource("first"),
      snapshotSource("second", snap),
    ]);
    const result = await composite.queryCurrentUsage("provider/model");
    assert.equal(result, snap);
    assert.ok(warnings.some((w) => w.includes("first")));
  });
});

test("CompositeQuotaSource skips a rejecting source and tries the next", async () => {
  await withSilencedWarn(async () => {
    const snap = makeSnapshot("second");
    const composite = new CompositeQuotaSource([
      {
        name: "first",
        queryCurrentUsage: () => Promise.reject(new Error("rejected")),
      },
      snapshotSource("second", snap),
    ]);
    const result = await composite.queryCurrentUsage("provider/model");
    assert.equal(result, snap);
  });
});

test("CompositeQuotaSource returns null when all sources throw, warning for each", async () => {
  await withSilencedWarn(async (warnings) => {
    const composite = new CompositeQuotaSource([
      throwingSource("first"),
      throwingSource("second"),
    ]);
    const result = await composite.queryCurrentUsage("provider/model");
    assert.equal(result, null);
    assert.ok(warnings.some((w) => w.includes("first")));
    assert.ok(warnings.some((w) => w.includes("second")));
  });
});

test("CompositeQuotaSource returns null when all sources return null", async () => {
  const composite = new CompositeQuotaSource([
    nullSource("first"),
    nullSource("second"),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  assert.equal(result, null);
});

test("buildQuotaSource returns a composite named 'composite'", () => {
  const source = buildQuotaSource();
  assert.equal(source.name, "composite");
});

test("buildQuotaSource consults additional sources ahead of the learned source", async () => {
  await withSilencedWarn(async () => {
    // A throwing custom source first, then a snapshot-returning custom source:
    // if the composite returns the custom snapshot, the additional sources were
    // consulted before the trailing LearnedQuotaSource.
    const snap = makeSnapshot("custom");
    const source = buildQuotaSource({
      additionalSources: [throwingSource("custom-throws"), snapshotSource("custom-snap", snap)],
    });
    const result = await source.queryCurrentUsage("provider/model-that-has-no-state");
    assert.equal(result, snap);
  });
});
