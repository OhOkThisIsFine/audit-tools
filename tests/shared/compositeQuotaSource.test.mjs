import { test, afterEach, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";

const { CompositeQuotaSource, buildQuotaSource } = await import("../../src/shared/quota/compositeQuotaSource.ts");
const { RunLogger } = await import("../../src/shared/observability/runLog.ts");

afterEach(() => vi.restoreAllMocks());

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

test("CompositeQuotaSource returns first non-null snapshot", async () => {
  const snap = makeSnapshot("second");
  const composite = new CompositeQuotaSource([
    nullSource("first"),
    snapshotSource("second", snap),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  expect(result).toBe(snap);
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
  expect(result).toBe(snap);
  expect(secondConsulted).toBe(false);
});

test("CompositeQuotaSource skips a synchronously throwing source and tries the next", async () => {
  const snap = makeSnapshot("second");
  const composite = new CompositeQuotaSource([
    throwingSource("first"),
    snapshotSource("second", snap),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  expect(result).toBe(snap);
});

test("CompositeQuotaSource skips a rejecting source and tries the next", async () => {
  const snap = makeSnapshot("second");
  const composite = new CompositeQuotaSource([
    {
      name: "first",
      queryCurrentUsage: () => Promise.reject(new Error("rejected")),
    },
    snapshotSource("second", snap),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  expect(result).toBe(snap);
});

test("CompositeQuotaSource returns null when all sources throw", async () => {
  const composite = new CompositeQuotaSource([
    throwingSource("first"),
    throwingSource("second"),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  expect(result).toBe(null);
});

test("CompositeQuotaSource returns null when all sources return null", async () => {
  const composite = new CompositeQuotaSource([
    nullSource("first"),
    nullSource("second"),
  ]);
  const result = await composite.queryCurrentUsage("provider/model");
  expect(result).toBe(null);
});

test("buildQuotaSource returns a composite named 'composite'", () => {
  const source = buildQuotaSource();
  expect(source.name).toBe("composite");
});

test("buildQuotaSource consults additional sources ahead of the learned source", async () => {
  // A throwing custom source first, then a snapshot-returning custom source:
  // if the composite returns the custom snapshot, the additional sources were
  // consulted before the trailing LearnedQuotaSource.
  const snap = makeSnapshot("custom");
  const source = buildQuotaSource({
    additionalSources: [throwingSource("custom-throws"), snapshotSource("custom-snap", snap)],
  });
  const result = await source.queryCurrentUsage("provider/model-that-has-no-state");
  expect(result).toBe(snap);
});

test("buildQuotaSource consults the injected claudeOAuth source first", async () => {
  const snap = makeSnapshot("claude-oauth");
  const source = buildQuotaSource({
    claudeOAuth: snapshotSource("claude-oauth", snap),
    additionalSources: [snapshotSource("other", makeSnapshot("other"))],
  });
  const result = await source.queryCurrentUsage("claude-code/x");
  expect(result).toBe(snap); // proactive Claude source wins over additional + learned
});

test("buildQuotaSource omits the claude source when claudeOAuth is false", async () => {
  const snap = makeSnapshot("other");
  const source = buildQuotaSource({
    claudeOAuth: false,
    additionalSources: [snapshotSource("other", snap)],
  });
  const result = await source.queryCurrentUsage("claude-code/x");
  expect(result).toBe(snap); // no claude source intercepts; additional source answers
});

test("logs a structured error event via RunLogger when a quota source throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "composite-quota-test-"));
  const logPath = join(dir, "run.log");
  const logger = new RunLogger(logPath);

  const eventSpy = vi.spyOn(logger, "event");
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  const snap = makeSnapshot("good");
  const composite = new CompositeQuotaSource(
    [throwingSource("bad-source"), snapshotSource("good", snap)],
    logger,
  );
  const result = await composite.queryCurrentUsage("provider/model");

  // Skip behaviour preserved: returns the good source's snapshot
  expect(result).toBe(snap);

  // RunLogger.event was called once for the throwing source
  expect(eventSpy.mock.calls.length).toBe(1);
  const [evt] = eventSpy.mock.calls[0];
  expect(evt.kind).toBe("error");
  expect(evt.phase).toBe("quota");
  expect(evt.note.includes("bad-source"), `note should include source name, got: ${evt.note}`).toBeTruthy();
  expect(evt.note.includes("bad-source boom"), `note should include error message, got: ${evt.note}`).toBeTruthy();
  // OBS-9ae1a228: the note must name the providerModelKey being queried so an
  // operator can tell which provider/model combination triggered the failure.
  expect(
    evt.note.includes("provider/model"),
    `note should include the providerModelKey, got: ${evt.note}`,
  ).toBeTruthy();

  // console.warn is NOT called
  expect(warnSpy.mock.calls.length).toBe(0);
});
