#!/usr/bin/env node
// sites-pinned: tests/shared/script-argv-refusal.test.ts, tests/remediate/arbitrary-repository-gates.test.ts
// Gate-boundary smoke: the tool-owned final gate, executed for real, against a
// fixture repository — so a gate that cannot pass on a clean tree (or cannot
// FAIL on a broken one) fails the RELEASE, not a dogfood run.
//
// WHY THIS EXISTS. The node:test-runner bug (remediate-gate-nodetest-runner-bug,
// fixed v0.32.61) blocked EVERY remediate run, and no gate or release check
// caught it: the gate command only runs inside a live remediate *run*, and the
// unit test asserted the broken shape as correct. The packaged-bin smokes are
// siblings of this, but they only cover `--version` and the install surface — the
// GATE EXECUTION PATH had no end-to-end check at all.
//
// WHAT IT ACTUALLY RUNS. `runToolOwnedFinalGate` from the BUILT dist (the
// artifact the tarball ships), over a throwaway repository shaped like the
// audit-tools monorepo — `isAuditToolsMonorepo`'s markers plus the vitest gate
// script it checks for — whose `build`/`check`/`check:tests`/gate commands are
// stubs this smoke controls. Nothing is mocked: the gate derives its command
// list, spawns each command through the real `runTracked`, classifies the exit
// code, short-circuits the floor and records the failing command.
//
// THE THREE PROPERTIES, each of which has a recorded real-world failure behind it:
//   1. GREEN on a healthy tree. A gate that cannot pass on a clean tree blocks
//      every run (the node:test bug). If this smoke cannot get a clean fixture
//      green, the release fails.
//   2. RED, with the failing command NAMED and the floor SHORT-CIRCUITED, on a
//      broken tree. A gate that always passes is the false green the floor
//      exists to prevent; a red gate that names nothing is unattributable.
//   3. Generic targets run their declared gates. A target with no commands has
//      a blocking non-verdict (`scoped_out`, `passed: false`), never a vacuous
//      green. A missing monorepo marker must not suppress valid generic gates.
import "../shared/hermetic-state-dir.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { tmpdir } from "os";

const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const distGatePath = join(pkgRoot, "dist", "remediate", "steps", "finalGate.js");

let passed = 0;
let failed = 0;
const smokeStart = Date.now();

