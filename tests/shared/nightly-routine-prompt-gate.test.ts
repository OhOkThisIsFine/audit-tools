// Contract tests for the generated nightly scheduler prompt.
//
// `docs/nightly-routine.md` owns the routine and
// `docs/doc-review-guidelines.md` owns leg 1. The scheduler prompt used to
// restate both by hand behind a "the other docs win" precedence rule; that is a
// second home, and it drifted into banning the helper the canonical guidance
// requires. The target is now whole-file generated from those two sources.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSyncHidden, execFileSyncHidden } from "../helpers/spawn.mjs";
import {
  assertPackageWiring,
  CHECK_SCRIPT,
  PACKAGE_JSON,
  renderNightlyRoutinePrompt,
  SOURCE_GUIDELINES,
  SOURCE_ROUTINE,
  TARGET_PROMPT,
} from "../../scripts/check-nightly-routine-prompt.mjs";
import { buildPreCommitLegs } from "../../scripts/shared/derived-file-preflight.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const GENERATOR = join(REPO_ROOT, "scripts", "check-nightly-routine-prompt.mjs");
const PRE_COMMIT_GATE = join(REPO_ROOT, ".claude", "hooks", "pre-commit-gate.mjs");

describe("nightly scheduler prompt generation", () => {
  const routine = [
    "# Routine",
    "",
    'Use `node ~/.claude/llm-call.mjs --schema <file> <alias> "<instruction>" <file...>`.',
    "",
  ].join("\n");
  const guidelines = ["# Review guidelines", "", "Reviewer then adversary.", ""].join("\n");
  const packageJson = JSON.stringify({
    scripts: {
      "check:nightly-routine-prompt": CHECK_SCRIPT,
      "verify:checks":
        "node scripts/shared/profile-run.mjs verify-checks check:nightly-routine-prompt build",
    },
  });

  const createGeneratorRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "audit-tools-nightly-prompt-generator-"));
    for (const [path, body] of [
      [SOURCE_ROUTINE, routine],
      [SOURCE_GUIDELINES, guidelines],
      [PACKAGE_JSON, packageJson],
    ]) {
      const absolutePath = join(root, path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, body, "utf8");
    }
    return root;
  };

  const runGenerator = (root: string, args: string[] = []) =>
    spawnSyncHidden(process.execPath, [GENERATOR, ...args], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });

  it("embeds both canonical sources verbatim in a whole-file generated target", () => {
    const rendered = renderNightlyRoutinePrompt(routine, guidelines);
    expect(rendered).toContain(routine.trimEnd());
    expect(rendered).toContain(guidelines.trimEnd());
    expect(rendered).toContain("GENERATED");
    expect(rendered).toContain(SOURCE_ROUTINE);
    expect(rendered).toContain(SOURCE_GUIDELINES);
    expect(rendered).not.toContain("\n```text\nThe two canonical contracts");
  });

  it("changes whenever either source changes", () => {
    const rendered = renderNightlyRoutinePrompt(routine, guidelines);
    expect(renderNightlyRoutinePrompt(`${routine}new routine fact\n`, guidelines)).not.toBe(rendered);
    expect(renderNightlyRoutinePrompt(routine, `${guidelines}new rubric fact\n`)).not.toBe(rendered);
  });

  it("refuses an empty source instead of rendering an authoritative-looking partial prompt", () => {
    expect(() => renderNightlyRoutinePrompt("", guidelines)).toThrow(/nightly-routine\.md.*empty/i);
    expect(() => renderNightlyRoutinePrompt(routine, " \n")).toThrow(/doc-review-guidelines\.md.*empty/i);
  });

  it("validates both the real check script and its verify:checks release wiring", () => {
    expect(() => assertPackageWiring(packageJson)).not.toThrow();
    expect(() =>
      assertPackageWiring(
        JSON.stringify({
          scripts: {
            "check:nightly-routine-prompt": 'node -e ""',
            "verify:checks": "check:nightly-routine-prompt",
          },
        }),
      ),
    ).toThrow(/must define "check:nightly-routine-prompt"/);
    expect(() =>
      assertPackageWiring(
        JSON.stringify({
          scripts: {
            "check:nightly-routine-prompt": CHECK_SCRIPT,
            "verify:checks": "node scripts/shared/profile-run.mjs verify-checks build",
          },
        }),
      ),
    ).toThrow(/verify:checks must include/);
  });

  it("--write creates a missing generated target", () => {
    const root = createGeneratorRoot();
    try {
      const result = runGenerator(root, ["--write"]);
      expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
      expect(readFileSync(join(root, TARGET_PROMPT), "utf8")).toBe(
        renderNightlyRoutinePrompt(routine, guidelines),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("check mode clearly fails when the generated target is missing", () => {
    const root = createGeneratorRoot();
    try {
      const result = runGenerator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/nightly-routine-prompt\.md is MISSING/);
      expect(result.stderr).toMatch(/--write/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pre-commit gate runs nightly-prompt parity on every owned path", () => {
  let repo: string;

  const git = (args: string[]) =>
    execFileSyncHidden("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  const writeFile = (relativePath: string, body: string) => {
    const absolutePath = join(repo, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body, "utf8");
  };
  const runGate = () =>
    spawnSyncHidden(process.execPath, [PRE_COMMIT_GATE], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "fixture"' },
      }),
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "audit-tools-nightly-prompt-gate-"));
    execFileSyncHidden("git", ["init", "--initial-branch=main"], {
      cwd: repo,
      stdio: "pipe",
    });
    git(["config", "user.email", "test@test"]);
    git(["config", "user.name", "test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFile(
      "package.json",
      JSON.stringify(
        {
          name: "nightly-prompt-gate-fixture",
          version: "0.0.0",
          private: true,
          scripts: {
            check: 'node -e ""',
            "test:doc-contract": 'node -e ""',
            "check:doc-manifest": 'node -e ""',
            // Broadest trigger in the same hook and it runs LAST; a no-op keeps
            // these cases about the nightly-prompt trigger alone.
            "check:doc-links": 'node -e ""',
            // Named as a real script path — the derived trigger's impl-path
            // rule (P34) rides the command string, and running it in this
            // fixture always FAILS (the module either does not exist or is the
            // staged "changed" stub), so the gate blocking proves the trigger.
            "check:nightly-routine-prompt": "node scripts/check-nightly-routine-prompt.mjs",
          },
        },
        null,
        2,
      ),
    );
    writeFile("README.md", "# fixture\n");
    writeFile(".gitignore", ".claude/\nnode_modules/\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
  });

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* Windows may retain a handle briefly. */
    }
  });

  const reset = () => {
    git(["reset", "--hard", "HEAD"]);
    git(["clean", "-fd"]);
  };
  afterEach(reset);

  it.each([
    SOURCE_ROUTINE,
    SOURCE_GUIDELINES,
    TARGET_PROMPT,
    "scripts/check-nightly-routine-prompt.mjs",
  ])("blocks when %s is staged and parity fails", (path: string) => {
    writeFile(path, "changed\n");
    git(["add", "-A"]);
    const result = runGate();
    expect(result.status, result.stderr ?? "").toBe(2);
    expect(result.stderr).toMatch(/check:nightly-routine-prompt FAILED/);
    expect(result.stderr).toMatch(/check-nightly-routine-prompt\.mjs --write/);
  });

  it("blocks when package wiring changes and parity/wiring fails", () => {
    const pkg = JSON.parse(readFileSync(join(repo, PACKAGE_JSON), "utf8"));
    pkg.description = "staged package wiring input";
    writeFile(PACKAGE_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
    git(["add", "-A"]);
    const result = runGate();
    expect(result.status, result.stderr ?? "").toBe(2);
    expect(result.stderr).toMatch(/check:nightly-routine-prompt FAILED/);
  });

  it("does not run the narrow parity check for an unrelated doc", () => {
    writeFile("docs/reviews/record.md", "# unrelated\n");
    git(["add", "-A"]);
    const result = runGate();
    expect(result.status, result.stderr ?? "").toBe(0);
    expect(result.stderr).not.toMatch(/check:nightly-routine-prompt/);
  });

  it("does not run the narrow parity check for unrelated source", () => {
    writeFile("src/unrelated.ts", "export const x = 1;\n");
    git(["add", "-A"]);
    const result = runGate();
    expect(result.status, result.stderr ?? "").toBe(0);
    expect(result.stderr).not.toMatch(/check:nightly-routine-prompt/);
  });
});

