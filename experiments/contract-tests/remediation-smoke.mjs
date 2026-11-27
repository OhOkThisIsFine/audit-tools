import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

test("remediation records a real verification failure, then green after the source is fixed", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "remediation-contract-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("remediation-contract-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const artifactsDir = join(root, ".audit-tools", "remediation");
  await mkdir(artifactsDir, { recursive: true });
  const { runToolOwnedFinalGate, writeFinalGateOutcomeRecord } = await load("remediate/steps/finalGate.js");
  const { buildRemediationOutcomesReport, readFinalGateReport } = await load("remediate/phases/close.js");
  const { RemediationOutcomesReportSchema } = await load("shared/types/remediationOutcome.js");
  assert.equal((await runToolOwnedFinalGate(root)).outcome, "scoped_out");
  await writeFile(join(root, "package.json"), JSON.stringify({name:"remediation-fixture",private:true,scripts:{test:"node verify.mjs"}}));
  await writeFile(join(root, "verify.mjs"), 'import assert from "node:assert/strict"; import {title} from "./title.mjs"; assert.equal(title(2),"Transactions (2)");');
  const title = join(root, "title.mjs");
  await writeFile(title, 'export const title = count => "Transactions";');
  const red = await runToolOwnedFinalGate(root);
  assert.equal(red.outcome,"executed");
  assert.equal(red.passed,false);
  assert.equal(red.results.length,1);
  assert.equal(red.results[0].exit_code,1);
  assert.match(red.results[0].stderr_tail,/AssertionError/);
  const report = async (gate, state) => {
    await writeFinalGateOutcomeRecord(artifactsDir,{scope:"fixture verification",outcome:gate.outcome,passed:gate.passed,commands_run:gate.results.length});
    const model=buildRemediationOutcomesReport(state,{contract_version:"remediate-code-closing-result/v1alpha1",action:"none",status:"skipped",commands:[]},await readFinalGateReport(artifactsDir));
    return RemediationOutcomesReportSchema.parse(model);
  };
  const state = { status:"closing", plan:{units:[{id:"title",title:"Show count",source_finding_ids:[],required_tests:["node verify.mjs"]}]},
    items:{title:{unit_id:"title",status:"blocked",failure_reason:"The title did not include its count."}} };
  const blocked = await report(red,state);
  assert.equal(blocked.final_gate.passed,false);
  assert.equal(blocked.execution_outcomes[0].status,"blocked");

  await writeFile(title,'export const title = count => "Transactions (" + count + ")";');
  const green = await runToolOwnedFinalGate(root);
  assert.equal(green.passed,true);
  assert.equal(green.results.length,1);
  const fixed = await report(green,{...state,items:{title:{unit_id:"title",status:"resolved",host_result_evidence:["Executed the title test."]}}});
  assert.equal(fixed.final_gate.passed,true);
  assert.deepEqual(fixed.execution_outcomes[0].evidence,["Executed the title test."]);
  assert.equal(fixed.execution_outcomes[0].status,"resolved");
});
