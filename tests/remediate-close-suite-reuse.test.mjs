import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

async function closeFixture(t, changes = {}) {
  // The owned spawn redacts the Windows sandbox tmpdir's identifier from
  // captured stdout. Keep the test checkout in an ignored, stable path so
  // npm prefix can prove the actual project root without bypassing redaction.
  const fixtures = join(await realpath(checkout), ".audit-tools", "close-suite-fixtures");
  await mkdir(fixtures, { recursive: true });
  const parent = await realpath(fixtures);
  const root = await mkdtemp(join(parent, "close-suite-"));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  const artifactsDir = join(root, ".audit-tools", "remediation-custom");
  const options = { root, artifactsDir };
  const { executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readExecutionIntent } = await load("remediate/contractPipeline/executionPlan.js");
  const { intakePaths } = await load("remediate/intake.js");
  const { readFinalGateReport, runClosePhase } = await load("remediate/phases/close.js");
  const paths = executionPlanPaths(artifactsDir);
  const put = (path, value) => writeFile(path, JSON.stringify(value));
  await mkdir(paths.directory, { recursive: true });
  for (const dir of ["src/shared","src/audit","src/remediate","scripts/shared","tests","node_modules/.bin"]) {
    await mkdir(join(root,dir), { recursive: true });
  }
  const fullLanding = changes.landing === "full";
  const lint = fullLanding || changes.landing === "lint";
  const glossary = fullLanding || changes.landing === "glossary";
  const scripts = {
    prebuild: "node scripts/shared/guard-no-suite-running.mjs",
    build: "node scripts/shared/clean-dist.mjs && tsc -p tsconfig.json",
    check: "tsc -p tsconfig.json --noEmit",
    "check:tests": "node scripts/shared/run-contract-tests.mjs --check",
    test: "npm run build && npm run test:built",
    "test:built": "node scripts/shared/run-contract-tests.mjs",
    "verify:guards": "npm run test:built",
    ...(glossary ? { "check:invariant-glossary": "node scripts/check-invariant-glossary.mjs" } : {}),
    ...(fullLanding ? {
      "check:deadcode": "knip --no-config-hints",
      "check:depgraph": "depcruise --config .dependency-cruiser.cjs src",
    } : {}),
    ...(lint ? { "check:lint": "eslint ." } : {}),
    ...changes.scripts,
  };
  const log = (label) => `import { appendFileSync } from "node:fs"; appendFileSync(".git/fixture-trace", ${JSON.stringify(label + "\n")});`;
  if (changes.noAdvisory) delete scripts["verify:guards"];
  if (changes.inheritPrefix) {
    const oldPrefix = process.env.npm_config_prefix;
    process.env.npm_config_prefix = oldPrefix ?? checkout;
    t.after(() => {
      if (oldPrefix === undefined) delete process.env.npm_config_prefix;
      else process.env.npm_config_prefix = oldPrefix;
    });
  }
  if (changes.globalIgnoreScripts) {
    const oldGlobal = process.env.npm_config_globalconfig;
    const globalConfig = join(root, "global.npmrc");
    await writeFile(globalConfig, "ignore-scripts=true\n");
    process.env.npm_config_globalconfig = globalConfig;
    t.after(() => {
      if (oldGlobal === undefined) delete process.env.npm_config_globalconfig;
      else process.env.npm_config_globalconfig = oldGlobal;
    });
  }
  await put(join(root, "package.json"), { name: "audit-tools", scripts });
  await writeFile(join(root, ".gitignore"), ".audit-tools/\ndist/\nnode_modules/\n.claude/hooks/.state/\n");
  for (const file of ["audit-code.mjs","remediate-code.mjs"]) await writeFile(join(root,file),"");
  await writeFile(join(root, "title.mjs"), "export const title = count => String(count);");
  await writeFile(join(root, "scripts/shared/guard-no-suite-running.mjs"), log("prebuild"));
  await writeFile(join(root, "scripts/shared/clean-dist.mjs"),
    `${log("build")} import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist",{recursive:true}); writeFileSync("dist/built.js","start");`);
  const leaf = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"; import {resolve} from "node:path"; const raw = process.argv.slice(2); const label = raw[0] === "--check" ? "check:tests" : "suite:" + (process.env.npm_lifecycle_event === "test:built" && resolve(process.env.npm_package_json ?? "") === resolve("package.json") ? "test:built" : "node") + ":" + readFileSync("dist/built.js", "utf8"); appendFileSync(".git/fixture-trace", label + "\\n"); if(raw[0] !== "--check") { mkdirSync(".claude/hooks/.state/suite-green",{recursive:true}); writeFileSync(".claude/hooks/.state/suite-green/latest.json","fixture"); if(${Boolean(changes.leafMutates)}) writeFileSync("dist/built.js","changed in suite"); if(${Boolean(changes.red)}) process.exitCode=1; }`;
  await writeFile(join(root,"scripts/shared/run-contract-tests.mjs"), leaf);
  if (glossary) await writeFile(join(root,"scripts/check-invariant-glossary.mjs"), `${log("glossary")} ${changes.mutate ? 'import {writeFileSync} from "node:fs"; writeFileSync("dist/built.js","changed");' : ""}`);
  await writeFile(join(root,"scripts/hook.mjs"),log("hook"));
  if (changes.failingSuite) {
    await writeFile(join(root, "scripts/failure.mjs"), `${log(changes.failingSuite)} process.exitCode = 1;`);
  }
  await writeFile(join(root,"tsc-fixture.mjs"), `import {appendFileSync,readFileSync,writeFileSync} from "node:fs"; if(process.argv.includes("--noEmit")){ appendFileSync(".git/fixture-trace","check\\n"); if(${Boolean(changes.revoke)}){const pkg=JSON.parse(readFileSync("package.json")); delete pkg.scripts.test; writeFileSync("package.json",JSON.stringify(pkg));} }`);
  await writeFile(join(root,"node_modules/fixture-runtime.mjs"), "original");
  await writeFile(join(root,"node_modules/.bin/tsc"), '#!/bin/sh\nnode tsc-fixture.mjs "$@"\n', { mode: 0o755 });
  await writeFile(join(root,"node_modules/.bin/tsc.cmd"), '@node tsc-fixture.mjs %*\r\n');
  if (lint) {
    // Real npm command discovery and lifecycle, with local synthetic stand-ins
    // for the tool executables so the test does not invoke this repo's gates.
    const shims = { ...(fullLanding ? { knip: "deadcode", depcruise: "depgraph" } : {}), eslint: "lint" };
    await writeFile(join(root,"landing-fixture.mjs"), `
      import { appendFileSync, writeFileSync } from "node:fs";
      const [role, ...args] = process.argv.slice(2);
      appendFileSync(".git/fixture-trace", role + ":" + args.join(" ") + "\\n");
      if (role === "lint" && ${Boolean(changes.mutateDependency)}) {
        writeFileSync("node_modules/fixture-runtime.mjs", "changed");
      }
    `);
    for (const [bin, role] of Object.entries(shims)) {
      await writeFile(join(root,"node_modules/.bin", bin), `#!/bin/sh\nnode landing-fixture.mjs ${role} "$@"\n`, { mode: 0o755 });
      await writeFile(join(root,"node_modules/.bin", bin + ".cmd"), `@node landing-fixture.mjs ${role} %*\r\n`);
    }
  }
  const git = (...args) => execFileSync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  git("init","--template=","-q");
  git("config","core.autocrlf","false");
  git("add",".");
  git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--no-gpg-sign","-qm","Baseline");
  const checkpoint = intakePaths(artifactsDir).intentCheckpoint;
  await mkdir(resolve(checkpoint,".."),{recursive:true});
  await put(checkpoint,{schema_version:"intent-checkpoint/v1",confirmed_by:"host",confirmed_at:new Date().toISOString(),
    scope_summary:"Fixture only",intent_summary:"Show the title count",closing_action:"none"});
  const request = {id:"title-request",text:"Expose the item count in the title",source_paths:[]};
  await put(paths.source,{plan_id:"title-plan",findings:[],request,audit_read:null,sources:[],intent:await readExecutionIntent(artifactsDir)});
  const plan = {
    plan_id:"title-plan", objective:"Show the item count", non_goals:[],
    requirements:[{id:"title-count",description:"The title should contain its item count",source_finding_ids:[],change_kind:"behavior_change",
      assertions:[
        {kind:"positive",description:"Two items are shown as a count of two",scope_paths:["title.mjs"]},
        {kind:"negative",description:"Zero items do not use a made-up count",scope_paths:["title.mjs"]}
      ]}],
    units:[{id:"title",title:"Fix title",description:"Include the actual count",source_finding_ids:[],requirement_ids:["title-count"],dependencies:[],
      read_paths:["title.mjs"],allowed_files:["title.mjs"],required_tests:[],affected_interfaces:[],addresses_counterexample_ids:[]}],
    source_dispositions:[]
  };
  const submission={base_revision_sha256:null,plan};
  await put(paths.submission,submission);
  assert.deepEqual(await ingestExecutionPlan(options),{changed:true,issues:[]});
  const canonical = await readCanonicalPlan(artifactsDir);
  assert.equal(canonical.plan.plan_id,"title-plan");
  assert.match(canonical.revision_sha256,/^[0-9a-f]{64}$/);

  const state={status:"closing",run_start_dirty:[],run_start_dirty_encoding:"git-z/v1",
    plan:{...canonical.plan,request,review_revision_sha256:canonical.revision_sha256,findings:[],project_type:"node",candidate_closing_actions:["none"],test_command:"npm test",test_command_source:"project_facts"},
    items:{title:{unit_id:"title",status:"resolved"}},closing_plan:{action:"none"}};

  // Simulate the completed review inputs to isolate the real closing boundary.
  // These records belong only to this fixture; no reviewer or user is contacted.
  const { contentSha256 } = await load("shared/index.js");
  const hash = contentSha256;
  const revision = canonical.revision_sha256;
  const history = {counterexamples:[],accepted_ids:[],repair_rounds:0};
  const review = { mode:"independent",reason:"Synthetic independent-answer fixture." };
  const reviewResults = {
    critique:{verdict:"approved",issues:[]},
    critic:{counterexamples:[]},
    judge:{verdict:"approved",classifications:[],requirement_assessments:[
      {requirement_id:"title-count",verdict:"satisfied",evidence:["The fixture covers the count behavior."]}],
      disposition_assessments:[]}
  };
  const reviewHashes = {};
  for (const [role,result] of Object.entries(reviewResults)) {
    const input = hash({role,revision});
    const receipt = {revision_sha256:revision,role,input_sha256:input,
      provenance:{requirement:"independent",prompt_sha256:input,review,reviewed_content_hash:revision},result};
    await put(paths.review(role).accepted,receipt);
    reviewHashes[role] = hash(receipt);
  }
  await put(paths.history,history);
  await put(paths.approval,{revision_sha256:revision,judge_input_sha256:hash({role:"judge",revision}),
    owner_decision_sha256:hash(null),risk_decision_sha256:hash(null),history_sha256:hash(history),review_sha256:reviewHashes});

  if (changes.explicit) {
    state.plan.test_command = "node scripts/hook.mjs";
    state.plan.test_command_source = "explicit";
  }
  if (changes.failingSuite) {
    const failure = "node scripts/failure.mjs";
    if (changes.failingSuite === "combined") {
      state.plan.test_command = failure;
      state.plan.test_command_source = "explicit";
    } else {
      delete state.plan.test_command;
      delete state.plan.test_command_source;
      state.plan.e2e_command = failure;
      state.plan.e2e_command_source = "explicit";
    }
    if (changes.noReblock) state.items.title.status = "ignored";
    options.skipFinalGate = true;
  }
  const result = await runClosePhase(state, options);
  const trace = (await readFile(join(root,".git","fixture-trace"),"utf8")).trim().split("\n");
  const floor = await readFinalGateReport(artifactsDir);
  const report = result.status === "complete"
    ? await readFile(join(root,".audit-tools","remediation-report.md"),"utf8") : "";
  return { result, trace, floor, report };
}

