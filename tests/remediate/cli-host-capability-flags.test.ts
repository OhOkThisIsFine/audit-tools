import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  program,
  applyGuidanceFile,
  normalizeBooleanFlagArgv,
  resolveArtifactsDirOption,
} from "../../src/remediate/index.js";
import { remediationArtifactsDir } from "audit-tools/shared";

const REPO_ROOT = resolve(__dirname, "..", "..");

/** The three host-facing loader docs the parity invariant (INV-CC-05) covers. */
const LOADER_DOCS = {
  remediatePrompt: join(
    REPO_ROOT,
    "skills",
    "remediate-code",
    "remediate-code.prompt.md",
  ),
  remediateReadme: join(REPO_ROOT, "README.md"),
  auditContracts: join(REPO_ROOT, "docs", "audit-pkg", "contracts.md"),
};

/** CLI source files whose `--host-*` / `--guidance-file` literals are authoritative. */
const AUDIT_SOURCES = [
  join(REPO_ROOT, "src", "audit", "cli", "args.ts"),
  join(REPO_ROOT, "src", "audit", "cli", "nextStepCommand.ts"),
];

const F = "--host-can-dispatch-subagents";

// --- helpers ---------------------------------------------------------------

function nextStepCommand() {
  const cmd = program.commands.find((c) => c.name() === "next-step");
  if (!cmd) throw new Error("next-step command is not registered on program");
  return cmd;
}

/**
 * Parse argv through the real program (after the `=value` normalization the CLI
 * applies) and return the resolved next-step options, without invoking the
 * action. We re-derive the value-less boolean's tristate from the same options
 * commander would hand the action.
 */
function parseNextStepOpts(args: string[]): Record<string, unknown> {
  const cmd = nextStepCommand();
  // commander mutates option values in place on the shared command singleton.
  // Clear every option (including defaults) before each parse so values never
  // leak between cases and the boolean's tristate is observed cleanly.
  for (const opt of cmd.options) {
    cmd.setOptionValue(opt.attributeName(), undefined as never);
  }
  const argv = normalizeBooleanFlagArgv(
    ["node", "remediate-code", "next-step", ...args],
    F,
  );
  // parseOptions does not run the action, so decideNextStep is never called.
  cmd.parseOptions(argv.slice(2).filter((t) => t !== "next-step"));
  return cmd.opts();
}

/** Collect every `--host-*` (and `--no-host-*`) long flag from text. */
function documentedHostFlags(text: string): Set<string> {
  const flags = new Set<string>();
  for (const m of text.matchAll(/--(?:no-)?host-[a-z0-9-]+/g)) {
    flags.add(m[0]);
  }
  return flags;
}

/** Registered `--host-*` flags on the remediate-code commander program. */
function remediateRegisteredHostFlags(): Set<string> {
  const flags = new Set<string>();
  for (const opt of nextStepCommand().options) {
    if (opt.long && /^--(?:no-)?host-/.test(opt.long)) flags.add(opt.long);
  }
  return flags;
}

/** Registered `--host-*` flags scanned from audit-code's CLI source. */
function auditRegisteredHostFlags(): Set<string> {
  const flags = new Set<string>();
  for (const file of AUDIT_SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/"(--(?:no-)?host-[a-z0-9-]+)"/g)) {
      flags.add(m[1]);
    }
  }
  return flags;
}

/**
 * A documented flag is satisfied if it (or its boolean dual `--host-x` ↔
 * `--no-host-x`) is registered — a value-less boolean is registered as both the
 * positive and the negatable form, but docs name only the positive.
 */
function isRegistered(flag: string, registered: Set<string>): boolean {
  if (registered.has(flag)) return true;
  const dual = flag.startsWith("--no-")
    ? `--${flag.slice("--no-".length)}`
    : `--no-${flag.slice("--".length)}`;
  return registered.has(dual);
}

/**
 * Detect the legacy two-step bootstrap phrasing: a doc instructing the host to
 * manually WRITE conversation-start.md and THEN separately continue/call the
 * backend, instead of the single-step `--guidance-file`. Returns the offending
 * doc keys.
 */
function docsWithTwoStepBootstrap(): string[] {
  const offenders: string[] = [];
  for (const [key, path] of Object.entries(LOADER_DOCS)) {
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/conversation-start\.md/g)) {
      const start = Math.max(0, m.index! - 200);
      const window = text.slice(start, m.index! + 200).toLowerCase();
      const manualWrite = /\bwrite\b/.test(window);
      const thenContinue = /\bthen\b/.test(window);
      const viaGuidanceFlag = window.includes("--guidance-file");
      if (manualWrite && thenContinue && !viaGuidanceFlag) {
        offenders.push(key);
        break;
      }
    }
  }
  return offenders;
}

// --- flag semantics (this block's own surface) -----------------------------

