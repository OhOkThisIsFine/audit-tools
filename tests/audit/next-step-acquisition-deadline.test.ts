import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

interface Params {
  timeoutMs: number;
  deadline?: { readonly at: number };
  externalAcquisition?: { enabled: boolean; deadline?: { readonly at: number } };
}

/**
 * Exercise the exact exported invocation wrapper with an inert fold. This pins
 * ownership at the API boundary, without invoking the repository/audit pipeline.
 * No duplicate implementation of the wrapper's budget logic lives in the test.
 */
function boundary() {
  const source = readFileSync(new URL("../../src/audit/cli/nextStepHelpers.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function runDeterministicForNextStep(");
  const end = source.indexOf("\nconst ARCHITECTURE_WORK_STEPS", start);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  const wrapper = stripTypeScriptTypes(source.slice(start, end)).replace("export async function", "async function");
  let now = 1000;
  const observed: Params[] = [];
  const run = new Function("Date", "startAdvanceHeartbeat", "runDeterministicFold", "requireSourceRoot",
    `${wrapper}\nreturn runDeterministicForNextStep;`)(
      { now: () => now }, () => ({ stop() {} }),
      async (params: Params) => {
        observed.push(params);
        // Multiple dispatches in this invocation receive the same absolute value.
        for (let dispatch = 0; dispatch < 3; dispatch++) {
          now += 5;
          expect(params.externalAcquisition!.deadline).toBe(params.deadline);
        }
        return { deadline: params.deadline!.at };
      }, () => "/inert",
    ) as (params: Params) => Promise<{ deadline: number }>;
  return { run, observed, at: (value: number) => { now = value; } };
}

test("reused deadline-less caller options get one fresh budget per invocation without mutation", async () => {
  const fixture = boundary();
  const externalAcquisition = { enabled: true };
  const params: Params = { timeoutMs: 100, externalAcquisition };
  expect((await fixture.run(params)).deadline).toBe(1100);
  fixture.at(2000);
  expect((await fixture.run(params)).deadline).toBe(2100);
  expect(params).toEqual({ timeoutMs: 100, externalAcquisition: { enabled: true } });
  expect(params.externalAcquisition).toBe(externalAcquisition);
  expect(fixture.observed[0]).not.toBe(params);
  expect(fixture.observed[0].externalAcquisition).not.toBe(externalAcquisition);
  expect(fixture.observed[0].deadline).not.toBe(fixture.observed[1].deadline);
});

test.each(["top-level", "acquisition"])("explicit %s absolute deadline remains shared without replacement", async location => {
  const fixture = boundary();
  const deadline = { at: 9000 };
  const params: Params = { timeoutMs: 100, externalAcquisition: { enabled: true } };
  if (location === "top-level") params.deadline = deadline;
  else params.externalAcquisition!.deadline = deadline;
  expect((await fixture.run(params)).deadline).toBe(9000);
  fixture.at(2000);
  expect((await fixture.run(params)).deadline).toBe(9000);
  for (const observed of fixture.observed) expect(observed.deadline).toBe(deadline);
  if (location === "acquisition") expect(params.deadline).toBeUndefined();
});
