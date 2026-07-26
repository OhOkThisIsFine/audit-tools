/**
 * parallel-flake-baseline.test.mjs — the tracked record that turns "is this
 * failure mine?" from a suite re-run into a lookup.
 *
 * A rotating set of heavy tests fails only in a full run and passes alone
 * (hermeticity, not regression), and every dispatch-touching lap re-derived that
 * same answer by stashing and running the whole suite on main to prove parity.
 * The reporter now records each test's deterministic-or-parallel-flaky status,
 * annotated with the environment it was measured in.
 *
 * The record is NOT an ignore-list, and every test below pins one of the ways a
 * looser version of it would launder a real red into a known flake.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import {
  FLAKE_BASELINE_PATH,
  classifyFailures,
  collectObservations,
  currentEnvironment,
  environmentKey,
  loadClassOf,
  mergeObservations,
  RECORD_ENV_VAR,
  readBaseline,
  recordingEnabled,
  updateFlakeBaseline,
  writeBaselineIfChanged,
} from "../../scripts/shared/vitest-timing-reporter.mjs";

const ENV = { platform: "linux", cpuCount: 16, workers: 16 };
const OTHER_ENV = { platform: "linux", cpuCount: 4, workers: 4 };
const HEAVY = "tests/audit/linux-cycle-regression.test.mjs > detects the cycle";

function tempBaselinePath() {
  return join(mkdtempSync(join(tmpdir(), "flake-baseline-")), "test-flake-baseline.json");
}

/** A vitest-shaped file task tree: leaves given as [name, state]. */
function fakeFile(filepath, leaves, fileState = "pass") {
  return {
    filepath,
    result: { state: fileState },
    tasks: leaves.map(([name, state]) => ({ type: "test", name, result: state ? { state } : undefined })),
  };
}

/** A full-suite-shaped run: the file of interest plus enough others to be `parallel`. */
function wholeSuite(...files) {
  const filler = Array.from({ length: 240 }, (_, i) =>
    fakeFile(`/repo/tests/shared/filler-${i}.test.mjs`, [["ok", "pass"]]),
  );
  return [...files, ...filler];
}

test("the record lives in a TRACKED path, not with the gitignored timing ledger", () => {
  // Its whole job is to outlive runs, branches and machines; written next to the
  // profile ledger it would be gitignored, and every fresh checkout would start
  // the investigation over.
  const path = FLAKE_BASELINE_PATH.replaceAll("\\", "/");
  expect(path.endsWith("scripts/shared/test-flake-baseline.json")).toBe(true);
  expect(path).not.toContain(".audit-tools-profile");
});

test("a run under load is `parallel`; the isolated re-run that proves contention is `solo`", () => {
  expect(loadClassOf({ fileCount: 240, workers: 16 })).toBe("parallel");
  expect(loadClassOf({ fileCount: 1, workers: 16 })).toBe("solo");
  // A serialized run has no contention to be flaky under, however many files it has.
  expect(loadClassOf({ fileCount: 240, workers: 1 })).toBe("solo");
});

test("the environment key separates measurements taken under different concurrency", () => {
  expect(environmentKey(ENV)).not.toBe(environmentKey(OTHER_ENV));
  expect(environmentKey(ENV)).toBe(environmentKey({ ...ENV }));
  const live = currentEnvironment({}, "win32");
  expect(live.platform).toBe("win32");
  expect(live.workers).toBeGreaterThan(0);
  expect(currentEnvironment({ VITEST_MAX_WORKERS: "3" }, "linux").workers).toBe(3);
});

test("observations carry the full test id and drop every non-decisive result", () => {
  const nested = {
    filepath: "C:\\repo\\tests\\shared\\x.test.mjs",
    result: { state: "fail" },
    tasks: [
      { type: "suite", name: "outer", tasks: [{ type: "test", name: "inner", result: { state: "fail" } }] },
      { type: "test", name: "plain", result: { state: "pass" } },
      { type: "test", name: "deliberately skipped", result: { state: "skip" } },
      // Result lost to a worker RPC timeout — never observed, so never evidence.
      { type: "test", name: "never reported", result: undefined },
    ],
  };
  expect(collectObservations([nested])).toEqual([
    { testId: "tests/shared/x.test.mjs > outer > inner", outcome: "fail" },
    { testId: "tests/shared/x.test.mjs > plain", outcome: "pass" },
  ]);
});

