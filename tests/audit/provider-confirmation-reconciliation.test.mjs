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
  resolveDispatchExclusion,
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
const { renderProviderConfirmationPrompt } = await import(
  "../../src/audit/cli/providerConfirmationStep.ts"
);

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
        key: "openai-compatible:brand-new-model",
        provider: "openai-compatible",
        service: "openai-compatible",
        exclusion_pattern: "transport:openai-compatible/brand-new-model",
        service_exclusion_pattern: "service:openai-compatible/brand-new-model",
      },
    ],
    autonomous: true,
  });

  test("a newly-reachable backend is EXCLUDED via service axis, not silently dispatched", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, autonomousGate());

      const read = await readSharedProviderConfirmation(root);
      expect(
        read.policy?.auto_exclude,
        "the unconfirmed backend is ruled out on the operator's behalf via the service axis",
      ).toEqual(["service:openai-compatible/brand-new-model"]);
      expect(
        read.policy?.exclude ?? [],
        "a gate-authored pattern is never recorded as an operator decision",
      ).not.toContain("service:openai-compatible/brand-new-model");
      expect(
        resolveDispatchExclusion(read.policy, CLEAN_ENV).excludes({
          transport: "openai-compatible",
          model: "brand-new-model",
        }),
        "separating provenance governs lifetime, never whether the pattern bites",
      ).toBe(true);
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
        read.policy?.auto_exclude,
        "no operator decision covers it ⇒ it must not become dispatchable",
      ).toContain("service:openai-compatible/brand-new-model");
    });
  });

  test("fail-closed write emits service: axis pattern to close multi-transport residue durably", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const gate = {
        newlyReachable: [
          {
            key: "nim:z-ai/glm-5.2",
            provider: "claude-worker",
            service: "nim",
            exclusion_pattern: "transport:claude-worker/z-ai/glm-5.2",
            service_exclusion_pattern: "service:nim/z-ai/glm-5.2",
          },
        ],
        autonomous: true,
      };
      await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, gate);

      const read = await readSharedProviderConfirmation(root);
      expect(read.policy?.auto_exclude).toEqual(["service:nim/z-ai/glm-5.2"]);

      // Verify that resolveDispatchExclusion blocks both claude-worker and direct openai-compatible transports reaching nim
      const { resolveDispatchExclusion } = await import("audit-tools/shared");
      const exclusion = resolveDispatchExclusion(read.policy);
      expect(exclusion.excludes({ transport: "claude-worker", service: "nim", model: "z-ai/glm-5.2" })).toBe(true);
      expect(exclusion.excludes({ transport: "openai-compatible", service: "nim", model: "z-ai/glm-5.2" })).toBe(true);
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
        transport: "openai-compatible",
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
        transport: "openai-compatible",
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
        read?.policy?.auto_exclude,
        "advanceAudit must thread the gate into its OWN decide, or the gate is dead",
      ).toContain("openai-compatible:brand-new-model");
      expect(gate.newlyReachable, "the promotion cleared the delta").toEqual([]);
    });
  });
});

