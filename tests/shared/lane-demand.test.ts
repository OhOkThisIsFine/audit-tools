/**
 * The emitted-lane demand ranking NAMES DEMAND, never an execution choice.
 *
 * `src/shared/types/stepContract.ts` states the ranking for both draws and cites
 * this file by name as the mechanical refusal of a provider-shaped field. The
 * boundary it guards is the one the whole package is built under: audit-tools
 * characterizes work (size, judgment, stakes) and the HOST picks the backend,
 * the model, the tier and the lane. A `model`, `provider`, `tier` or `backend`
 * key on the emitted lane moves that choice back into the tool one convenient
 * field at a time — the same failure the submission contract's sizing ban
 * (`tests/shared/submission-contract-has-no-sizing-identity.test.ts`) closes on
 * its own substrate.
 *
 * Three forms, because any one alone is escapable:
 *   1. runtime  — drive the REAL `deriveLaneDemand` producer and walk what it
 *      emits (a hand-written literal would only prove the literal is clean);
 *   2. schema   — the real `LaneDemandSchema` must REFUSE an extra key, so the
 *      refusal holds for any future caller, not just the ones exercised here;
 *   3. source   — the vocabulary module must not carry the retired
 *      execution-identity identifiers even in a field no test constructs.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";

import {
  LANE_COMPLEXITY_VALUES,
  LANE_DEMAND_KEYS,
  LANE_RISK_VALUES,
  LANE_SIZE_VALUES,
  LaneDemandSchema,
  deriveLaneDemand,
} from "../../src/shared/types/stepContract.js";
import { prepareAuditHostHandoff } from "../../src/audit/cli/dispatch/hostHandoff.js";
import { materializeFanoutLanes } from "../../src/audit/cli/fanoutLanes.js";
import { AUDIT_GATE_SUBMISSION_SCOPE } from "../../src/audit/cli/laneSubmissions.js";
import {
  BANNED_LANE_EXECUTION_KEY,
  bannedLaneExecutionKeys,
  bannedSizingIdentifierLines,
  bannedSizingKeys,
} from "../helpers/recognizers.js";

/** Every input pair the ranking is total over: [tokenEstimate, fileCount, riskScore]. */
const DEMAND_INPUTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 1, 0.01],
  [2_999, 3, 1 / 3],
  [3_000, 4, 2 / 3],
  [11_999, 11, 1],
  [120_000, 400, 1],
  // Non-finite and out-of-band inputs: the ranking is TOTAL, so a draw that
  // hands it a `NaN` estimate gets an honest `small` rather than a crash or a
  // phantom rank.
  [Number.NaN, Number.NaN, Number.NaN],
  [Number.POSITIVE_INFINITY, 0, 2],
  [-5, -5, -1],
];

describe("the emitted-lane demand ranking names demand only", () => {
  it("emits exactly the demand key set, at every band", () => {
    for (const [tokenEstimate, fileCount, riskScore] of DEMAND_INPUTS) {
      const demand = deriveLaneDemand({ tokenEstimate, fileCount, riskScore });
      expect(Object.keys(demand).sort(), `${tokenEstimate}/${fileCount}`).toEqual(
        [...LANE_DEMAND_KEYS].sort(),
      );
      expect(LANE_SIZE_VALUES).toContain(demand.size);
      expect(LANE_COMPLEXITY_VALUES).toContain(demand.complexity);
      expect(LANE_RISK_VALUES).toContain(demand.risk);
    }
  });

  it("nothing the real producer emits carries an execution-choice key", () => {
    for (const [tokenEstimate, fileCount, riskScore] of DEMAND_INPUTS) {
      const emitted = deriveLaneDemand({ tokenEstimate, fileCount, riskScore });
      expect(bannedSizingKeys(emitted)).toEqual([]);
      expect(bannedLaneExecutionKeys(emitted)).toEqual([]);
    }
  });

  it("the SCHEMA itself refuses a provider-shaped field, whatever the caller", () => {
    // The residual escape from the producer walk above: a field on the SHAPE
    // that no exercised input happens to reach. `.strict()` is what makes the
    // refusal hold for every caller — including one this file never builds.
    const valid = { size: "small", complexity: "focused", risk: "low" };
    expect(LaneDemandSchema.safeParse(valid).success).toBe(true);
    for (const extra of ["model", "provider", "tier", "backend", "lane", "pool"]) {
      expect(
        LaneDemandSchema.safeParse({ ...valid, [extra]: "x" }).success,
        `LaneDemandSchema admitted a \`${extra}\` field`,
      ).toBe(false);
      expect(LaneDemandSchema.safeParse({ ...valid, [extra]: undefined }).success).toBe(false);
    }
  });

  it("the vocabulary module carries no retired execution identity", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "shared", "types", "stepContract.ts"),
      "utf8",
    );
    // Comments are stripped by the recognizer, so the module may NAME the keys
    // it bans (its header does) without tripping this.
    const bannedKeys = bannedSizingKeys(
      Object.fromEntries(LANE_DEMAND_KEYS.map((key) => [key, ""])),
    );
    expect(bannedSizingIdentifierLines(source)).toEqual([]);
    expect(bannedKeys).toEqual([]);
    for (const key of LANE_DEMAND_KEYS) {
      expect(BANNED_LANE_EXECUTION_KEY.test(key), `demand key \`${key}\``).toBe(false);
    }
  });
});