test("a file that died before collecting is observed under its own id", () => {
  const dead = { filepath: "/repo/tests/audit/heavy.test.mjs", result: { state: "fail" }, tasks: [] };
  expect(collectObservations([dead])).toEqual([{ testId: "tests/audit/heavy.test.mjs", outcome: "fail" }]);
});

test("only a failure under load creates an entry — a focused red-green loop cannot seed the record", () => {
  const solo = mergeObservations({
    record: readBaseline(tempBaselinePath()),
    environment: ENV,
    load: "solo",
    observations: [{ testId: "tests/shared/mine.test.mjs > wip", outcome: "fail" }],
  });
  expect(solo.environments).toEqual({});

  const parallel = mergeObservations({
    record: solo,
    environment: ENV,
    load: "parallel",
    observations: [{ testId: HEAVY, outcome: "fail" }],
  });
  expect(parallel.environments[environmentKey(ENV)].tests[HEAVY].status).toBe("unproven");
});

test("a failure under load that has never been seen passing licenses nothing", () => {
  // `unproven` is indistinguishable from a genuine regression that one run hit.
  const record = mergeObservations({
    record: { schema: 1, environments: {} },
    environment: ENV,
    load: "parallel",
    observations: [{ testId: HEAVY, outcome: "fail" }],
  });
  expect(classifyFailures({ record, environment: ENV, load: "parallel", failedTestIds: [HEAVY] })).toEqual([
    { testId: HEAVY, recordedStatus: "unproven", classification: "unrecognized" },
  ]);
});

test("a later solo PASS promotes the recorded failure to parallel_flaky, and only then is it recognized", () => {
  const afterLoad = mergeObservations({
    record: { schema: 1, environments: {} },
    environment: ENV,
    load: "parallel",
    observations: [{ testId: HEAVY, outcome: "fail" }],
  });
  const afterSolo = mergeObservations({
    record: afterLoad,
    environment: ENV,
    load: "solo",
    observations: [{ testId: HEAVY, outcome: "pass" }],
  });
  expect(afterSolo.environments[environmentKey(ENV)].tests[HEAVY]).toEqual({
    status: "parallel_flaky",
    evidence: { passedSolo: true, failedSolo: false, failedParallel: true },
  });
  expect(
    classifyFailures({ record: afterSolo, environment: ENV, load: "parallel", failedTestIds: [HEAVY] })[0]
      .classification,
  ).toBe("known_parallel_flaky");
});

test("a known flake that fails ALONE is a real failure again, then and afterwards", () => {
  const flaky = {
    schema: 1,
    environments: {
      [environmentKey(ENV)]: {
        environment: ENV,
        tests: {
          [HEAVY]: {
            status: "parallel_flaky",
            evidence: { passedSolo: true, failedSolo: false, failedParallel: true },
          },
        },
      },
    },
  };
  // The current run is the isolated re-run: nothing was contending, so the
  // flaky history cannot explain this failure.
  expect(
    classifyFailures({ record: flaky, environment: ENV, load: "solo", failedTestIds: [HEAVY] })[0].classification,
  ).toBe("unrecognized");

  // And that solo failure OUTRANKS the flaky history from then on — otherwise a
  // genuine regression in a historically load-sensitive test would be waved away.
  const afterSoloFailure = mergeObservations({
    record: flaky,
    environment: ENV,
    load: "solo",
    observations: [{ testId: HEAVY, outcome: "fail" }],
  });
  expect(afterSoloFailure.environments[environmentKey(ENV)].tests[HEAVY].status).toBe("deterministic");
  expect(
    classifyFailures({ record: afterSoloFailure, environment: ENV, load: "parallel", failedTestIds: [HEAVY] })[0]
      .classification,
  ).toBe("unrecognized");
});