describe("nightly scheduler prompt live parity", () => {
  it("the tracked target equals a fresh render of both canonical docs", () => {
    const routine = readFileSync(join(REPO_ROOT, SOURCE_ROUTINE), "utf8");
    const guidelines = readFileSync(join(REPO_ROOT, SOURCE_GUIDELINES), "utf8");
    const target = readFileSync(join(REPO_ROOT, TARGET_PROMPT), "utf8");
    expect(target).toBe(renderNightlyRoutinePrompt(routine, guidelines));
  });

  it("names the free-provider launcher as the second lane and carries no retired helper", () => {
    const target = readFileSync(join(REPO_ROOT, TARGET_PROMPT), "utf8");
    // Owner determination 979bce8d, retargeted 2026-08-09: the second
    // independent lane is a separate free-provider session. The LAUNCHER owns
    // the routing mechanics (endpoint, key, model alias), so this prompt never
    // restates them and cannot drift from them — the same reasoning that
    // previously pointed at a skill, now that llm-relay is retired. The retired
    // llm-call.mjs helper (and the one-call-at-a-time serialization rule that
    // rode with it) must not resurface, and neither may a relay reference.
    expect(target).toContain("freellmapi\\claude.ps1");
    expect(target).not.toMatch(/llm-relay/);
    expect(target).not.toMatch(/llm-call\.mjs/);
    expect(target).not.toMatch(/one call at a time/i);
    expect(target).not.toMatch(/POST directly with a TASK-SHAPED json_schema/i);
  });

  it("retains the scheduler's executable insights and machine-output contracts", () => {
    const target = readFileSync(join(REPO_ROOT, TARGET_PROMPT), "utf8");
    expect(target).toContain(
      `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' claude -p "/insights"`,
    );
    expect(target).toContain('"suggestions_total": N');
    expect(target).toContain(
      "{ id, leg (docs|backlog|solutions), subject_key, path, title, eli5, question,",
    );
    expect(target).toContain("partitionBySettled(items, decisions, root)");
    expect(target).toContain("premise_probes[]");
    expect(target).toContain("writeOpenItems(root, { items: open, applied, skipped, run })");
  });

  it("the CLI parity check is green", () => {
    const result = spawnSyncHidden(process.execPath, [GENERATOR], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`).toBe(0);
  });

  it("the pre-commit gate runs parity for either source, the target, or the generator", () => {
    // The hook no longer hand-codes this trigger (P34): the leg and its
    // trigger derive from the guard-reach registry through the module the hook
    // imports. Assert the import, then assert the DERIVED leg fires on every
    // owned path against the live registry + live package.json.
    const hook = readFileSync(PRE_COMMIT_GATE, "utf8");
    expect(hook).toContain("derived-file-preflight.mjs");
    expect(hook).toContain("buildPreCommitLegs");
    const packageScripts = JSON.parse(readFileSync(join(REPO_ROOT, PACKAGE_JSON), "utf8")).scripts;
    const leg = buildPreCommitLegs({ packageScripts }).find(
      (l: { script: string }) => l.script === "check:nightly-routine-prompt",
    );
    expect(leg).toBeDefined();
    for (const path of [
      SOURCE_ROUTINE,
      SOURCE_GUIDELINES,
      TARGET_PROMPT,
      "scripts/check-nightly-routine-prompt.mjs",
      PACKAGE_JSON,
    ]) {
      expect(leg!.triggered({ root: REPO_ROOT, staged: [path] }), `${path} must trigger the leg`).toBe(true);
    }
  });
});