test("the native default close ignores an inherited npm prefix and observes one project-local suite after guarded build and checks", async t => {
  const {result, trace, report} = await closeFixture(t,{landing:"full",inheritPrefix:true});
  assert.equal(result.status, "complete");
  assert.deepEqual(trace, [
    "prebuild", "build", "check", "check:tests", "suite:test:built:start",
    "deadcode:--no-config-hints", "depgraph:--config .dependency-cruiser.cjs src", "glossary", "lint:.",
  ]);
  assert.match(report, /repository build\/typecheck\/test floor RAN \(4 commands?\(s\)\) and PASSED/);
  assert.match(report, /Combined evidence: guarded build and terminal `npm run test:built` from the final floor/);
  assert.match(report, /Landing Gates \(advisory\)/);
  assert.match(report, /Reused observation from final floor: npm run test:built; wrapper not rerun/);
});

test("a preceding check changes ignored build output, so the advisory guard runs independently", async t => {
  const {trace, report} = await closeFixture(t,{mutate:true,landing:"glossary"});
  assert.deepEqual(trace.filter(s=>s.startsWith("suite:")), ["suite:test:built:start","suite:test:built:changed"]);
  assert.doesNotMatch(report,/Reused observation/);
});

test("even exact lint cannot lend guard green after changing installed runtime bytes", async t => {
  const {trace, report} = await closeFixture(t,{landing:"lint",mutateDependency:true});
  assert.deepEqual(trace.slice(-2), ["lint:.","suite:test:built:start"]);
  assert.doesNotMatch(report,/Reused observation/);
});

