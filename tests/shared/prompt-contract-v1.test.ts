// Packet 7 (Prompt Contract v1 foundation). The small shared renderers every
// prompt contract states the same way, plus the registry-level profile
// classification the standard §6 asks for (worker | driver | dispatch instead of
// a single "no worker schema" exemption). The renderers are deliberately tiny
// markdown fragments — there is no prompt language, no central mega-renderer —
// so each is pinned here on its OWN contract, not on a composed body.
import { describe, it, expect } from "vitest";

import {
  collectRenderedPaths,
  renderedPathsInScope,
  renderActorOwnership,
  renderCheckSection,
  renderClosedValues,
  renderContinueSection,
  renderDispatchFallback,
  renderExactPath,
  renderInputList,
  renderOutputSection,
  renderStopSection,
  type PromptActor,
} from "../../src/shared/promptContract.js";
import { promptContractRegistry } from "./promptContractRegistry.js";

describe("renderExactPath (PC-01/PC-04: exact, copyable path token)", () => {
  it("backtick-quotes so the path copies verbatim", () => {
    expect(renderExactPath(".audit-tools/audit/audit-findings.json")).toBe(
      "`.audit-tools/audit/audit-findings.json`",
    );
  });
});

describe("renderInputList (PC-03/PC-04: readable inputs as exact paths)", () => {
  it("renders one line per input: exact path plus what it holds", () => {
    const lines = renderInputList([
      { path: ".audit-tools/audit/verdict.json", description: "the prior verdict" },
      { path: ".audit-tools/audit/pending.md", description: "the pending prose" },
    ]);
    expect(lines).toEqual([
      "- `.audit-tools/audit/verdict.json` — the prior verdict",
      "- `.audit-tools/audit/pending.md` — the pending prose",
    ]);
  });
});

describe("renderClosedValues (PC-05: complete closed set, never an open alternation)", () => {
  it("names every value and quotes each so it copies verbatim", () => {
    const text = renderClosedValues("Valid values", ["ephemeral", "permanent", "skip"]);
    expect(text).toBe('Valid values: `"ephemeral"` | `"permanent"` | `"skip"`');
  });

  it("renders no trailing ellipsis even for a single member", () => {
    expect(renderClosedValues("Valid values", ["included"])).toBe(
      'Valid values: `"included"`',
    );
  });
});

describe("renderActorOwnership (PC-01: who does it, not a bare verb)", () => {
  it("names the owner for every actor class", () => {
    expect(renderActorOwnership("operator", "choose an install option.")).toBe(
      "Ask the operator choose an install option.",
    );
    expect(renderActorOwnership("host", "the decision and continue.")).toBe(
      "The host records the decision and continue.",
    );
    expect(renderActorOwnership("worker", "the complete artifact.")).toBe(
      "The worker writes the complete artifact.",
    );
    expect(renderActorOwnership("tool", "the schema version.")).toBe(
      "The tool derives the schema version.",
    );
  });

  it("never emits a bare choose/decide/record that a second actor could own", () => {
    // The renderer always prefixes an actor noun; a bare imperative would leak
    // through only if the action itself carried the verb first — the renderer is
    // `owner + action`, so the actor is always explicit.
    for (const actor of ["operator", "host", "worker", "tool"] as const) {
      const text = renderActorOwnership(actor, "record the choice.");
      expect(text).toMatch(/^(Ask the operator|The host records|The worker writes|The tool derives)/);
    }
  });
});

describe("renderOutputSection (PC-03: output path + complete shape)", () => {
  it("states the exact output path and a fenced JSON shape", () => {
    const text = renderOutputSection(
      ".audit-tools/audit/verdict.json",
      '{ "verdict": "approved" }',
    );
    expect(text).toContain("`.audit-tools/audit/verdict.json`");
    expect(text).toContain("```json");
    expect(text).toContain('{ "verdict": "approved" }');
  });
});

describe("renderCheckSection (PC-09: mechanical self-check when a validator exists)", () => {
  it("states the exact command and the success condition", () => {
    const text = renderCheckSection("remediate-code validate-artifact --name foo --file bar");
    expect(text).toContain("`remediate-code validate-artifact --name foo --file bar`");
    expect(text).toContain('`status: "ok"` means the artifact is admissible');
  });
});

describe("terminal instruction (PC-10: stop XOR continue)", () => {
  it("renderStopSection ends the chain", () => {
    expect(renderStopSection()).toContain("Stop after writing the output");
    expect(renderStopSection()).toContain("Do not start the next phase");
  });

  it("renderContinueSection names the exact continuation command", () => {
    expect(renderContinueSection("audit-code next-step")).toContain(
      "`audit-code next-step`",
    );
  });
});