// ── the REAL emitting step contract, driven end to end ───────────────────────
//
// The schema walk above pins the SHAPE; this drives the audit draw's real
// dispatch producer and walks the lanes it actually writes to disk. The two are
// not the same claim: a draw could satisfy the schema and still bolt an
// execution-choice field onto the surrounding item, which is where such a field
// would land (metadata sits beside `prompt` and `result_path`, not inside
// `demand`).
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("the audit draw's emitted lane names demand only", () => {
  it("every published work item carries the demand ranking and nothing execution-shaped", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-demand-audit-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\n", "utf8");

    const prepared = await prepareAuditHostHandoff({
      root,
      artifactsDir: join(root, ".audit-tools", "audit"),
      runId: "lane-demand-run",
      tasks: [
        {
          task_id: "audit-demand-1",
          unit_id: "unit-1",
          pass_id: "pass:correctness",
          lens: "correctness",
          file_paths: ["src/a.ts"],
          file_line_counts: { "src/a.ts": 2 },
          rationale: "Review src/a.ts",
          priority: "medium",
          demand: deriveLaneDemand({ tokenEstimate: 1_200, fileCount: 1, riskScore: 0.5 }),
          token_estimate: 1_200,
        },
      ],
    });

    expect(prepared.workload.work_items.length).toBeGreaterThan(0);
    for (const item of prepared.workload.work_items) {
      // The lane's demand is present and well-formed...
      expect(LaneDemandSchema.safeParse(item.metadata.demand).success).toBe(true);
      // ...and the emitted item, walked whole, carries no execution choice.
      expect(bannedLaneExecutionKeys(item)).toEqual([]);
      expect(bannedLaneExecutionKeys(item.metadata)).toEqual([]);
    }
  });
});

// ── the fan-out lane, which is the OTHER way this package emits a lane ───────
//
// The design-review, charter, conceptual and systemic-challenge lanes never
// become host work items: they are materialized as prompt FILES by
// `materializeFanoutLanes` and executed by whatever the host dispatches. That
// made them a second emitting boundary, and acceptance clause 4 covers every
// emitted lane — so the ranking has to be derived there too, not declared by
// the fifteen-odd emitters that mint them.
describe("the fan-out lane carries the same demand ranking", () => {
  it("derives a schema-valid demand for every materialized lane, from its own prompt", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "lane-demand-fanout-"));
    roots.push(artifactsDir);
    const fanout = await materializeFanoutLanes({
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      lanes: [
        {
          id: "tiny",
          label: "Tiny lane",
          promptFilename: "tiny-prompt.md",
          promptText: "# tiny\n",
        },
        {
          id: "huge",
          label: "Huge lane",
          promptFilename: "huge-prompt.md",
          promptText: "x".repeat(200_000),
        },
        {
          // An un-expected lane (its submission the tool never reads) is just
          // as emitted as any other — a worker still has to be sized for it.
          id: "unexpected",
          label: "Host-side intermediate",
          promptFilename: "unexpected-prompt.md",
          promptText: "y".repeat(50_000),
          expected: false,
        },
      ],
    });

    expect(fanout.lanes.map((lane) => lane.id)).toEqual([
      "tiny",
      "huge",
      "unexpected",
    ]);
    for (const lane of fanout.lanes) {
      expect(LaneDemandSchema.safeParse(lane.demand).success, lane.id).toBe(true);
      // The emitted lane, walked whole, carries no execution choice — this is
      // the boundary at which such a field would land.
      expect(bannedLaneExecutionKeys(lane), lane.id).toEqual([]);
      expect(bannedLaneExecutionKeys(lane.demand), lane.id).toEqual([]);
    }
    // The ranking RESPONDS to the lane's own content, which is what makes it a
    // ranking rather than a constant every lane would share. Both bands come
    // from the prompt text the materializer itself wrote, so no caller can
    // forget to supply them.
    const byId = new Map(fanout.lanes.map((lane) => [lane.id, lane.demand]));
    expect(byId.get("tiny")).toEqual({ size: "small", complexity: "focused", risk: "low" });
    expect(byId.get("huge")!.size).toBe("large");
    expect(byId.get("huge")!.complexity).toBe("deep");
  });

  it("every emitter that renders fan-out execution lines renders the demand with them", () => {
    // The per-emitter half the materializer cannot enforce. A new `emissionRow`
    // that maps `fanout.pendingLanes` down to `{label, promptPath}` would emit a
    // lane whose ranking the host never sees — the ranking would exist on disk
    // and reach nobody. The shape is mechanical here: every render call names
    // its lanes with a `demand:` binding.
    const source = readFileSync(
      join(process.cwd(), "src", "audit", "cli", "nextStepCommand.ts"),
      "utf8",
    );
    const calls = source.split("renderFanoutExecutionLines({").slice(1);
    expect(calls.length, "renderFanoutExecutionLines call sites").toBeGreaterThan(0);
    for (const [index, call] of calls.entries()) {
      expect(call.slice(0, call.indexOf("})")), `call site #${index + 1}`).toContain(
        "demand: lane.demand",
      );
    }
  });
});