test("native landing reuse recognizes only exact hook-free lint scripts and guard aliases", async t => {
  // The end-to-end witness above exercises actual discovery, execution, and
  // reuse. Script eligibility itself needs no Git, builds, or npm processes.
  const { nativePriorLandingCheck, nativeGuardAlias } = await load("remediate/steps/gateCommands.js");
  const parent = join(await realpath(checkout), ".audit-tools");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(await realpath(parent), "close-suite-policy-"));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  const putScripts = scripts => writeFile(join(root, "package.json"), JSON.stringify({ name: "audit-tools", scripts }));
  const lint = "npm run check:lint";
  const exact = { "check:lint": "eslint .", "verify:guards": "npm run test:built" };
  await putScripts(exact);
  assert.equal(nativePriorLandingCheck(root, lint), true);
  assert.equal(nativeGuardAlias(root), true);
  for (const scripts of [
    { ...exact, "check:lint": "eslint --no-cache ." },
    { ...exact, "precheck:lint": "node scripts/hook.mjs" },
    { ...exact, "postcheck:lint": "node scripts/hook.mjs" },
  ]) {
    await putScripts(scripts);
    assert.equal(nativePriorLandingCheck(root, lint), false);
    assert.equal(nativeGuardAlias(root), true);
  }
  for (const hook of ["preverify:guards", "postverify:guards"]) {
    await putScripts({ ...exact, [hook]: "node scripts/hook.mjs" });
    assert.equal(nativePriorLandingCheck(root, lint), true);
    assert.equal(nativeGuardAlias(root), false);
  }
});

