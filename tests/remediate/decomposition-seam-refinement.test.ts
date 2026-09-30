import { expect, test } from "vitest";
import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";
import { hostDependencyLevels } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
test("same-file executable units stay distinct and explicit dependencies determine eligibility",()=>{
 const a=canonicalUnitFixture("A"),b=canonicalUnitFixture("B",{dependencies:["A"]});
 const state:RemediationState={status:"implementing",plan:canonicalPlanFixture({units:[a,b]}),items:{A:{unit_id:"A",status:"pending"},B:{unit_id:"B",status:"pending"}}};
 expect(hostDependencyLevels(state)[0]?.map(unit=>unit.id)).toEqual(["A"]);
 state.items!.A!.status="resolved";expect(hostDependencyLevels(state)[0]?.map(unit=>unit.id)).toEqual(["B"]);expect(state.plan?.units).toEqual([a,b]);
});
