// sites-pinned: tests/audit/conceptual-perspective-round-identity.test.ts, tests/audit/review-submission.test.ts
import { z } from "zod";

export interface ConceptualPerspective {
  name: string;
  /** The value system this reviewer judges the codebase through. */
  lens: string;
}

/**
 * Built-in conceptual perspectives. Each is a maximally dissimilar value system
 * so the union covers angles no single pass would. A reviewer may sharpen its
 * lens to the codebase, but stays in character.
 *
 * ORDER CARRIES NO MEANING. This list used to be documented as "ordered
 * most-to-least commonly useful", and the fan-out took the first N — which made
 * the last entries unreachable at any narrowed count. That ranking was never
 * measured: findings record a `lens`, never the perspective that produced them,
 * so nothing in this repo can say which reviewer contributes what. The claim was
 * removed rather than re-stated (owner, 2026-08-30), and per-perspective
 * attribution is the work that would let a future ordering be earned.
 */
export const CONCEPTUAL_PERSPECTIVES: readonly ConceptualPerspective[] = [
  {
    name: "Pragmatist",
    lens:
      "Does this actually work for users? What's the shortest path to value? Flag anything that adds ceremony or indirection without earning its keep.",
  },
  {
    name: "Mathematician seeking elegance",
    lens:
      "Minimal complexity, orthogonal abstractions, no redundancy. Flag overlapping concepts that should be unified and abstractions that fail to compose.",
  },
  {
    name: "Short attention span",
    lens:
      "Frustrated by anything taking >30 seconds to understand. If a design can't be explained simply, it's too complex. Flag cognitive-load hotspots and implicit knowledge.",
  },
  {
    name: "Novelty-seeker",
    lens:
      "Always hunting for the latest tool, pattern, or library that could replace hand-rolled machinery. Flag wheels being reinvented and standards being ignored.",
  },
  {
    name: "Adversary",
    lens:
      "What could go wrong, what's fragile, what breaks under pressure or at scale? Flag failure modes the happy path quietly assumes away.",
  },
  {
    name: "Maintainer inheriting this cold",
    lens:
      "A new engineer six months from now with no context. Flag what would take longest to learn, what's implicit, and what has no obvious entry point.",
  },
  {
    name: "Minimalist",
    lens:
      "What could be deleted entirely? Flag features, layers, and options that exist but earn little, and capabilities that duplicate one another.",
  },
];

/**
 * Default number of deep-review perspectives when the host does not specify: the
 * WHOLE roster.
 *
 * It was 5 against a 7-entry roster, with no recorded reason — the constant never
 * arrived in a commit of its own, and its comment only restated its own name. A
 * default that silently drops two reviewers is a judgement about which reviewers
 * matter least, and nothing measures that (see the roster note above). Derived
 * from the roster length so adding a perspective cannot silently re-introduce a
 * cut. An operator who wants a cheaper run still narrows the count explicitly,
 * which is a choice they made rather than one made for them.
 */
export const DEFAULT_CONCEPTUAL_PERSPECTIVES = CONCEPTUAL_PERSPECTIVES.length;

/**
 * Clamp a requested perspective count into the supported range: at least 2
 * (one perspective is just a shallow review) and at most the number of built-in
 * perspectives. Non-finite / undefined ⇒ the default.
 */
export function clampPerspectiveCount(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_CONCEPTUAL_PERSPECTIVES;
  }
  return Math.max(2, Math.min(CONCEPTUAL_PERSPECTIVES.length, Math.floor(requested)));
}

/**
 * The two perspectives a deep fan-out must ALWAYS contain, whatever the count:
 * structural simplification and the purpose/telos challenge. They are named, not
 * indexed, so reordering the roster cannot silently drop one.
 *
 * WHY THIS EXISTS, stated accurately. Selection was `slice(0, count)` over the
 * roster in list order, and that slice was DELIBERATE — the roster documented
 * itself as ranked by usefulness, so taking the first N was the intended design,
 * not an oversight. An earlier version of this comment called it accidental
 * starvation; that was wrong.
 *
 * What was never true is the RANKING the slice relied on. Nothing measured it,
 * and nothing can today: findings carry a `lens`, never the perspective that
 * produced them. The default now covers the whole roster, so this reservation
 * binds only when an operator deliberately narrows the count — and then it keeps
 * the two perspectives this workflow is built around rather than whichever two
 * an unmeasured ordering happened to favour. Matched by NAME, so reordering the
 * roster cannot silently drop one.
 */
const REQUIRED_PERSPECTIVE_NAMES: readonly string[] = [
  "Mathematician seeking elegance",
  "Minimalist",
];

/**
 * `count` (clamped) built-in perspectives for a deep fan-out, with the two required
 * perspectives reserved and the remaining slots filled in roster order.
 *
 * Emission stays in ROSTER order rather than required-first, so the prompt sequence
 * an operator sees does not change shape — only its membership does. The clamp floor
 * of 2 is exactly the reserved count, so the guarantee holds at every legal count.
 */
export function selectPerspectives(selection?: ConceptualPerspectiveSelection): ConceptualPerspective[] {
  if (Array.isArray(selection)) {
    return ConceptualPerspectiveSelectionSchema.parse(selection).map((entry) => {
      if (typeof entry !== "string") return entry;
      return CONCEPTUAL_PERSPECTIVES.find((perspective) => perspective.name === entry)!;
    });
  }
  const count = selection;
  const limit = clampPerspectiveCount(count);
  const chosen = new Set(
    CONCEPTUAL_PERSPECTIVES.filter((p) => REQUIRED_PERSPECTIVE_NAMES.includes(p.name)),
  );
  for (const perspective of CONCEPTUAL_PERSPECTIVES) {
    if (chosen.size >= limit) break;
    chosen.add(perspective);
  }
  return CONCEPTUAL_PERSPECTIVES.filter((p) => chosen.has(p));
}


const perspectiveName = (name: string): string => name.trim().toLocaleLowerCase("en-US");
const customPerspectiveSchema = z.object({ name: z.string().trim().min(1), lens: z.string().trim().min(1) }).strict();
export const ConceptualPerspectiveSelectionSchema = z.array(z.union([z.string().trim().min(1), customPerspectiveSchema])).min(1).superRefine((entries, context) => {
  const used = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const name = typeof entry === "string" ? entry : entry.name;
    const key = perspectiveName(name);
    const builtin = CONCEPTUAL_PERSPECTIVES.find((perspective) => perspectiveName(perspective.name) === key);
    if ((typeof entry === "string" && (!builtin || builtin.name !== name)) || (typeof entry !== "string" && builtin)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: typeof entry === "string" ? "Use an exact built-in perspective name or a custom {name, lens} definition." : "Custom perspective names must not collide with built-in names." });
    }
    if (used.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "Perspective names must be unique." });
    used.add(key);
  }
});
export type ConceptualPerspectiveSelection = number | z.infer<typeof ConceptualPerspectiveSelectionSchema>;