test("a non-native prior landing script runs and breaks the reuse chain", async t => {
  const { verifyLandingGates } = await load("remediate/phases/closeVerifyLandingGates.js");
  const parent = join(await realpath(checkout), ".audit-tools");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(await realpath(parent), "close-suite-landing-"));
  t.after(async () => {
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, "trace.mjs"),
    'import { appendFileSync } from "node:fs"; appendFileSync("trace", process.argv[2] + "\\n");');
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "audit-tools", scripts: {
      "check:lint": "node trace.mjs lint",
      "precheck:lint": "node trace.mjs hook",
      "verify:guards": "npm run test:built",
      "test:built": "node trace.mjs suite",
    },
  }));
  const outcome = await verifyLandingGates({
    root, timeoutMs: 60_000,
    recheckNativeGuard: async () => { assert.fail("must not consult the earlier observation"); },
  });
  assert.equal(outcome.passed, true, JSON.stringify(outcome.gates));
  assert.deepEqual(outcome.gates.map(gate => [gate.command, gate.reused_from]),
    [["npm run check:lint", undefined], ["npm run verify:guards", undefined]]);
  assert.equal(await readFile(join(root, "trace"), "utf8"), "hook\nlint\nsuite\n");
});

test("an explicit distinct command is not borrowed", async t => {
  const {trace, report} = await closeFixture(t,{explicit:true});
  assert.deepEqual(trace.filter(s=>s.startsWith("suite:") || s==="hook"), ["suite:node:start","hook","suite:test:built:start"]);
  assert.doesNotMatch(report,/Reused observation|Combined evidence/);
});

