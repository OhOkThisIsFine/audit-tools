import { afterEach, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { createExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { executionPlanContextIssues, ingestExecutionPlan, readCanonicalPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/index.js";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(name="a.ts"){
 const f=await createExecutablePlanFixture();roots.push(f.root);const git=(...args:string[])=>{const result=spawnSync("git",args,{cwd:f.root,encoding:"utf8"});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();};
 await mkdir(join(f.root,"src"),{recursive:true});await writeFile(join(f.root,"src",name),"old a");await writeFile(join(f.root,"src","b.ts"),"old b");git("init","-q");git("config","user.email","test@example.test");git("config","user.name","Test");git("add","src");git("commit","-qm","baseline");
 const prior=(await readCanonicalPlan(f.artifactsDir))!;f.plan.units[0]!.read_paths=["src/"];f.plan.units[0]!.allowed_files=[`src/${name}`];await writeJsonFile(f.paths.submission,{base_revision_sha256:prior.revision_sha256,plan:f.plan,retired_requirements:[]});expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
 return {...f,git,canonical:(await readCanonicalPlan(f.artifactsDir))!,name};
}
test("an accepted commit cannot explain unrelated earlier changes merely present in its tree",async()=>{
 const f=await fixture();await writeFile(join(f.root,"src","b.ts"),"unrelated changed b");f.git("add","src/b.ts");f.git("commit","-qm","unrelated");await writeFile(join(f.root,"src","a.ts"),"approved a");f.git("add","src/a.ts");f.git("commit","-qm","accepted unit");
 const issues=await executionPlanContextIssues(f.root,f.canonical,[{allowed_files:["src/a.ts"],landed_commit:f.git("rev-parse","HEAD")}]);expect(issues.join(" ")).toContain("src/b.ts");expect(issues.join(" ")).not.toContain("src/a.ts");
});
test.each(["évidence.ts","literal[ab].ts"])("accepted leaf %s uses literal NUL-delimited Git paths",async name=>{
 const f=await fixture(name);await writeFile(join(f.root,"src",f.name),"approved unusual filename change");f.git("add",`:(literal)src/${f.name}`);f.git("commit","-qm","accepted unusual filename unit");
 expect(await executionPlanContextIssues(f.root,f.canonical,[{allowed_files:[`src/${f.name}`],landed_commit:f.git("rev-parse","HEAD")}])).toEqual([]);
});
test.skipIf(process.platform==="win32").each(["line\nbreak.ts","literal*?.ts"])("accepted POSIX leaf %s uses literal NUL-delimited Git paths",async name=>{
 const f=await fixture(name);await writeFile(join(f.root,"src",f.name),"approved POSIX filename change");f.git("add",`:(literal)src/${f.name}`);f.git("commit","-qm","accepted POSIX filename unit");
 expect(await executionPlanContextIssues(f.root,f.canonical,[{allowed_files:[`src/${f.name}`],landed_commit:f.git("rev-parse","HEAD")}])).toEqual([]);
});
test("untracked new context files are not covered by an earlier accepted commit",async()=>{
 const f=await fixture();await writeFile(join(f.root,"src","new.ts"),"unreviewed file");expect((await executionPlanContextIssues(f.root,f.canonical)).join(" ")).toContain("src/new.ts");
});
