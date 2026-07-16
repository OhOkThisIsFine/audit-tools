import { test, expect, describe } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// G3 commit A′ — the autonomous_mode-keyed reconciliation gate.
//
// The owner's constraint: "the user must confirm model choices." A backend that
// becomes reachable AFTER the operator confirmed their route decision must not
// silently become dispatchable. The gate:
//   - attended   → re-open the obligation + prompt the DELTA
//   - autonomous → fail-closed-exclude the new backend + a friction event
//
// These pin the two halves the gate cannot work without: consume-and-invalidate
// (without it the gate never fires at all) and the fail-closed autonomous write
// (without persistence it is a PRIORITY[0] drain livelock).
// ---------------------------------------------------------------------------

const {
  sharedProviderConfirmationPath,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readSharedProviderConfirmation,
  readProviderConfirmationInput,
  unlinkProviderConfirmationInput,
  resolveAutonomousMode,
  frictionCapturePath,
  PROVIDER_CONFIRMATION_INPUT_FILENAME,
  PROVIDER_CONFIRMATION_INPUT_VERSION,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
} = await import("audit-tools/shared");

const { runProviderConfirmationAutoComplete } = await import(
  "../../src/audit/orchestrator/intakeExecutors.ts"
);
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.ts");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { buildAuditObligations } = await import("../../src/audit/cli/nextStepHelpers.ts");

// No CLAUDECODE/CODEX so the self-spawn guard never perturbs discovery.
const CLEAN_ENV = {};

async function withTempRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), "g3-reconcile-"));
  try {
    const artifactsDir = join(dir, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    return await fn(dir, artifactsDir);
  } finally {
    // Windows teardown hardening only. The friction capture IS awaited (see the
    // friction test below), but other writes under `.audit-tools/` — the file locks
    // the atomic writer takes — can still be settling when the OS is asked to rmdir,
    // which surfaces as ENOTEMPTY/EBUSY. Retry rather than sleep: it is a teardown
    // race, not a product defect, and a fixed sleep would be both slower and still
    // racy under suite load.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function writeInput(artifactsDir, body) {
  await writeFile(
    join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME),
    JSON.stringify({ schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION, ...body }),
    "utf8",
  );
}

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

// ── resolveAutonomousMode (lifted to shared for this gate) ───────────────────

describe("resolveAutonomousMode — the gate's key", () => {
  test("defaults to FALSE: attended unless autonomy is explicitly requested", () => {
    expect(resolveAutonomousMode({ env: {} })).toBe(false);
    expect(resolveAutonomousMode({ sessionConfig: {}, env: {} })).toBe(false);
    expect(resolveAutonomousMode({ sessionConfig: null, env: {} })).toBe(false);
  });

  test("sessionConfig.autonomous_mode wins over the env var (both directions)", () => {
    expect(
      resolveAutonomousMode({
        sessionConfig: { autonomous_mode: true },
        env: { AUDIT_TOOLS_AUTONOMOUS: "false" },
      }),
    ).toBe(true);
    expect(
      resolveAutonomousMode({
        sessionConfig: { autonomous_mode: false },
        env: { AUDIT_TOOLS_AUTONOMOUS: "true" },
      }),
    ).toBe(false);
  });

  test("falls back to AUDIT_TOOLS_AUTONOMOUS when the config is silent", () => {
    expect(resolveAutonomousMode({ env: { AUDIT_TOOLS_AUTONOMOUS: "true" } })).toBe(true);
    expect(resolveAutonomousMode({ env: { AUDIT_TOOLS_AUTONOMOUS: "false" } })).toBe(false);
    // Only the exact strings flip it — a stray value must not read as autonomous.
    expect(resolveAutonomousMode({ env: { AUDIT_TOOLS_AUTONOMOUS: "1" } })).toBe(false);
    expect(resolveAutonomousMode({ env: { AUDIT_TOOLS_AUTONOMOUS: "yes" } })).toBe(false);
  });
});

// ── 2a: consume-and-invalidate ──────────────────────────────────────────────