// ── the capability-evidence gate (second delta on the SAME obligation) ──────
//
// Same shape as the reach gate above, different question: a confirmation that
// exists but leaves a dispatchable pool with NO resolvable capability rank is not
// satisfied either. The admission capability floor fails OPEN on an unranked pool
// (`buildCapabilityFloorCapable`'s unknown branch), so without this the pool is
// eligible for `deep` work on no evidence at all.
//
// The delta's own contents (which models are unevidenced) are resolved by
// `resolveUnevidencedCapabilityPools` in shared/providers/sharedProviderConfirmation
// — see tests/shared/capability-evidence.test.mjs for the join it is built on. These
// tests cover the delta's CONSUMERS (the state predicate, the decide, the prompt).
describe("capability-evidence gate → obligation", () => {
  const UNEVIDENCED = ["model-gamma", "model-strong"];
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
  const providerObligation = (state) =>
    state.obligations.find((x) => x.id === "provider_confirmation");

  test("an EMPTY capability delta leaves a present confirmation satisfied", () => {
    const o = providerObligation(
      deriveAuditState(confirmedBundle(), { unevidencedCapabilityPools: [] }),
    );
    expect(o.state).toBe("satisfied");
    expect(o.reason).toBeUndefined();
  });

  test("a non-empty capability delta re-opens the obligation and NAMES the models", () => {
    const o = providerObligation(
      deriveAuditState(confirmedBundle(), {
        unevidencedCapabilityPools: UNEVIDENCED,
      }),
    );
    expect(o.state, "no evidence ⇒ pin it down, never fail open").toBe("stale");
    expect(o.reason).toContain("no capability evidence");
    // The prompt is built from this text, so both models must be nameable.
    expect(o.reason).toContain("model-gamma");
    expect(o.reason).toContain("model-strong");
    // …and it must NOT claim a reach problem that did not happen.
    expect(o.reason).not.toContain("reachable backends");
  });

  // Two independent deltas on ONE obligation: reporting only the first would send
  // the operator to reconcile reach while the capability question stays invisible
  // (and vice versa) — and the obligation would re-open again immediately after.
  test("BOTH deltas non-empty ⇒ the reason mentions both, neither is swallowed", () => {
    const o = providerObligation(
      deriveAuditState(confirmedBundle(), {
        newlyReachableBackends: ["brand-new-model"],
        unevidencedCapabilityPools: UNEVIDENCED,
      }),
    );
    expect(o.state).toBe("stale");
    expect(o.reason).toContain("reachable backends the operator never confirmed");
    expect(o.reason).toContain("brand-new-model");
    expect(o.reason).toContain("dispatch pools with no capability evidence");
    expect(o.reason).toContain("model-gamma");
  });

  // The half four prior gate drafts got wrong: re-opening the obligation is inert
  // unless the SELECTION lands on its executor.
  //
  // REGRESSION GUARD. `decideNextStep` must FORWARD the capability delta to
  // `deriveAuditState`. It briefly declared the option and dropped it, so the
  // decide saw `provider_confirmation` satisfied and selected the NEXT
  // obligation's executor — the gate never fired on that path at all.
  // `advanceAudit`'s drain decide has the same requirement.
  test("a capability delta makes decideNextStep select the provider_confirmation EXECUTOR", () => {
    const decision = decideNextStep(confirmedBundle(), {
      unevidencedCapabilityPools: UNEVIDENCED,
    });
    expect(decision.selected_obligation).toBe("provider_confirmation");
    expect(decision.selected_executor).toBe("provider_confirmation_executor");
  });

  // The path that DOES work today: the obligation engine derives gate-aware, so a
  // capability-only delta still reaches the provider_confirmation step and waits for
  // the operator's `capability_order` submission.
  test("attended + capability delta + no submission ⇒ EMITS the prompt", async () => {
    await withTempRoot(async (_root, artifactsDir) => {
      const defs = buildAuditObligations({
        newlyReachable: [],
        unevidencedCapability: UNEVIDENCED,
        autonomous: false,
      });
      const def = defs.find((d) => d.id === "provider_confirmation");
      const outcome = await def.execute(confirmedBundle(), {
        params: { artifactsDir },
      });
      expect(outcome.kind, "attended ⇒ ask the operator to pin the ranks").toBe("emit");
      expect(outcome.step.kind).toBe("provider_confirmation");
      const o = outcome.step.state.obligations.find(
        (x) => x.id === "provider_confirmation",
      );
      expect(o.state, "and it stays open until they answer").toBe("stale");
    });
  });

  // The OTHER arm of the same `hasDelta` OR, and the one that shipped untested.
  //
  // REGRESSION GUARD, and it guards the "gate that could never fire" class specifically.
  // `hasDelta` ORs the reach delta with the capability delta; only the reach arm was ever
  // driven with `autonomous: true`. If the capability term were dropped from that OR (or
  // the fold branch keyed on `newlyReachable` alone, which is what it originally did), an
  // autonomous run with a capability-only delta would take the ELSE branch and EMIT — a
  // prompt into a run with no operator to read it, re-emitted every invocation, which is
  // the PRIORITY[0] livelock. It must FOLD to the executor instead.
  test("autonomous + capability-only delta ⇒ FOLDS to the executor, never emits", async () => {
    await withTempRoot(async (_root, artifactsDir) => {
      const defs = buildAuditObligations({
        newlyReachable: [],
        unevidencedCapability: UNEVIDENCED,
        autonomous: true,
      });
      const def = defs.find((d) => d.id === "provider_confirmation");
      // Observed as a DIFFERENTIAL against the attended control above, on a deliberately
      // identical thin ctx. The emit branch returns from `def.execute` itself and needs
      // nothing more than `artifactsDir` — that is why the attended test passes with this
      // ctx. The fold branch hands off to `runDeterministicExecutor`, which requires the
      // real drain refs this ctx omits and therefore rejects. So on THIS ctx: emit ⇒
      // resolves, fold ⇒ rejects. Asserting the rejection is asserting the branch.
      //
      // Deliberately not stubbing the refs to make the fold succeed: that runs the entire
      // `advanceAudit` drain, which tests the executor rather than the routing decision
      // this test exists for (and it is covered directly by the friction test below).
      const thinCtx = { params: { artifactsDir } };
      await expect(
        def.execute(confirmedBundle(), thinCtx),
        "nobody is there to answer the prompt — emitting it would livelock PRIORITY[0], " +
          "so this must hand off to the executor and never return an emit",
      ).rejects.toThrow();
    });
  });

  // The capability twin of the `newly_reachable_backend` friction test above, and it
  // exists for the same reason: promoting unranked is the RIGHT call (refusing livelocks,
  // fail-closed-excluding silently shrinks the dispatch set) but it leaves those models
  // failing OPEN at the admission capability floor. The progress summary says so — and a
  // drain can fold that summary away, so the friction record is what actually survives to
  // the close-out walk. Without it the fail-open is discoverable only by diffing artifacts.
  test("an unranked promotion is LOUD: an unranked_capability_promotion friction event lands", async () => {
    await withTempRoot(async (root, artifactsDir) => {
      const gate = {
        newlyReachable: [],
        unevidencedCapability: [...UNEVIDENCED],
        autonomous: true,
      };
      const result = await runProviderConfirmationAutoComplete({}, root, artifactsDir, {}, gate);
      // Awaited by the executor, exactly like the reach capture — if this ever needs a
      // sleep to pass, that guarantee broke.
      const frictionPath = frictionCapturePath(artifactsDir, "provider-confirmation");
      expect(await exists(frictionPath), "the operator can find out this happened").toBe(true);
      const body = JSON.stringify(JSON.parse(await readFile(frictionPath, "utf8")));
      expect(body).toContain("unranked_capability_promotion");
      // One fact PER MODEL, discriminated by model id — so each is individually triageable
      // and a re-derive cannot double-count them.
      expect(body).toContain("model-gamma");
      expect(body).toContain("model-strong");
      // And the summary still names it: the two channels are belt-and-braces, not
      // either/or. Asserting only the friction file would let the summary line rot.
      expect(result.progress_summary).toContain("NO capability evidence");
      expect(result.progress_summary).toContain("model-gamma");
    });
  });

  // The prompt is the operator's ONLY way to clear this delta, so it must name both
  // the unranked models and the exact field that answers them — and it must state
  // the sign, since `capability_order` is most-capable-FIRST while the persisted
  // `capability_rank` is LOWER = more capable.
  test("the prompt asks for capability_order over exactly the unevidenced models", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: [
        { name: "worker-command", capability_tier: "unknown", excluded: false },
      ],
      unevidencedCapability: UNEVIDENCED,
    });
    expect(prompt).toContain("capability_order");
    expect(prompt).toContain("model-gamma");
    expect(prompt).toContain("model-strong");
    expect(prompt, "the sign must be stated, not assumed").toContain("most capable first");
    // The exact JSON the operator is told to write, in the exact delta order — and it
    // MUST carry `schema_version`. A host that writes this fragment verbatim has to
    // produce a file `parseProviderConfirmationInput` ACCEPTS: without the version the
    // parser rejects it wholesale, the rejection is indistinguishable from "no
    // submission", and this same prompt re-emits forever. That livelock is what the
    // multi-line shape below pins, so do not collapse this back to a one-liner.
    expect(prompt).toContain('"schema_version": "provider-confirmation-input/v1",');
    expect(prompt).toContain('"capability_order": ["model-gamma", "model-strong"]');
    // Relative-only is the CLAUDE.md "never a named-model→tier map" rule made
    // explicit at the one place an LLM could be tempted to invent a score.
    expect(prompt).toContain("relative ordering only");
  });

  test("an empty capability delta emits NO capability SECTION, but still documents the field", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: [
        { name: "worker-command", capability_tier: "unknown", excluded: false },
      ],
      unevidencedCapability: [],
    });
    // The ASK is what must be absent — nothing is unranked, so there is no question.
    expect(prompt).not.toContain("## Rank these models by capability");
    expect(prompt).not.toContain("most capable first");
    // But the canonical shape block documents the WHOLE input contract, so
    // `capability_order` stays listed there exactly like every other optional field.
    // Omitting it is what left a host using the authoritative shape with no field to
    // answer with — so asserting the bare token is absent would re-create that gap.
    expect(prompt).toContain('"capability_order": ["<model-id>", "..."]');
  });

  // A pool the join cannot reach at all (no model) is UNPINNABLE — pinning it could
  // never clear the delta, so `provider_confirmation` (PRIORITY[0]) would re-select
  // forever.
  //
  // ⚠ This test used to hand `[]` straight to `deriveAuditState` and assert
  // `satisfied` — which is TAUTOLOGICAL: it asserts only that the predicate treats an
  // empty list as empty, and would pass unchanged even if a model-less pool were
  // wrongly admitted to the delta (the actual livelock). It now COMPUTES the delta
  // from a real confirmation on disk against a roster whose only source has no model,
  // so the assertion is the skip talking.
  test("a model-less pool produces an EMPTY delta and PRIORITY[0] converges", async () => {
    await withTempRoot(async (root) => {
      const { resolveUnevidencedCapabilityPools } = await import("audit-tools/shared");
      await writeSharedProviderConfirmation(
        root,
        buildSharedProviderConfirmation({}, CLEAN_ENV, [], [], () => false),
      );
      // `provider: "claude-code"` keeps the primary fold inert, so the gathered set
      // is exactly this one unjoinable source.
      const delta = await resolveUnevidencedCapabilityPools(root, {
        provider: "claude-code",
        sources: [
          {
            id: "no-model-src",
            transport: "openai-compatible",
            endpoint: "http://nomodel.local/v1",
          },
        ],
      });
      expect(
        delta,
        "an unjoinable pool must never enter the delta — no operator answer could " +
          "ever clear it, so PRIORITY[0] would re-prompt forever",
      ).toEqual([]);

      // …and THAT computed delta is what converges the obligation.
      const cleared = providerObligation(
        deriveAuditState(confirmedBundle(), { unevidencedCapabilityPools: delta }),
      );
      expect(cleared.state).toBe("satisfied");
      expect(
        decideNextStep(confirmedBundle(), { unevidencedCapabilityPools: delta })
          .selected_obligation,
      ).not.toBe("provider_confirmation");

      // The contrast case: a JOINABLE unranked source DOES re-open it, which proves
      // the convergence above came from the skip and not from an inert code path.
      const joinable = await resolveUnevidencedCapabilityPools(root, {
        provider: "claude-code",
        sources: [
          {
            id: "real-src",
            transport: "openai-compatible",
            model: "model-unranked",
            endpoint: "http://real.local/v1",
          },
        ],
      });
      expect(joinable).toEqual(["model-unranked"]);
      expect(
        providerObligation(
          deriveAuditState(confirmedBundle(), {
            unevidencedCapabilityPools: joinable,
          }),
        ).state,
      ).toBe("stale");
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

// ---------------------------------------------------------------------------
// BL-1 (prompt half) + BL-2 — the RE-confirmation prompt
// ---------------------------------------------------------------------------

const { selectCapabilityAnchors: pickAnchors } = await import("audit-tools/shared");

describe("BL-1 prompt: anchored insertion makes the delta-scoped ask answerable", () => {
  const POOL = [{ name: "worker-command", capability_tier: "unknown", excluded: false }];

  test("anchors render as fixed reference points and join the answer fragment", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: ["m-new"],
      capabilityAnchors: ["m-top", "m-mid", "m-bottom"],
    });
    expect(prompt).toContain("already ranked");
    expect(prompt).toContain("m-top");
    expect(prompt).toContain("m-bottom");
    // ONE ordering over the COMBINED set — that is what `mergeCapabilityOrder`
    // interpolates against. A fragment naming only the new model is the livelock.
    expect(prompt).toContain(
      '"capability_order": ["m-top", "m-mid", "m-bottom", "m-new"]',
    );
    // Still a complete, acceptable file (the NEW-4 lesson).
    expect(prompt).toContain('"schema_version": "provider-confirmation-input/v1",');
    // The operator must be told that silence preserves, or they will restate the
    // whole ranking they cannot see.
    expect(prompt).toContain("keep the rank they already have");
    // And that reordering the anchors is inert — otherwise a swap reads as accepted.
    expect(prompt).toContain("has no effect");
  });

  test("the prompt stays O(new + constant) — a huge roster never reaches it", () => {
    // Zero-padded so no id is a substring of another — otherwise the `includes`
    // count below over-reports and the assertion is not the anchor bound talking.
    const roster = Array.from(
      { length: 300 },
      (_, i) => `roster-model-${String(i).padStart(3, "0")}`,
    );
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: ["m-new"],
      capabilityAnchors: pickAnchors(roster, ["m-new"]),
    });
    const mentioned = roster.filter((m) => prompt.includes(m));
    expect(
      mentioned.length,
      "rendering the whole confirmed ordering is the fix this design exists to avoid",
    ).toBeLessThanOrEqual(5);
  });

  test("a model under question is never also offered as a settled anchor", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: ["m-new"],
      // A caller passing an overlapping anchor must not produce a contradictory ask.
      capabilityAnchors: ["m-top", "m-new"],
    });
    expect(prompt).toContain('"capability_order": ["m-top", "m-new"]');
    expect(prompt).not.toContain("`m-new`  (already ranked)");
  });

  test("no anchors (a first-ever ranking) keeps the original single-list ask", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: ["m-new"],
      capabilityAnchors: [],
    });
    expect(prompt).toContain("these model ids, **most capable first**");
    expect(prompt).not.toContain("already ranked");
  });
});