describe("remediate-code next-step --host-can-dispatch-subagents (true boolean)", () => {
  it("is registered as a value-less boolean (no <value> placeholder)", () => {
    const opt = nextStepCommand().options.find((o) => o.long === F);
    expect(opt).toBeDefined();
    // A value-less boolean has no required/optional arg.
    expect(opt!.required).toBe(false);
    expect(opt!.optional).toBe(false);
    // The negatable form is registered so =false / --no- can resolve false.
    expect(
      nextStepCommand().options.some(
        (o) => o.long === "--no-host-can-dispatch-subagents",
      ),
    ).toBe(true);
  });

  it("is absent → undefined (tristate preserved)", () => {
    expect(parseNextStepOpts([]).hostCanDispatchSubagents).toBeUndefined();
  });

  it("bare flag → true", () => {
    expect(parseNextStepOpts([F]).hostCanDispatchSubagents).toBe(true);
  });

  it("bare flag does NOT swallow the next token", () => {
    const opts = parseNextStepOpts([F, "--input", "report.md"]);
    expect(opts.hostCanDispatchSubagents).toBe(true);
    // --input now accumulates into a string[] via its collect reducer.
    expect(opts.input).toEqual(["report.md"]);
  });

  it("--no- form → false", () => {
    expect(
      parseNextStepOpts(["--no-host-can-dispatch-subagents"])
        .hostCanDispatchSubagents,
    ).toBe(false);
  });

  it("=false → false, =true → true", () => {
    expect(parseNextStepOpts([`${F}=false`]).hostCanDispatchSubagents).toBe(
      false,
    );
    expect(parseNextStepOpts([`${F}=true`]).hostCanDispatchSubagents).toBe(
      true,
    );
  });

  it("=<garbage> fails loudly", () => {
    expect(() => parseNextStepOpts([`${F}=maybe`])).toThrow(
      /true or false/i,
    );
  });
});

// --- repeatable --input accumulation (B4 / CP-NODE-4) ----------------------