test("a failed native terminal cannot lend a verdict or reach advisory", async t => {
  const {result, trace, floor} = await closeFixture(t,{red:true});
  assert.equal(result.status,"closing");
  assert.equal(floor.passed,false);
  assert.deepEqual(trace,["prebuild","build","check","check:tests","suite:test:built:start"]);
});

test("a leaf that mutates ignored output cannot supply green even when no guard alias exists", async t => {
  const {result, trace, floor} = await closeFixture(t,{leafMutates:true,noAdvisory:true});
  assert.equal(result.status,"closing");
  assert.equal(floor.passed,false);
  assert.deepEqual(trace,["prebuild","build","check","check:tests","suite:test:built:start"]);
});

test("effective redirected global lifecycle configuration prevents the native split", async t => {
  const {trace, report} = await closeFixture(t,{globalIgnoreScripts:true});
  assert.ok(!trace.includes("prebuild"), "npm's effective global ignore-scripts actually applied");
  assert.deepEqual(trace.filter(s=>s.startsWith("suite:")),
    ["suite:node:start","suite:test:built:start","suite:test:built:start"]);
  assert.doesNotMatch(report,/Reused observation|Combined evidence/);
});

test("an actual nonexistent executable is not an observed native leaf", async () => {
  const { runTrackedAsync } = await load("shared/index.js");
  const { observedNativeCloseLeaf } = await load("remediate/phases/closeAcceptance.js");
  const result = await runTrackedAsync(["audit-tools-nonexistent-fixture-executable-dc50c7"]);
  assert.equal(result.status,null);
  assert.ok(result.error);
  assert.equal(observedNativeCloseLeaf(result),false);
});

test("a build/check that revokes late project-test admission cannot borrow green", async t => {
  const {trace, result, report} = await closeFixture(t,{revoke:true});
  assert.deepEqual(trace.filter(s=>s.startsWith("suite:")),["suite:node:start"]);
  assert.equal(result.status,"triage");
  assert.equal(report,"");
});

for (const [failingSuite, warning] of [
  ["combined", /completing with test failure recorded in report/],
  ["e2e", /completing with e2e failure recorded in report/],
]) {
  for (const noReblock of [false, true]) {
    test(`${failingSuite} failure ${noReblock ? "continues reporting without announcing triage" : "announces and returns triage"}`, async t => {
      const messages = [];
      for (const method of ["log", "warn"]) {
        t.mock.method(console, method, (...args) => messages.push(args.join(" ")));
      }
      const { result, trace, report } = await closeFixture(t, { failingSuite, noReblock, noAdvisory: true });
      assert.equal(trace.filter(label => label === failingSuite).length, 1);
      const triage = messages.filter(line => /transitioning .*triage/i.test(line));
      const continuation = messages.filter(line => warning.test(line));
      if (noReblock) {
        assert.equal(result.status, "complete");
        assert.equal(result.items.title.status, "ignored");
        assert.equal(triage.length, 0);
        assert.equal(continuation.length, 1);
        assert.match(report, failingSuite === "combined" ? /## Combined Test Suite Failure/ : /End-to-end tests: failed/);
      } else {
        assert.equal(result.status, "triage");
        assert.equal(result.items.title.status, "blocked");
        assert.equal(triage.length, 1);
        assert.equal(continuation.length, 0);
      }
    });
  }
}