async function check(label, fn) {
  try {
    await fn();
    console.log(`  PASS ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}: ${/** @type {any} */ (err).message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log("smoke:remediate-gate");

if (!readFileSync(distGatePath, "utf8")) {
  console.error(`  FAIL the built gate module is missing at ${distGatePath} — run npm run build first`);
  process.exit(1);
}
const { runToolOwnedFinalGate, toolOwnedFinalGateCommands } = await import(
  pathToFileURL(distGatePath).href
);

/**
 * A repository shaped exactly like the audit-tools monorepo — the five layout
 * markers `isAuditToolsMonorepo` looks for, plus the vitest gate script it also
 * checks for. Without that script the generic project commands apply instead;
 * the missing monorepo-only script must never be invoked.
 *
 * The four gate commands are stubs driven by `state.json`, so this smoke decides
 * which layer fails without a real tsc/vitest ever running.
 */
function writeFixture(root) {
  mkdirSync(join(root, "src", "shared"), { recursive: true });
  mkdirSync(join(root, "src", "audit"), { recursive: true });
  mkdirSync(join(root, "src", "remediate"), { recursive: true });
  mkdirSync(join(root, "scripts", "shared"), { recursive: true });
  writeFileSync(join(root, "audit-code.mjs"), "// marker\n");
  writeFileSync(join(root, "remediate-code.mjs"), "// marker\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "fixture-monorepo",
    version: "0.0.0",
    private: true,
    scripts: {
      build: "node stub-layer.mjs build",
      check: "node stub-layer.mjs check",
      "check:tests": "node stub-layer.mjs check:tests",
    },
  }, null, 2) + "\n");
  // The gate runs the vitest gate script by path, not through npm — the stub
  // must exist for the scope predicate to admit this tree at all.
  writeFileSync(
    join(root, "scripts", "shared", "run-vitest-gate.mjs"),
    'import { readFileSync } from "node:fs";\n' +
      'const state = JSON.parse(readFileSync(new URL("../../state.json", import.meta.url), "utf8"));\n' +
      'if (state.unit !== "pass") {\n' +
      '  process.stderr.write("fixture-unit-layer-failed\\n");\n' +
      '  process.exit(1);\n' +
      "}\n" +
      'process.stdout.write("fixture-unit-layer-passed\\n");\n',
  );
  writeFileSync(
    join(root, "stub-layer.mjs"),
    "import { readFileSync, appendFileSync } from \"node:fs\";\n" +
      "const [layer] = process.argv.slice(2);\n" +
      "const state = JSON.parse(readFileSync(new URL(\"./state.json\", import.meta.url), \"utf8\"));\n" +
      "if (state[layer] !== \"pass\") {\n" +
      "  process.stderr.write(`fixture-${layer}-layer-failed\\n`);\n" +
      "  process.exit(1);\n" +
      "}\n" +
      "const output = `fixture-${layer}-layer-passed\\n`;\n" +
      "appendFileSync(new URL(\"./successful-output.log\", import.meta.url), output);\n" +
      "process.stdout.write(output);\n",
  );
  writeState(root, { build: "pass", check: "pass", "check:tests": "pass", unit: "pass" });
}

function writeState(root, state) {
  writeFileSync(join(root, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

const fixtureRoot = mkdtempSync(join(tmpdir(), "remediate-gate-smoke-"));

try {
  writeFixture(fixtureRoot);

  // ── 0. the derivation itself is non-vacuous on this shape ──────────────────
  const specs = toolOwnedFinalGateCommands(fixtureRoot);
  await check("the gate derives a non-vacuous command list on an audit-tools-shaped tree", () => {
    assert(specs.length >= 4, `expected the build/check/check:tests/unit floor, got ${specs.length} commands`);
    const layers = specs.map((s) => s.layer);
    for (const layer of ["build", "check", "unit"]) {
      assert(layers.includes(layer), `the floor is missing its ${layer} layer: ${JSON.stringify(layers)}`);
    }
    assert(
      specs.every((s) => !JSON.stringify(s.argv).includes("test_command")),
      "the floor must be independent of any plan.test_command (INV-RS-10)",
    );
    // Every unit command must be build-free — a unit leg that rebuilds dist races
    // the layer above it (CE-001 single-flight).
    for (const spec of specs.filter((s) => s.layer === "unit")) {
      assert(spec.build_free === true, `unit command ${spec.argv.join(" ")} is not build_free`);
    }
  });

  // ── 1. GREEN on a healthy tree ─────────────────────────────────────────────
  const green = await runToolOwnedFinalGate(fixtureRoot);
  await check("a HEALTHY tree goes green — a gate that cannot pass on a clean tree fails the release", () => {
    assert(green.passed === true, `expected a green gate, got passed=${green.passed}`);
    assert(green.outcome === "executed", `expected outcome "executed", got "${green.outcome}"`);
    assert(green.scoped_out === false, "an audit-tools-shaped tree must not scope out");
    assert(
      green.results.length === specs.length,
      `expected all ${specs.length} commands to run, got ${green.results.length}`,
    );
    assert(
      green.results.every((r) => r.exit_code === 0),
      `every command must exit 0: ${JSON.stringify(green.results.map((r) => [r.argv.join(" "), r.exit_code]))}`,
    );
  });

  // ── 2. RED, named and short-circuited, on a broken tree ────────────────────
  writeState(fixtureRoot, { build: "pass", check: "fail", "check:tests": "pass", unit: "pass" });
  const red = await runToolOwnedFinalGate(fixtureRoot);
  await check("a BROKEN check layer goes red, NAMES the command, and short-circuits the floor", () => {
    assert(red.passed === false, "a failing layer must fail the gate");
    assert(red.outcome === "executed", `a real verdict keeps outcome "executed", got "${red.outcome}"`);
    const failing = red.results.filter((r) => !r.passed);
    assert(failing.length === 1, `exactly one command should be reported as failing, got ${failing.length}`);
    assert(
      failing[0].argv.join(" ").includes("check"),
      `the failing command must be named: ${failing[0].argv.join(" ")}`,
    );
    assert(
      // The order is the floor's, and the fail-fast is the point: layers below a
      // broken one are meaningless.
      red.results.length === 2,
      `the floor must stop at the first failure (ran ${red.results.length} commands)`,
    );
    assert(
      typeof failing[0].stderr_tail === "string" && failing[0].stderr_tail.includes("fixture-check-layer-failed"),
      "the failing command's output must ride into the record — a red that names nothing is unattributable",
    );
  });

  // The red record the run pauses on must carry the same attribution.
  const { writeFinalGateRedRecord } = await import(pathToFileURL(distGatePath).href);
  await check("the persisted red record carries the failing command and its output tail", async () => {
    const artifactsDir = join(fixtureRoot, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const path = await writeFinalGateRedRecord(
      artifactsDir,
      "smoke",
      red.results.find((r) => !r.passed),
    );
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert(record.failing_command.includes("check"), `unexpected failing_command: ${record.failing_command}`);
    assert(record.exit_code !== 0, "the record must carry a non-zero exit code");
    assert(
      typeof record.stderr_tail === "string" && record.stderr_tail.includes("fixture-check-layer-failed"),
      "the record must carry the failing layer's output tail",
    );
  });

  // ── 3. the UNIT layer is really executed, not assumed ──────────────────────
  writeState(fixtureRoot, { build: "pass", check: "pass", "check:tests": "pass", unit: "fail" });
  const unitRed = await runToolOwnedFinalGate(fixtureRoot);
  await check("a broken UNIT layer is caught by the last command of the floor (the node:test-bug shape)", () => {
    assert(unitRed.passed === false, "a failing unit suite must fail the gate");
    const failing = unitRed.results.filter((r) => !r.passed);
    assert(failing.length === 1, `expected one failing command, got ${failing.length}`);
    assert(
      failing[0].argv.join(" ").includes("run-vitest-gate.mjs"),
      `the unit leg must run the vitest gate script, got: ${failing[0].argv.join(" ")}`,
    );
    assert(
      unitRed.results.length === specs.length,
      "the unit layer is LAST, so every earlier layer must have run",
    );
  });

  // ── 4. no declared commands means a BLOCKING non-verdict ─────────────────
  const bare = mkdtempSync(join(tmpdir(), "remediate-gate-smoke-bare-"));
  try {
    writeFileSync(join(bare, "README.md"), "# not a monorepo\n");
    const scoped = await runToolOwnedFinalGate(bare);
    await check("a target with no declared commands is blocked, never a vacuous green", () => {
      assert(scoped.outcome === "scoped_out", `expected scoped_out, got "${scoped.outcome}"`);
      assert(scoped.scoped_out === true, "scoped_out must be stated");
      assert(scoped.passed === false, "a no-command target must block completion, never pass");
      assert(scoped.results.length === 0, "a scoped-out gate runs nothing");
    });
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // Missing the monorepo-only gate script selects generic discovery. All four
  // explicitly declared legs still run, without inferring that `check` means
  // typechecking or attempting to execute a nonexistent monorepo script.
  const partial = mkdtempSync(join(tmpdir(), "remediate-gate-smoke-partial-"));
  try {
    writeFixture(partial);
    rmSync(join(partial, "scripts"), { recursive: true, force: true });
    const manifest = JSON.parse(readFileSync(join(partial, "package.json"), "utf8"));
    for (const role of ["typecheck", "lint", "test"]) {
      manifest.scripts[role] = `node stub-layer.mjs ${role}`;
    }
    writeFileSync(join(partial, "package.json"), JSON.stringify(manifest) + "\n");
    const healthy = { build: "pass", typecheck: "pass", lint: "pass", test: "pass" };
    writeState(partial, healthy);
    const genericSpecs = toolOwnedFinalGateCommands(partial);
    const generic = await runToolOwnedFinalGate(partial);
    await check("a target WITHOUT the monorepo gate script executes every declared generic gate", () => {
      const roles = ["build", "typecheck", "lint", "test"];
      assert(generic.outcome === "executed" && generic.scoped_out === false,
        "declared generic gates must execute instead of scoping out");
      assert(generic.passed === true, "healthy declared commands must pass");
      assert(genericSpecs.length === roles.length && generic.results.length === roles.length,
        "all four declared legs must run, without undeclared monorepo commands");
      // Successful gate results deliberately omit output tails. The spawned
      // fixture records the same bytes it writes to stdout, so execution/output
      // evidence does not depend on a failure-only result field.
      const observedOutput = readFileSync(join(partial, "successful-output.log"), "utf8");
      assert(observedOutput === roles.map(role => `fixture-${role}-layer-passed\n`).join(""),
        "each declared command must actually produce its expected output in order");
      for (const [index, role] of roles.entries()) {
        const result = generic.results[index];
        assert(result.argv.join(" ") === genericSpecs[index].argv.join(" "),
          "executed command must match its declaration");
        assert(result.exit_code === 0 && result.passed === true,
          `declared ${role} leg must actually execute successfully in order`);
      }
    });
    writeState(partial, { ...healthy, typecheck: "fail" });
    const genericRed = await runToolOwnedFinalGate(partial);
    await check("a failed generic typecheck blocks completion and short-circuits later declared gates", () => {
      assert(genericRed.outcome === "executed" && genericRed.passed === false,
        "a failed declared command must never become a green or a non-verdict");
      assert(genericRed.results.length === 2, "build runs, typecheck fails, lint and test must not run");
      const failure = genericRed.results[1];
      assert(failure.exit_code !== 0 && failure.stderr_tail.includes("fixture-typecheck-layer-failed"),
        "the generic failure must preserve its attributable output");
    });
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

// A stray child would keep this process alive after the checks; the smoke's own
// exit code is the verdict the gate step reads.
console.log(`\n${passed} passed, ${failed} failed (${Date.now() - smokeStart}ms total)`);
if (failed > 0) process.exit(1);
