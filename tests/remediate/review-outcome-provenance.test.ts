import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { readContractReviewOutcomes } from "../../src/remediate/phases/closeReviewProvenance.js";
import { RemediationOutcomesReportSchema } from "../../src/shared/types/remediationOutcome.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import type { ClosingResult } from "../../src/remediate/phases/close.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
const receipt={requirement:"independent",binding:"b".repeat(64),review:{mode:"independent",reason:"Fresh independent context"},summary:"Evidence satisfies the reviewed requirement"} as const;
const closing: ClosingResult={contract_version:"remediate-code-closing-result/v1alpha1",action:"none",status:"skipped",commands:[]};
function state():RemediationState{return {status:"complete",plan:canonicalPlanFixture({units:[canonicalUnitFixture("U")],requirements:[{id:"REQ-U",description:"Bounded change",source_finding_ids:[],change_kind:"addition",assertions:[{kind:"positive",description:"Expected result",scope_paths:["src/a.ts"]}]}]}),items:{U:{unit_id:"U",status:"resolved",conformance_review:receipt}}};}
test("machine outcomes retain accepted plan and execution review provenance without invented findings",async()=>{
 const root=await mkdtemp(join(tmpdir(),"review-provenance-"));try{const artifactsDir=join(root,".audit-tools","remediation");const s=state();await writeApprovedPlanFixture(artifactsDir,s);const reviews=await readContractReviewOutcomes(artifactsDir);const report=buildRemediationOutcomesReport(s,closing,undefined,undefined,reviews);expect(report.outcomes).toEqual([]);expect(report.execution_outcomes[0]?.conformance_review).toEqual(receipt);expect(report.contract_reviews).toHaveLength(3);expect(RemediationOutcomesReportSchema.parse(report).contract_reviews?.[2]?.role).toBe("judge");}finally{await rm(root,{recursive:true,force:true});}
});
test("default-off execution outcomes never fabricate reviewed success",()=>{const s=state();delete s.items!.U!.conformance_review;const report=buildRemediationOutcomesReport(s,closing);expect(report.execution_outcomes[0]).not.toHaveProperty("conformance_review");expect(report).not.toHaveProperty("contract_reviews");});
