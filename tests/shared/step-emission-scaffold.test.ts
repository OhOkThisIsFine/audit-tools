/**
 * step-emission-scaffold.test.ts
 *
 * The ONE shared table-driven step-emission scaffold
 * (`src/shared/steps/stepEmissionScaffold.ts`), owned by the audit orchestrator
 * entry point and shaped to carry the contract pipeline's numbered gates too.
 *
 * Obligations pinned here:
 *   - INV-AOE-SCAFFOLD-OWNER — exactly ONE step-emission scaffold module exists
 *     under `src/`, both orchestrator shapes are expressible on it, and every
 *     public entry point writes + logs through a SINGLE emission call site
 *     (a second, independent emission site is exactly what this refuses).
 *   - INV-AOE-HANDLED-KINDS-EXPORT — the handled-key set is derived from the
 *     table's own keys, so adding a row grows it with no edit to any literal.
 *
 * UNCOVERED HALF, stated rather than implied: the contract-pipeline side has
 * NOT adopted the scaffold yet (that is CP-NODE-13). What IS enforced today is
 * the property that makes the phased adoption safe — that no SECOND scaffold
 * exists anywhere in `src/`, so the two adopters cannot land two scaffolds one
 * phase apart. The "both orchestrators import it" half becomes assertable only
 * when CP-NODE-13 lands, and the assertion below names that explicitly.
 */
import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTsFiles } from "./testFileUtils.js";
import {
  createStepEmissionScaffold,
  type StepGateHandler,
} from "../../src/shared/steps/stepEmissionScaffold.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const SRC = join(REPO_ROOT, "src");
const SCAFFOLD_MODULE = join(SRC, "shared", "steps", "stepEmissionScaffold.ts");
const AUDIT_ENTRY = join(SRC, "audit", "cli", "nextStepCommand.ts");

/** A plan is whatever the adopter says it is — the scaffold never inspects it. */
interface TestPlan {
  from: string;
}
interface TestCtx {
  applicable: string[];
}
interface TestStep {
  written: string;
}

/** A scaffold instrumented so every write and every log is counted. */
function harness(
  table: Record<string, StepGateHandler<TestCtx, TestPlan>>,
  fallbackFrom = "fallback",
) {
  const writes: TestPlan[] = [];
  const logs: TestStep[] = [];
  const scaffold = createStepEmissionScaffold<TestCtx, TestPlan, TestStep>({
    table,
    fallback: () => ({ from: fallbackFrom }),
    write: (plan) => {
      writes.push(plan);
      return { written: plan.from };
    },
    log: (step) => {
      logs.push(step);
    },
  });
  return { scaffold, writes, logs };
}

const gate =
  (name: string): StepGateHandler<TestCtx, TestPlan> =>
  (ctx) =>
    ctx.applicable.includes(name) ? { from: name } : null;

// ── The single emission call site ────────────────────────────────────────────

test("a keyed dispatch writes the step exactly once and logs it exactly once", async () => {
  const { scaffold, writes, logs } = harness({
    alpha: () => ({ from: "alpha" }),
    beta: () => ({ from: "beta" }),
  });

  const step = await scaffold.emit("alpha", { applicable: [] });

  expect(step).toEqual({ written: "alpha" });
  expect(writes).toEqual([{ from: "alpha" }]);
  expect(logs).toEqual([{ written: "alpha" }]);
});

test("EVERY handled key emits exactly one written, one logged step", async () => {
  const keys = ["alpha", "beta", "gamma", "delta"];
  const table = Object.fromEntries(
    keys.map((key) => [key, () => ({ from: key })]),
  ) as Record<string, StepGateHandler<TestCtx, TestPlan>>;

  for (const key of keys) {
    const { scaffold, writes, logs } = harness(table);
    await scaffold.emit(key, { applicable: [] });
    expect(writes.length, `${key}: exactly one write`).toBe(1);
    expect(logs.length, `${key}: exactly one log`).toBe(1);
    expect(writes[0]).toEqual({ from: key });
  }
});