describe("consume-and-invalidate — what makes the gate able to fire twice", () => {
  // WITHOUT this, the gate never fires at all: a later delta re-opens the
  // obligation, the CLI finds the OLD submission still on disk, routes to the
  // executor instead of prompting, and folds the new backend in with
  // `excluded: false` — silently dispatching what the operator never confirmed.
  test("a promoted input is DELETED (a stale submission cannot answer a new delta)", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      await writeInput(artifactsDir, { dispatch_bias: 0.5 });
      const inputPath = join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME);
      expect(await exists(inputPath), "precondition: the submission is on disk").toBe(true);

      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {});

      expect(await exists(inputPath), "the spent submission is invalidated").toBe(false);
      // It was genuinely promoted first, not just deleted.
      const read = await readSharedProviderConfirmation(root);
      expect(read.dispatch_bias, "the operator's λ reached the artifact").toBe(0.5);
    });
  });

  test("unlinkProviderConfirmationInput is idempotent and never throws when absent", async () => {
    await withTempRoot(async (_root, artifactsDir) => {
      await expect(unlinkProviderConfirmationInput(artifactsDir)).resolves.toBeUndefined();
      await writeInput(artifactsDir, {});
      await unlinkProviderConfirmationInput(artifactsDir);
      expect(await readProviderConfirmationInput(artifactsDir)).toBe(null);
      await expect(unlinkProviderConfirmationInput(artifactsDir)).resolves.toBeUndefined();
    });
  });
});

// ── 2: the autonomous fail-closed branch ────────────────────────────────────

describe("autonomous fail-closed exclusion", () => {
  // A fresh gate per test — it is MUTABLE (the executor clears it), so sharing one
  // between tests would let a promotion in one silently empty the next.
  const autonomousGate = () => ({
    newlyReachable: [
      {
        key: "brand-new-model",
        provider: "openai-compatible",
        exclusion_pattern: "openai-compatible:brand-new-model",
      },
    ],
    autonomous: true,
  });

  test("a newly-reachable backend is EXCLUDED, not silently dispatched", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, autonomousGate());

      const read = await readSharedProviderConfirmation(root);
      expect(
        read.policy?.exclude,
        "the unconfirmed backend is ruled out on the operator's behalf — at MODEL " +
          "granularity (A″), so the backend's sibling models stay routable",
      ).toEqual(["openai-compatible:brand-new-model"]);
    });
  });

  // THE anti-livelock property. `provider_confirmation` is PRIORITY[0], so a delta
  // that never clears re-selects the obligation forever: autonomous re-promotes until
  // `advance` throws on maxTransitions; attended re-prompts a delta that is now a lie.
  // The gate is mutable precisely so the promotion can clear it.
  test("a successful promotion CLEARS the gate (no PRIORITY[0] livelock)", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const gate = autonomousGate();
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, gate);
      expect(
        gate.newlyReachable,
        "CONFIRMED now covers the backend, so the delta must be empty",
      ).toEqual([]);
    });
  });

  // Without a root the shared artifact — the only one dispatch reads — is never
  // written, so nothing was promoted and the delta is NOT resolved. Clearing the gate
  // here would lose the reconciliation silently.
  test("a NON-promotion (no root) leaves the gate intact", async () => {
    await withTempRoot(async (_root, artifactsDir) => {
      const gate = autonomousGate();
      await runProviderConfirmationAutoComplete({}, undefined, artifactsDir, {}, gate);
      expect(gate.newlyReachable).toHaveLength(1);
    });
  });

  test("it is LOUD: a newly_reachable_backend friction event is recorded", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, autonomousGate());
      // No polling: this capture is AWAITED by the executor (unlike the other
      // reactive captures), precisely so the fact cannot be lost when the CLI emits
      // its step and exits. If this ever needs a sleep to pass, that guarantee broke.
      const frictionPath = frictionCapturePath(artifactsDir, "provider-confirmation");
      expect(await exists(frictionPath), "the operator can find out this happened").toBe(true);
      const body = JSON.stringify(JSON.parse(await readFile(frictionPath, "utf8")));
      expect(body).toContain("brand-new-model");
      expect(body).toContain("newly_reachable_backend");
    });
  });

  test("the summary names what was excluded (not the generic headless line)", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, autonomousGate());
      expect(result.progress_summary).toMatch(/fail-closed/i);
      expect(result.progress_summary).toContain("brand-new-model");
    });
  });

  // The no-silent-honor property, enforced in the EXECUTOR rather than resting on the
  // caller's branch. `autonomous` decides who gets ASKED (the CLI prompts on an
  // attended run); it can never make silently INCLUDING an unconfirmed backend
  // correct. So an attended promotion with a delta and no submission — i.e. a caller
  // that skipped the prompt, which is exactly the bug the gate exists to catch — must
  // still fail closed, not fold the backend in.
  test("attended with NO submission still fails closed (never silently honored)", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const gate = { ...autonomousGate(), autonomous: false };
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, gate);

      const read = await readSharedProviderConfirmation(root);
      expect(
        read.policy?.exclude,
        "no operator decision covers it ⇒ it must not become dispatchable",
      ).toContain("openai-compatible:brand-new-model");
    });
  });

  // The attended path's whole point: the gate prompts the delta and the operator
  // answers. Their submission IS the decision and must supersede the fail-closed
  // default — otherwise the tool would exclude what they just confirmed.
  test("an operator submission SUPERSEDES the fail-closed exclusion", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      // A submission that explicitly excludes something ELSE — so `policy.exclude` is
      // genuinely present and the assertion cannot pass merely by policy being absent.
      await writeInput(artifactsDir, { exclude: ["worker-command"] });
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, autonomousGate());

      const read = await readSharedProviderConfirmation(root);
      expect(read.policy?.exclude, "the operator's own exclusion is honored").toContain(
        "worker-command",
      );
      expect(
        read.policy?.exclude,
        "the operator accepted the new backend — the tool must not overrule them",
      ).not.toContain("openai-compatible:brand-new-model");
    });
  });

  test("an empty delta leaves the ordinary confirmation untouched", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, {
        newlyReachable: [],
        autonomous: true,
      });
      const read = await readSharedProviderConfirmation(root);
      expect(read.policy?.exclude).toBe(undefined);
      expect(result.progress_summary).not.toMatch(/fail-closed/i);
    });
  });
});

