// sites-pinned: tests/audit/review-submission.test.ts, tests/audit/conceptual-charter-context.test.ts
import { charterReviewDisposition, resolveRunBoundDesignReview, type IntentCheckpoint } from "audit-tools/shared";
import { selectPerspectives } from "../../shared/types/conceptualPerspective.js";
import { degradedAnalyzerEntries, type AnalyzerCapabilityRecord } from "../types/analyzerCapability.js";
import type { CharterRegister } from "../types/charterRegister.js";
import { resolveIntentLensSelection } from "./lensSelection.js";

export interface DesignReviewTaskBundle {
  intent_checkpoint?: IntentCheckpoint;
  charter_register?: CharterRegister;
  analyzer_capability?: AnalyzerCapabilityRecord;
}

/** Effective task choices only: confirmation timestamps and notices are provenance. */
export function resolveDesignReviewChoices(bundle: DesignReviewTaskBundle) {
  const settings = resolveRunBoundDesignReview(bundle.intent_checkpoint);
  return {
    lenses: resolveIntentLensSelection(bundle.intent_checkpoint?.lens_selection),
    conceptual_depth: settings?.conceptual_depth ?? (Array.isArray(settings?.perspectives) ? "deep" as const : "shallow" as const),
    perspectives: settings?.perspectives,
  };
}

/** The linked accounts actually rendered to conceptual reviewers, in rendered order. */
export function projectConceptualCharterContext(bundle: DesignReviewTaskBundle) {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") return [];
  return (register.correspondences ?? []).map((correspondence) => ({
    correspondence_id: correspondence.correspondence_id,
    accounts: correspondence.members.flatMap((member) => {
      const graph = register.lanes.find((lane) => lane.kind === member.kind);
      return member.node_ids.flatMap((id) => {
        const node = graph?.nodes.find((candidate) => candidate.node_id === id);
        return node ? [{ kind: member.kind, purpose: node.purpose, files: [...(node.files ?? [])].sort(), disposition: charterReviewDisposition(node) }] : [];
      });
    }),
  }));
}

export function projectDesignReviewTask(bundle: DesignReviewTaskBundle, pass: "contract" | "conceptual") {
  const choices = resolveDesignReviewChoices(bundle);
  const common = {
    lenses: choices.lenses ? [...choices.lenses].sort() : null,
    degraded_analyzers: [...new Set(degradedAnalyzerEntries(bundle.analyzer_capability).map((entry) => entry.id))].sort(),
  };
  return pass === "contract" ? common : {
    ...common,
    conceptual_depth: choices.conceptual_depth,
    perspectives: choices.conceptual_depth === "deep" ? selectPerspectives(choices.perspectives) : [],
    charter_context: projectConceptualCharterContext(bundle),
  };
}