// ⚠ RED-GREEN VALIDATED. Reverting `hasPriorConfirmation` to being derived from
// `newlyReachable.length > 0` (its pre-fix gating) turns every assertion below RED.
//
// The defect: on a capability-only re-confirmation the prompt rendered the tool's
// price-ascending SUGGESTION with no guardrail at all — while the capability block
// newly promises "any field you omit keeps the value you confirmed previously". An
// operator transcribing the displayed table into `cost_order` to "keep" it thereby
// silently reverted their own confirmed ordering. Enforced in the tool, not left to
// the operator noticing (CLAUDE.md auditor-agnostic robustness).
describe("BL-2: a RE-confirmation never shows stale state as if it were current", () => {
  const POOL = [{ name: "worker-command", capability_tier: "unknown", excluded: false }];

  test("the do-not-re-litigate guardrail renders with NO reach delta at all", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: ["m-new"],
      newlyReachable: [],
      hasPriorConfirmation: true,
    });
    expect(prompt).toContain("This is a RE-confirmation");
    expect(prompt).toContain("do not re-litigate");
    // The specific footgun, named.
    expect(prompt).toContain("cost_order");
    expect(prompt).toContain("as you confirmed it");
    // The suggestion framing must be GONE — it is what made stale state read as current.
    expect(prompt).not.toContain("tool's **suggested** cost ordering");
  });

  test("a FIRST-time gate keeps the suggestion framing and carries no guardrail", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      unevidencedCapability: [],
      hasPriorConfirmation: false,
    });
    expect(prompt).toContain("tool's **suggested** cost ordering");
    expect(prompt).not.toContain("This is a RE-confirmation");
    expect(prompt).not.toContain("do not re-litigate");
  });

  test("a reach delta still gets exactly one guardrail, not two", () => {
    const prompt = renderProviderConfirmationPrompt({
      providerPool: POOL,
      newlyReachable: [
        {
          key: "brand-new",
          transport: "openai-compatible",
          exclusion_pattern: "openai-compatible:brand-new",
        },
      ],
      hasPriorConfirmation: true,
    });
    // The delta block's own guardrail covers it.
    expect(prompt).toContain("do not re-litigate");
    expect(prompt.match(/do not re-litigate/g)).toHaveLength(1);
    expect(prompt).not.toContain("This is a RE-confirmation");
    // …and the table is still labelled as the confirmed ordering, not a suggestion.
    expect(prompt).toContain("as you confirmed it");
  });
});