// ── the SELECTION wiring: does the gate actually reach an executor? ─────────
//
// This is the half that matters and the half that is easy to get wrong: four prior
// plan drafts specified gates that could never fire. A delta that re-opens the
// obligation but does not change which EXECUTOR gets dispatched is a no-op with a
// convincing-looking derive.

describe("gate → obligation → executor selection", () => {
  const DELTA = ["brand-new-model"];
  const confirmedBundle = () => ({
    provider_confirmation: {
      schema_version: PROVIDER_CONFIRMATION_RESULT_VERSION,
      confirmed_at: new Date().toISOString(),
      session_level: true,
      provider_pool: [
        { name: "worker-command", capability_tier: "unknown", excluded: false },
      ],
    },
  });

  test("no delta ⇒ a present confirmation is satisfied (presence-only, unchanged)", () => {
    const state = deriveAuditState(confirmedBundle());
    const o = state.obligations.find((x) => x.id === "provider_confirmation");
    expect(o.state).toBe("satisfied");
  });

  test("a delta RE-OPENS the obligation on an already-confirmed bundle", () => {
    const state = deriveAuditState(confirmedBundle(), {
      newlyReachableBackends: DELTA,
    });
    const o = state.obligations.find((x) => x.id === "provider_confirmation");
    expect(o.state, "reachable-but-unconfirmed ⇒ not satisfied").toBe("stale");
    expect(o.reason, "the reason names what must be reconciled").toContain(
      "brand-new-model",
    );
  });

  // The blocker this pins: `provider_confirmation` is PRIORITY[0], so re-opening it
  // must make the SELECTION land on its executor. A gate-blind decide anywhere on the
  // path selects the next obligation instead and dispatches the wrong runner — the
  // gate then never fires at all, silently.
  test("a delta makes decideNextStep select the provider_confirmation EXECUTOR", () => {
    const decision = decideNextStep(confirmedBundle(), {
      newlyReachableBackends: DELTA,
    });
    expect(decision.selected_obligation).toBe("provider_confirmation");
    expect(decision.selected_executor).toBe("provider_confirmation_executor");
  });

  test("without the delta the SAME bundle selects something else entirely", () => {
    const decision = decideNextStep(confirmedBundle());
    expect(decision.selected_obligation).not.toBe("provider_confirmation");
  });

  // The tests above pin `decideNextStep`'s CONTRACT. These pin the WIRING — that
  // `advanceAudit` actually threads the gate into its own decide + nested drain.
  // Without these, the whole gate can be dead while every unit test above is green:
  // `advanceAudit` re-decides internally and dispatches whatever IT selects, so a
  // gate-blind decide there sends the run to a different executor entirely and the
  // reconciliation silently never happens.
  // The ATTENDED response to a delta is to ASK, not to promote. This pins the
  // CLI-side half of the gate: with a delta and no submission the obligation must
  // emit the confirmation step and wait, never fold to the executor. (The executor
  // independently refuses to silently honor — see the fail-closed suite — so the two
  // halves are belt and braces, and both are pinned.)
  test("attended + delta + no submission ⇒ EMITS the prompt (does not promote)", async () => {
    await withTempRoot(async (_root, artifactsDir) => {
      const defs = buildAuditObligations({
        newlyReachable: [
      {
        key: "brand-new-model",
        provider: "openai-compatible",
        exclusion_pattern: "openai-compatible:brand-new-model",
      },
    ],
        autonomous: false,
      });
      const def = defs.find((d) => d.id === "provider_confirmation");
      const outcome = await def.execute(confirmedBundle(), {
        params: { artifactsDir },
      });
      expect(outcome.kind, "attended ⇒ ask the operator").toBe("emit");
      expect(outcome.step.kind).toBe("provider_confirmation");
      const o = outcome.step.state.obligations.find(
        (x) => x.id === "provider_confirmation",
      );
      expect(o.state, "and the obligation stays open until they answer").toBe("stale");
    });
  });

  // Asserted on EFFECTS, not `selected_executor`: `advanceAudit` DRAINS, so its
  // returned executor is the last one in the fold, not the first. The effects are the
  // stronger assertion anyway — they are what a gate-blind decide would omit.
  test("advanceAudit reconciles the delta AND converges (gate-blind ⇒ neither happens)", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      // A real file so the drain's downstream intake has something to chew on and the
      // fold does not abort before proving convergence.
      await writeFile(join(root, "index.js"), "export const x = 1;\n", "utf8");
      const gate = {
        newlyReachable: [
      {
        key: "brand-new-model",
        provider: "openai-compatible",
        exclusion_pattern: "openai-compatible:brand-new-model",
      },
    ],
        autonomous: true,
      };
      // If the gate never cleared, this PRIORITY[0] obligation would be re-selected
      // every fold until the graceful MAX_DRAIN_STEPS cap bailed out — so the
      // assertion that catches it is the cleared gate below, not a throw.
      await advanceAudit(confirmedBundle(), {
        root,
        artifactsDir,
        providerConfirmationGate: gate,
      });
      // Gate-blind ⇒ provider_confirmation reads satisfied ⇒ its executor never runs
      // ⇒ no exclusion is ever written and the delta is never resolved.
      const read = await readSharedProviderConfirmation(root);
      expect(
        read?.policy?.exclude,
        "advanceAudit must thread the gate into its OWN decide, or the gate is dead",
      ).toContain("openai-compatible:brand-new-model");
      expect(gate.newlyReachable, "the promotion cleared the delta").toEqual([]);
    });
  });
});

// ── the reach-free read (G3 step 1: the live bug 2 fix) ─────────────────────

describe("policy is not gated by reach (bug 2)", () => {
  // The former roster gate discarded the operator's cost order + λ whenever the
  // reachable set shifted, on the false premise that they are reach-derived. They
  // are POLICY — "the operator may reorder" — and must survive.
  test("cost order + λ survive a reach shift (they are the operator's decision)", async () => {
    await withTempRoot(async (root) => {
      const built = buildSharedProviderConfirmation({}, CLEAN_ENV);
      await writeSharedProviderConfirmation(root, { ...built, dispatch_bias: 0.75 });

      const { readConfirmedCostPositions, readConfirmedDispatchBias } = await import(
        "audit-tools/shared"
      );
      // No session config / env is even passed any more — reach cannot gate this.
      expect(await readConfirmedDispatchBias(root)).toBe(0.75);
      expect(await readConfirmedCostPositions(root)).toBeInstanceOf(Map);
    });
  });
});