test("an unhandled key takes the fallback — never a silent no-emission", async () => {
  const { scaffold, writes, logs } = harness({ alpha: () => ({ from: "alpha" }) });

  const step = await scaffold.emit("not_in_the_table", { applicable: [] });

  expect(step).toEqual({ written: "fallback" });
  expect(writes.length).toBe(1);
  expect(logs.length).toBe(1);
});

test("a row that declines (returns null) falls back rather than emitting nothing", async () => {
  const { scaffold, writes } = harness({ alpha: () => null });

  await scaffold.emit("alpha", { applicable: [] });

  expect(writes).toEqual([{ from: "fallback" }]);
});

test("null and undefined are the SAME decline on both entry points", async () => {
  // One predicate (`plan == null`), or the two entry points disagree: `emit`
  // would fall back on an undefined plan while the gate walk emitted it.
  for (const declined of [null, undefined]) {
    const keyed = harness({ alpha: () => declined });
    await keyed.scaffold.emit("alpha", { applicable: [] });
    expect(keyed.writes, `emit: ${String(declined)} declines`).toEqual([
      { from: "fallback" },
    ]);

    const walked = harness({
      gate1: () => declined,
      gate2: () => ({ from: "gate2" }),
    });
    await walked.scaffold.emitFirstApplicable(["gate1", "gate2"], {
      applicable: [],
    });
    expect(
      walked.writes,
      `emitFirstApplicable: ${String(declined)} hands on to the next gate`,
    ).toEqual([{ from: "gate2" }]);
  }
});

test("a step key that collides with an Object.prototype member takes the fallback, never a built-in", async () => {
  // The dispatch table must not resolve through the prototype chain: step keys
  // are DATA. With an inherited `toString`, `emit("toString")` would dispatch a
  // built-in — writing "[object Undefined]" as if it were a plan — while
  // `handledKeys` (own keys only) said the key was not handled.
  const { scaffold, writes, logs } = harness({ alpha: () => ({ from: "alpha" }) });

  expect(scaffold.handledKeys.has("toString")).toBe(false);
  const step = await scaffold.emit("toString", { applicable: [] });

  expect(step).toEqual({ written: "fallback" });
  expect(writes).toEqual([{ from: "fallback" }]);
  expect(logs.length).toBe(1);

  // …and the ordered walk refuses it as the configuration gap it is.
  await assert.rejects(
    () => scaffold.emitFirstApplicable(["toString"], { applicable: [] }),
    /not in the emission table/,
  );
});

test("emitPlan reaches the SAME single site — write once, log once", async () => {
  const { scaffold, writes, logs } = harness({ alpha: () => ({ from: "alpha" }) });

  const step = await scaffold.emitPlan({ from: "pre-dispatch" });

  expect(step).toEqual({ written: "pre-dispatch" });
  expect(writes.length).toBe(1);
  expect(logs.length).toBe(1);
});

test("the writer is awaited and its step — not the plan — is what gets logged", async () => {
  const logged: unknown[] = [];
  const scaffold = createStepEmissionScaffold<TestCtx, TestPlan, TestStep>({
    table: { alpha: () => ({ from: "alpha" }) },
    fallback: () => ({ from: "fallback" }),
    write: async (plan) => {
      await Promise.resolve();
      return { written: `${plan.from}!` };
    },
    log: (step) => logged.push(step),
  });

  await scaffold.emit("alpha", { applicable: [] });

  expect(logged).toEqual([{ written: "alpha!" }]);
});

// ── The contract-pipeline shape: numbered early-return gates ─────────────────

test("emitFirstApplicable emits the FIRST applicable gate and no other", async () => {
  const { scaffold, writes, logs } = harness({
    gate1: gate("gate1"),
    gate2: gate("gate2"),
    gate3: gate("gate3"),
  });

  const step = await scaffold.emitFirstApplicable(
    ["gate1", "gate2", "gate3"],
    { applicable: ["gate2", "gate3"] },
  );

  expect(step).toEqual({ written: "gate2" });
  expect(writes.length).toBe(1);
  expect(logs.length).toBe(1);
});

test("emitFirstApplicable falls back when every gate declines", async () => {
  const { scaffold, writes } = harness({
    gate1: gate("gate1"),
    gate2: gate("gate2"),
  });

  await scaffold.emitFirstApplicable(["gate1", "gate2"], { applicable: [] });

  expect(writes).toEqual([{ from: "fallback" }]);
});