test("passing in a LATER loaded run never promotes a failure — the tree may simply have been fixed", () => {
  // The confounder that makes only the isolated re-run admissible evidence: between
  // two full runs the code changes, so "failed under load on Monday, passed under
  // load on Tuesday" is the signature of a fix at least as much as of a flake. Were
  // it promotion evidence, every genuine failure that someone then fixed would end
  // up licensed as a known flake forever after.
  const recorded = mergeObservations({
    record: { schema: 1, environments: {} },
    environment: ENV,
    load: "parallel",
    observations: [{ testId: HEAVY, outcome: "fail" }],
  });
  const afterLoadedPass = mergeObservations({
    record: recorded,
    environment: ENV,
    load: "parallel",
    observations: [{ testId: HEAVY, outcome: "pass" }],
  });
  expect(afterLoadedPass.environments[environmentKey(ENV)].tests[HEAVY].status).toBe("unproven");
  expect(
    classifyFailures({ record: afterLoadedPass, environment: ENV, load: "parallel", failedTestIds: [HEAVY] })[0]
      .classification,
  ).toBe("unrecognized");
});

test("a status measured in a DIFFERENT environment never explains a failure here", () => {
  const elsewhere = mergeObservations({
    record: mergeObservations({
      record: { schema: 1, environments: {} },
      environment: OTHER_ENV,
      load: "parallel",
      observations: [{ testId: HEAVY, outcome: "fail" }],
    }),
    environment: OTHER_ENV,
    load: "solo",
    observations: [{ testId: HEAVY, outcome: "pass" }],
  });
  expect(elsewhere.environments[environmentKey(OTHER_ENV)].tests[HEAVY].status).toBe("parallel_flaky");
  expect(
    classifyFailures({ record: elsewhere, environment: ENV, load: "parallel", failedTestIds: [HEAVY] })[0],
  ).toEqual({ testId: HEAVY, recordedStatus: null, classification: "unrecognized" });
});

test("an unrecognized test id is unrecognized — absence is never permission", () => {
  expect(
    classifyFailures({
      record: { schema: 1, environments: {} },
      environment: ENV,
      load: "parallel",
      failedTestIds: ["tests/shared/brand-new.test.mjs > regression"],
    })[0].classification,
  ).toBe("unrecognized");
});

test("a corrupt, foreign-schema or malformed record reads as NO record", () => {
  const path = tempBaselinePath();
  expect(readBaseline(path)).toEqual({ schema: 1, environments: {} });
  for (const contents of ["{not json", JSON.stringify({ schema: 99, environments: { x: {} } }), "[]", "null"]) {
    writeFileSync(path, contents);
    expect(readBaseline(path), `\`${contents}\` must not be trusted`).toEqual({ schema: 1, environments: {} });
  }
});

test("the tracked file is written only on a real change, with sorted keys", () => {
  const path = tempBaselinePath();
  const record = mergeObservations({
    record: { schema: 1, environments: {} },
    environment: ENV,
    load: "parallel",
    observations: [
      { testId: "tests/z.test.mjs > z", outcome: "fail" },
      { testId: "tests/a.test.mjs > a", outcome: "fail" },
    ],
  });
  expect(writeBaselineIfChanged(path, record)).toBe(true);
  // Re-writing an unchanged record must leave the tree clean run after run.
  expect(writeBaselineIfChanged(path, record)).toBe(false);

  const text = readFileSync(path, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.indexOf("tests/a.test.mjs")).toBeLessThan(text.indexOf("tests/z.test.mjs"));
  expect(readBaseline(path)).toEqual(record);
});

test("a green run neither creates nor touches the tracked file", () => {
  const path = tempBaselinePath();
  const result = updateFlakeBaseline({ files: wholeSuite(), environment: ENV, baselinePath: path });
  expect(result.wrote).toBe(false);
  expect(() => readFileSync(path, "utf8")).toThrow();
});