describe("remediate-code next-step --input (repeatable, collect reducer)", () => {
  it("is registered as a value-bearing option (takes <path>)", () => {
    const opt = nextStepCommand().options.find((o) => o.long === "--input");
    expect(opt).toBeDefined();
    // A collect reducer accumulates into an array; the option still takes a
    // single <path> value per occurrence (NOT a greedy variadic <path...>).
    expect(opt!.required).toBe(true);
    expect(opt!.variadic).toBe(false);
  });

  it("declares an empty-array default (no --input → [])", () => {
    const opt = nextStepCommand().options.find((o) => o.long === "--input");
    expect(opt!.defaultValue).toEqual([]);
  });

  it("single --input → array of one (single --input unchanged)", () => {
    expect(parseNextStepOpts(["--input", "report.md"]).input).toEqual([
      "report.md",
    ]);
  });

  it("repeated --input accumulates into a string[] in order", () => {
    const opts = parseNextStepOpts([
      "--input",
      "a.md",
      "--input",
      "b.md",
      "--input",
      "c.md",
    ]);
    expect(opts.input).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("--input does NOT greedily swallow following tokens (not variadic)", () => {
    // A variadic <path...> would swallow `report.md` AND the trailing flag's
    // value; a collect reducer takes exactly one value per occurrence.
    const opts = parseNextStepOpts(["--input", "report.md", F]);
    expect(opts.input).toEqual(["report.md"]);
    expect(opts.hostCanDispatchSubagents).toBe(true);
  });
});

// --- single-step bootstrap (INV-CC-03) -------------------------------------

describe("applyGuidanceFile — sole, idempotent-on-target writer of conversation-start.md", () => {
  function tempArtifacts(): { dir: string; artifactsDir: string; target: string } {
    const dir = mkdtempSync(join(tmpdir(), "remediate-guidance-"));
    const artifactsDir = join(dir, ".audit-tools", "remediation");
    mkdirSync(artifactsDir, { recursive: true });
    return {
      dir,
      artifactsDir,
      target: join(artifactsDir, "intake", "conversation-start.md"),
    };
  }

  it("writes the guidance file verbatim to intake/conversation-start.md", () => {
    const { dir, artifactsDir, target } = tempArtifacts();
    try {
      const src = join(dir, "guidance.md");
      const body = "Focus on the auth module.\nNon-goal: refactors.\n";
      writeFileSync(src, body);
      applyGuidanceFile(artifactsDir, src);
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("identical re-apply is a byte-identical no-op (no unbounded append)", () => {
    const { dir, artifactsDir, target } = tempArtifacts();
    try {
      const src = join(dir, "guidance.md");
      writeFileSync(src, "Guidance body.\n");
      applyGuidanceFile(artifactsDir, src);
      const first = readFileSync(target);
      applyGuidanceFile(artifactsDir, src);
      applyGuidanceFile(artifactsDir, src);
      const after = readFileSync(target);
      expect(after.equals(first)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to silently clobber differing pre-existing content", () => {
    const { dir, artifactsDir, target } = tempArtifacts();
    try {
      const src = join(dir, "guidance.md");
      writeFileSync(src, "Original guidance.\n");
      applyGuidanceFile(artifactsDir, src);
      const preserved = readFileSync(target);
      writeFileSync(src, "Different guidance.\n");
      expect(() => applyGuidanceFile(artifactsDir, src)).toThrow(
        /Refusing to overwrite/i,
      );
      // The pre-existing content survives the refusal untouched.
      expect(readFileSync(target).equals(preserved)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("next-step registers --guidance-file as the single-step bootstrap option", () => {
    expect(
      nextStepCommand().options.some((o) => o.long === "--guidance-file"),
    ).toBe(true);
  });
});

// --- artifacts-dir resolution (default rebases onto --root) ----------------

describe("resolveArtifactsDirOption — default rebases onto --root", () => {
  it("--root <X> with the unchanged default lands under <X>/.audit-tools/remediation", () => {
    const rootX = resolve("/tmp", "some-target-root");
    expect(resolveArtifactsDirOption(rootX, ".audit-tools/remediation")).toBe(
      remediationArtifactsDir(rootX),
    );
    expect(resolveArtifactsDirOption(rootX, ".audit-tools/remediation")).toBe(
      join(rootX, ".audit-tools", "remediation"),
    );
  });

  it("routes the default through the shared remediationArtifactsDir helper", () => {
    const rootX = resolve("/tmp", "another-root");
    // Equivalence with the shared helper is the single-source guarantee: the
    // CLI resolver must not re-spell the `.audit-tools/remediation` join.
    expect(resolveArtifactsDirOption(rootX, ".audit-tools/remediation")).toBe(
      remediationArtifactsDir(rootX),
    );
  });

  it("honors an explicit --artifacts-dir verbatim (ignores --root)", () => {
    const rootX = resolve("/tmp", "some-target-root");
    const explicit = resolve("/var", "artifacts", "elsewhere");
    expect(resolveArtifactsDirOption(rootX, explicit)).toBe(explicit);
  });

  it("a drifted --root inside .audit-tools cannot mint a phantom nested tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "remediate-drift-"));
    try {
      mkdirSync(join(repo, ".audit-tools", "remediation"), { recursive: true });
      // The cwd drifted into the artifact tree, so a bare `--root .` resolves to
      // this path. resolveRepoRoot must climb back out — no `.audit-tools/.audit-tools`.
      const drifted = join(repo, ".audit-tools", "remediation");
      const resolved = resolveArtifactsDirOption(drifted, ".audit-tools/remediation");
      expect(resolved).toBe(join(repo, ".audit-tools", "remediation"));
      expect(resolved).not.toContain(join(".audit-tools", ".audit-tools"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- doc ↔ CLI parity (INV-CC-05) ------------------------------------------

describe("doc ↔ CLI parity for host capability flags (INV-CC-05)", () => {
  it("loads the parity inputs (program + three loader docs + audit sources)", () => {
    // Guards that the parity machinery itself compiles and resolves — this test
    // is meaningful regardless of the loader docs' current wording.
    expect(remediateRegisteredHostFlags().has(F)).toBe(true);
    expect(auditRegisteredHostFlags().has(F)).toBe(true);
    for (const path of Object.values(LOADER_DOCS)) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("every documented --host-* flag is CLI-registered (⊆)", () => {
    const remediate = remediateRegisteredHostFlags();
    const audit = auditRegisteredHostFlags();
    const checks: { key: keyof typeof LOADER_DOCS; registered: Set<string> }[] = [
      { key: "remediatePrompt", registered: remediate },
      { key: "remediateReadme", registered: remediate },
      { key: "auditContracts", registered: audit },
    ];
    const unregistered: string[] = [];
    for (const { key, registered } of checks) {
      const text = readFileSync(LOADER_DOCS[key], "utf8");
      for (const flag of documentedHostFlags(text)) {
        if (!isRegistered(flag, registered)) {
          unregistered.push(`${key}: ${flag}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it("no loader doc carries two-step bootstrap phrasing", () => {
    // The loader docs instruct the single-step `--guidance-file` bootstrap rather
    // than a manual write-then-call. This assertion is unconditional: a doc that
    // regresses to two-step phrasing must FAIL the suite, never be skipped. (An
    // earlier early-return gate let this pass green in exactly its failure
    // condition — TST-b3b7b26b — and is removed.)
    const offenders = docsWithTwoStepBootstrap();
    expect(
      offenders,
      `loader docs carry legacy two-step bootstrap phrasing (manual write-then-continue instead of --guidance-file): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