test("a gate named in the walk order but absent from the table is a loud configuration gap", async () => {
  const { scaffold, writes } = harness({ gate1: gate("gate1") });

  await assert.rejects(
    () => scaffold.emitFirstApplicable(["gate1", "ghost"], { applicable: [] }),
    /not in the emission table/,
  );
  // The gap must not have emitted the fallback as if the gate had declined.
  expect(writes.length).toBe(0);
});

// ── The handled-key set is derived from the table's own keys ─────────────────

test("handledKeys is the table's own key set — adding a row grows it with no literal to edit", () => {
  const before = harness({ alpha: () => ({ from: "alpha" }) }).scaffold;
  expect([...before.handledKeys].sort()).toEqual(["alpha"]);

  const after = harness({
    alpha: () => ({ from: "alpha" }),
    beta: () => ({ from: "beta" }),
  }).scaffold;
  expect([...after.handledKeys].sort()).toEqual(["alpha", "beta"]);
});

test("handledKeys is snapshotted, so a later mutation of the caller's object cannot make it lie", async () => {
  const table: Record<string, StepGateHandler<TestCtx, TestPlan>> = {
    alpha: () => ({ from: "alpha" }),
  };
  const { scaffold, writes } = harness(table);

  table.beta = () => ({ from: "beta" });

  expect([...scaffold.handledKeys]).toEqual(["alpha"]);
  await scaffold.emit("beta", { applicable: [] });
  expect(writes, "a key added after construction is not dispatched").toEqual([
    { from: "fallback" },
  ]);
});

// ── Exactly one scaffold, one owner ──────────────────────────────────────────

test("exactly ONE step-emission scaffold module exists under src/", () => {
  // Scanned as a NAME FAMILY, not one literal identifier: keying on
  // `createStepEmissionScaffold` alone would wave through a
  // `createGateEmissionScaffold` sibling — a second scaffold under a
  // near-miss name is the likeliest way the two adopters land two of these.
  const familyExport = /export\s+(?:async\s+)?function\s+\w*EmissionScaffold\w*\b/;
  // Shape, independent of naming: a module that both carries a handler table
  // and owns a write+log emission member IS a step-emission scaffold whatever
  // it calls itself.
  const shapeTable = /\btable\s*[:?]/;
  const shapeEmission = /\bwrite\s*[:(]/;
  const shapeLog = /\blog\s*[:(]/;

  const definers = collectTsFiles(SRC).filter((file) => {
    const source = readFileSync(file, "utf8");
    if (familyExport.test(source)) return true;
    return (
      /export\s+function\s+create\w*Scaffold\b/.test(source) &&
      shapeTable.test(source) &&
      shapeEmission.test(source) &&
      shapeLog.test(source)
    );
  });

  expect(
    definers.map((file) => relative(REPO_ROOT, file).replaceAll("\\", "/")),
    "a second scaffold would be the add-then-delete-across-commits shape the atomic-replace rule forbids",
  ).toEqual(["src/shared/steps/stepEmissionScaffold.ts"]);

  // RESIDUAL, stated rather than implied: a fully-renamed clone (no
  // `…EmissionScaffold` export, no `create…Scaffold` factory) is not detectable
  // by any source scan. That half rides the one-core convention and review, not
  // this test.
});

test("the audit orchestrator entry point drives its emission through the shared scaffold", () => {
  const source = readFileSync(AUDIT_ENTRY, "utf8");
  expect(source).toMatch(
    /import \{ createStepEmissionScaffold \} from "\.\.\/\.\.\/shared\/steps\/stepEmissionScaffold\.js";/,
  );
  // CP-NODE-13 adopts the scaffold on the contract-pipeline side. Until it
  // lands, the enforceable half is that no SECOND scaffold exists (asserted
  // above) — this test is the home the pipeline-side import assertion joins.
  // The scaffold must already carry the pipeline's numbered-gate shape.
  expect(readFileSync(SCAFFOLD_MODULE, "utf8")).toMatch(/emitFirstApplicable/);
});
