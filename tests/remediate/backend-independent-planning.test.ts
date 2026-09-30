import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutablePlanFixture, approveExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { readCanonicalPlan, ingestExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/index.js";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("planning records verification commands without executing them or launching a backend",async()=>{
 const f=await createExecutablePlanFixture();roots.push(f.root);const prior=(await readCanonicalPlan(f.artifactsDir))!;
 await writeFile(join(f.root,"planning-probe.cjs"),"require('node:fs').writeFileSync('unexpected-planning-spawn', 'bad');\n");
 f.plan.units[0]!.read_paths.push("planning-probe.cjs");
 f.plan.units[0]!.required_tests=["node planning-probe.cjs"];
 await writeJsonFile(f.paths.submission,{base_revision_sha256:prior.revision_sha256,plan:f.plan,retired_requirements:[]});expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
 await approveExecutablePlanFixture(f);expect(existsSync(join(f.root,"unexpected-planning-spawn"))).toBe(false);
});
