import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The scaffold three CLI verbs share. Before it existed each verb hand-rolled the
// same sequence, and NOTHING tested the envelope those copies printed — the CLI
// suites pin only that each module exports a function of that name. So a copy
// could have drifted its key set, its key ORDER, or its git-warning policy and
// stayed green. These pin what the copies agreed on.
const stepCalls: unknown[] = [];
vi.mock("../../src/audit/cli/auditStep.js", () => ({
  runAuditStep: (options: unknown) => {
    stepCalls.push(options);
    return Promise.resolve({
      selected_executor: "intake_executor",
      progress_summary: "1/9 obligations satisfied",
      next_likely_step: "structure_artifacts",
    });
  },
}));

const { runStepCommand, STEP_SCAFFOLD_MODE } = await import(
  "../../src/audit/cli/stepScaffold.js"
);
const { cmdPlan } = await import("../../src/audit/cli/planCommand.js");

let root: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stepCalls.length = 0;
  root = mkdtempSync(join(tmpdir(), "step-scaffold-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const printed = (): string => (logSpy.mock.calls[0]?.[0] as string) ?? "";

describe("runStepCommand", () => {
  it("prints exactly the three envelope keys, in order", async () => {
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "intake_executor",
    });
    const parsed = JSON.parse(printed()) as Record<string, unknown>;
    // Key ORDER, not just membership: the envelope is read by humans and diffed
    // between runs, and JSON.stringify preserves insertion order.
    expect(Object.keys(parsed)).toEqual([
      "artifacts_dir",
      "selected_executor",
      "progress_summary",
    ]);
    expect(parsed.selected_executor).toBe("intake_executor");
    expect(parsed.progress_summary).toBe("1/9 obligations satisfied");
  });

  it("carries next_likely_step NO further than the step result", async () => {
    // cmdPlan prints a fourth key. The scaffold deliberately does not, so a
    // future adopter cannot inherit a field its command never promised.
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "intake_executor",
    });
    expect(JSON.parse(printed())).not.toHaveProperty("next_likely_step");
  });

  it("forwards the forced executor to the step", async () => {
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "synthesis_executor",
    });
    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0]).toMatchObject({ preferredExecutor: "synthesis_executor" });
  });

  it("warns about a non-git root ONLY when the command asks", async () => {
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "intake_executor",
      warnIfNotGit: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("does not appear to be a git repository");
  });

  it("stays silent about a non-git root by default", async () => {
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "synthesis_executor",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn when the root IS a git repository", async () => {
    mkdirSync(join(root, ".git"));
    await runStepCommand(["--root", root], {
      mode: "executor",
      preferredExecutor: "intake_executor",
      warnIfNotGit: true,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ── The MODE is stated, and a differing mode is refused ──────────────────────
//
// `preferredExecutor` is not a runner preference — it is a mode switch. A
// forced executor runs exactly ONE step and bypasses the engine; its absence
// runs the PRIORITY scan and drains the frontier. The scaffold serves the
// forced-executor mode only, and these pin that a command cannot reach the
// other draw by filling in an executor id.

describe("the step-command MODE contract", () => {
  it("states the mode it serves", () => {
    expect(STEP_SCAFFOLD_MODE).toBe("executor");
  });

  it("refuses a drain-mode spec instead of running a forced dispatch", async () => {
    await expect(
      runStepCommand(["--root", root], {
        // The shape a future `cmdPlan` adoption would reach for. It must not
        // resolve to "run the one step the id names".
        mode: "drain",
        preferredExecutor: "plan_executor",
      }),
    ).rejects.toThrow(/asked for "drain"/);

    // Nothing was dispatched: the refusal happens BEFORE the step, so a
    // mismatched mode cannot half-execute.
    expect(stepCalls).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("cmdPlan does not route through the scaffold", async () => {
    // `cmdPlan` is the DRAIN draw — it takes no `preferredExecutor` precisely
    // because supplying one would silently convert the plan draw into a single
    // forced dispatch. Nothing in its signature or source may supply one.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        join(process.cwd(), "src/audit/cli/planCommand.ts"),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/preferredExecutor\s*:/);
    expect(source).not.toMatch(/runStepCommand/);
  });

  it("cmdPlan runs the drain draw: no forced executor reaches runAuditStep", async () => {
    await cmdPlan(["--root", root]);
    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0]).not.toHaveProperty("preferredExecutor");
  });
});