test("a failure recorded by THIS run cannot explain itself", () => {
  // The ordering invariant, pinned by `recordedStatus: null`: the classification
  // is taken against the record as it stood BEFORE this run's own failure was
  // filed. Reversed, a failure reads back the entry it just wrote, and the only
  // thing left between that and a self-ratifying red is whichever status rule it
  // happens to land on.
  const path = tempBaselinePath();
  const files = wholeSuite(fakeFile("/repo/tests/audit/heavy.test.mjs", [["detects the cycle", "fail"]], "fail"));
  // `recording: true` because this case is about the MERGE ordering, which only
  // observable once a write happens. The gate itself is pinned separately below.
  const first = updateFlakeBaseline({ files, environment: ENV, baselinePath: path, recording: true });

  expect(first.load).toBe("parallel");
  expect(first.classified).toEqual([
    {
      testId: "tests/audit/heavy.test.mjs > detects the cycle",
      recordedStatus: null,
      classification: "unrecognized",
    },
  ]);
  expect(first.wrote).toBe(true);
  expect(readBaseline(path).environments[environmentKey(ENV)].tests).toHaveProperty(
    "tests/audit/heavy.test.mjs > detects the cycle",
  );
});

// ─── The write is a deliberate act, not a side effect of running tests ──────
//
// The record used to be written by EVERY run. That is fail-open in the one
// direction it exists to close: a development run is red exactly when you are
// mid-change, so an in-progress regression got filed as evidence in the artifact
// that decides what counts as a known flake — and staged by a routine
// `git add -A`. Observed three times; the last recorded two genuine regressions,
// one of them as `parallel_flaky`, the status that explains a red away.

test("an ordinary run does NOT write the baseline, even having observed a failure", () => {
  const path = tempBaselinePath();
  const files = wholeSuite(fakeFile("/repo/tests/audit/heavy.test.mjs", [["detects the cycle", "fail"]], "fail"));
  const result = updateFlakeBaseline({ files, environment: ENV, baselinePath: path, recording: false });

  expect(result.wrote).toBe(false);
  expect(() => readFileSync(path, "utf8")).toThrow();
  // Not silently dropped — the run says what it saw and how to record it.
  expect(result.pendingObservations).toBe(true);
});

test("classification still runs when recording is off — reading is safe, writing is not", () => {
  const path = tempBaselinePath();
  const files = wholeSuite(fakeFile("/repo/tests/audit/heavy.test.mjs", [["detects the cycle", "fail"]], "fail"));
  const result = updateFlakeBaseline({ files, environment: ENV, baselinePath: path, recording: false });

  // The whole diagnostic value of the record is on the READ side; gating the
  // write must not cost it.
  expect(result.classified).toEqual([
    {
      testId: "tests/audit/heavy.test.mjs > detects the cycle",
      recordedStatus: null,
      classification: "unrecognized",
    },
  ]);
});

test("a green run reports nothing pending, so the notice cannot become background noise", () => {
  const path = tempBaselinePath();
  const result = updateFlakeBaseline({ files: wholeSuite(), environment: ENV, baselinePath: path, recording: false });
  expect(result.wrote).toBe(false);
  expect(result.pendingObservations).toBe(false);
});

test("recording is opt-in through one named env var, and only the exact value enables it", () => {
  expect(RECORD_ENV_VAR).toBe("AUDIT_TOOLS_RECORD_FLAKE_BASELINE");
  expect(recordingEnabled({})).toBe(false);
  expect(recordingEnabled({ [RECORD_ENV_VAR]: "" })).toBe(false);
  expect(recordingEnabled({ [RECORD_ENV_VAR]: "0" })).toBe(false);
  expect(recordingEnabled({ [RECORD_ENV_VAR]: "true" })).toBe(false);
  expect(recordingEnabled({ [RECORD_ENV_VAR]: "1" })).toBe(true);
});