describe("renderDispatchFallback (PC-11: fallback preserves lane semantics)", () => {
  it("an independence-required review stops, never degrades to self-review", () => {
    const text = renderDispatchFallback(true);
    expect(text).toContain("stop");
    expect(text).toContain("could not be performed independently");
    expect(text).toContain("Do not write a result");
  });

  it("an ordinary lane may run inline sequentially", () => {
    expect(renderDispatchFallback(false)).toContain(
      "read and follow each lane file sequentially yourself",
    );
  });
});

describe("collectRenderedPaths / renderedPathsInScope (PC-03/PC-04: no guessed paths)", () => {
  it("collects every backticked path-looking token from a prompt body", () => {
    const prompt = [
      "Read the verdict at `.audit-tools/audit/verdict.json`.",
      "Also see `.audit-tools/audit/pending.md`.",
      "The size/complexity ranking is not a path.",
      "Neither is a bare `foo/bar` without an extension.",
    ].join("\n");
    expect(collectRenderedPaths(prompt)).toEqual([
      ".audit-tools/audit/pending.md",
      ".audit-tools/audit/verdict.json",
    ]);
  });

  it("renderedPathsInScope reports only paths missing from the read scope", () => {
    const prompt = "Read `.audit-tools/audit/verdict.json` and `.audit-tools/audit/evidence.md`.";
    expect(
      renderedPathsInScope(prompt, [".audit-tools/audit/verdict.json"]),
    ).toEqual({ missing: [".audit-tools/audit/evidence.md"] });
  });

  it("renderedPathsInScope is empty when every rendered path is granted", () => {
    const prompt = "Read `.audit-tools/audit/verdict.json`.";
    expect(
      renderedPathsInScope(prompt, [".audit-tools/audit/verdict.json"]),
    ).toEqual({ missing: [] });
  });

  it("distinguishes all four actor nouns without relying on argument order", () => {
    // A regression guard for the actor-ownership table: the mapping is fixed per
    // actor, never positional.
    const expected: Record<PromptActor, string> = {
      operator: "Ask the operator",
      host: "The host records",
      worker: "The worker writes",
      tool: "The tool derives",
    };
    for (const [actor, prefix] of Object.entries(expected) as [PromptActor, string][]) {
      expect(renderActorOwnership(actor, "x.")).toMatch(new RegExp(`^${prefix.replace(/\s/g, "\\s")}`));
    }
  });
});

// ── Registry profile classification (standard §6) ──────────────────────────────
//
// The registry used to bucket every non-worker prompt under `declared-gap` and
// stop at "explain the gap" — so a driver prompt that taught a wrong closed set
// escaped coverage merely because it had no worker result schema. The profile
// axis replaces that blanket exemption with three named classes, each with its
// own contract: worker (artifact), driver (decision), dispatch (envelope).

describe("prompt-contract registry: profile classification", () => {
  // The profile for a worker row is unambiguous: a `derived`/`projection` row is
  // a bounded task that writes zod-shaped artifact. Declared-gap worker rows
  // (the design-review doors, host-handoff buildPrompt, edge reasoning) name
  // `profile: "worker"` explicitly because their disposition alone is ambiguous.
  function profileOf(row: (typeof promptContractRegistry)[number]): "worker" | "driver" | "dispatch" | undefined {
    if (row.profile) return row.profile;
    if (row.disposition === "derived" || row.disposition === "projection") return "worker";
    return undefined;
  }

  it("every derived/projection row is a worker", () => {
    const nonWorker = promptContractRegistry.filter(
      (row) =>
        (row.disposition === "derived" || row.disposition === "projection") &&
        row.profile !== undefined &&
        row.profile !== "worker",
    );
    expect(nonWorker, "a derived/projection row is a worker task").toEqual([]);
  });

  it("no prompt row is left unclassified — helpers are the only profile-less rows", () => {
    const unclassified = promptContractRegistry.filter(
      (row) => profileOf(row) === undefined && row.render !== undefined,
    );
    expect(
      unclassified.map((row) => `${row.file} :: ${row.builder}`),
      "a row that renders a prompt must declare a profile; only structural helpers may omit it",
    ).toEqual([]);
  });

  it("driver prompts outnumber nothing — they are a named class, not a gap", () => {
    const drivers = promptContractRegistry.filter((row) => profileOf(row) === "driver");
    expect(drivers.length, "the driver profile must have named members").toBeGreaterThan(0);
    // The driver prompts that previously hid under the blanket gap reason.
    for (const name of ["renderConfirmIntentPrompt", "renderAnalyzerConsentPrompt", "triagePrompt", "renderBlockedStepPrompt"]) {
      expect(
        drivers.map((row) => row.builder),
        `driver prompt '${name}' must be classified driver, not left as a generic gap`,
      ).toContain(name);
    }
  });

  it("the dispatch profile names the thin envelope, not a worker", () => {
    const dispatchers = promptContractRegistry.filter((row) => profileOf(row) === "dispatch");
    expect(
      dispatchers.map((row) => row.builder),
      "renderEdgeReasoningDispatchPrompt is a dispatch envelope",
    ).toContain("renderEdgeReasoningDispatchPrompt");
  });
});
