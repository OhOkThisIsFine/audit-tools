import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ZodArray,
  ZodBranded,
  ZodCatch,
  ZodDefault,
  ZodDiscriminatedUnion,
  ZodEffects,
  ZodEnum,
  ZodIntersection,
  ZodNullable,
  ZodObject,
  ZodOptional,
  ZodReadonly,
  ZodUnion,
  type ZodRawShape,
  type ZodTypeAny,
} from "zod";
import { describe, expect, it } from "vitest";

import { renderCharterClarificationPrompt } from "../../src/audit/cli/charterClarificationPrompt.js";
import { renderCharterComparisonPrompt } from "../../src/audit/cli/charterComparisonPrompt.js";
import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { renderCharterFidelityPrompt } from "../../src/audit/cli/charterFidelityPrompt.js";
import {
  CharterComparisonSubmissionSchema,
  CharterFidelitySubmissionSchema,
  CharterSubmissionSchema,
} from "../../src/shared/decompose/charterExtraction.js";
import { ClarificationAnswersSubmissionSchema } from "../../src/shared/decompose/charterClarification.js";
import {
  renderConceptualJudgePrompt,
  renderConceptualPerspectivePrompt,
  renderConceptualReviewPrompt,
  renderContractReviewPrompt,
} from "../../src/audit/orchestrator/designReviewPrompt.js";
import {
  ConceptualJudgeSubmissionSchema,
  SubmittedDesignFindingSchema,
} from "../../src/audit/types/conceptualAdjudication.js";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import { systemicChallengeSchema } from "../../src/shared/decompose/systemicChallenge.js";
import { repoPathUniverse } from "../../src/shared/validation/designFindingGrounding.js";
import { CharterProvenanceSchema } from "../../src/shared/types/charter.js";
import { FindingSeveritySchema } from "../../src/shared/types/finding.js";
import {
  clarificationBundleFixture,
  promptContractRegistry,
} from "./promptContractRegistry.js";

// P40 (nightly 2026-08-22). A generated prompt states its output contract as a
// hand-typed literal beside a separately hand-written validator, and the two
// drift: a worker that obeys the prompt produces a submission the tool rejects.
// Measured cost: one charter submission quarantined after a 34-minute lane run.
//
// Two pins, two shapes:
// - the charter provenance pin is BEHAVIORAL — it renders the lane prompt and
//   holds exhaustiveness/closedness of the RENDERED text (the render itself
//   derives the list from CharterProvenanceSchema, so a schema enum change
//   flows into the prompt and this pin follows it);
// - the excluded_scope pin is a SOURCE scan of the remediate template literal.
//
// Deliberately SHAPE rules, not a field-set reconciliation: a field-set test is
// red on 15 correct contract-pipeline sketches, because `created_at` is stamped
// tool-side ("the host has no clock") and the prompts omit it correctly.
const FAILURE_SIGNATURE =
  "contract:a-prompt-renders-its-contract-from-the-contract:not-yet-satisfied";

describe(FAILURE_SIGNATURE, () => {
  it("renders the charter provenance enum exhaustively, never as an open list", () => {
    const prompt = renderCharterKindLanePrompt({
      kind: "stated",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    // The worked example must itself be a VALID submission. The renderer used to
    // drop the whole alternation into the example's `kind` VALUE, and THIS
    // assertion required it there — so the pin demanded the very
    // prompt-says/validator-rejects split the file exists to stop. A host copying
    // the example emitted a kind the strict enum refuses. The alternation is a
    // FIELD RULE; it is never an example value. (Owner review 2026-09-17, prompt 8.)
    const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
    expect(
      fence,
      "the lane prompt must carry exactly one fenced JSON example",
    ).not.toBeNull();
    const parsed = CharterSubmissionSchema.safeParse(JSON.parse(fence![1]!));
    expect(
      parsed.success ? null : parsed.error.issues,
      "a submission copied verbatim from the prompt's own example must satisfy " +
        "CharterSubmissionSchema — obedience has to be SUFFICIENT",
    ).toBeNull();

    const alternation = CharterProvenanceSchema.shape.kind.options.join("|");
    expect(
      prompt,
      "the schema's alternation belongs in the field rule, never in an example value",
    ).not.toContain(`"kind": "${alternation}"`);

    // The prompt's own closing rule: every edge endpoint names a node in the same
    // submission. The example used to break it, citing an undeclared parent.
    const example = parsed.success ? parsed.data : { nodes: [], edges: [] };
    const exampleIds = example.nodes.map((node) => node.node_id);
    for (const edge of example.edges) {
      expect(
        exampleIds,
        `the example's edge endpoint '${edge.from}' must be one of the example's own nodes`,
      ).toContain(edge.from);
      expect(
        exampleIds,
        `the example's edge endpoint '${edge.to}' must be one of the example's own nodes`,
      ).toContain(edge.to);
    }

    // The enum is CLOSED. An alternation that trails off invites a coined
    // member — which is exactly what quarantined the structural lane's run.
    expect(
      prompt,
      "a closed enum must not be rendered as an open alternation ending in '...'",
    ).not.toMatch(/\|\s*\.\.\./u);

    // Every member the validator accepts must appear, so the rendered list is
    // never smaller than what ingestion enforces.
    for (const member of CharterProvenanceSchema.shape.kind.options) {
      expect(
        prompt,
        `the prompt must name provenance kind '${member}' — the validator accepts it ` +
          `and a prompt that omits it teaches a smaller contract than the tool enforces`,
      ).toContain(member);
    }
  });

  it("states the citation grammar as COPIED provenance, not an invented `<path/id>`", () => {
    // The packet used to carry no line provenance at all while the prompt asked
    // for `"ref": "<path/id>"` and forbade opening real files. A lane that OBEYED
    // could only emit its offset into the concatenated packet — which is exactly
    // what one run did, producing 14 citations overshooting their files by up to
    // 52x. Obedience has to be SUFFICIENT, so the grammar must name the shape and
    // say where it is copied from.
    const prompt = renderCharterKindLanePrompt({
      kind: "stated",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    expect(
      prompt,
      "the ref grammar must state the SYMBOL shape, the form the prompt prefers",
    ).toContain("<path>#<symbol>");
    // Line numbers left the grammar on 2026-09-17 (owner review of prompt 8, and
    // the durable trap "cite a SYMBOL, never a bare line number"). A line number
    // drifts, and a drifted number cannot be repaired — only deleted. So the
    // retired line shapes must not come back into the taught grammar.
    for (const retired of ["<path>:<startLine>-<endLine>", "<path>:<N>", "<path>:<line>"]) {
      expect(
        prompt,
        `the retired line-number form \`${retired}\` must not be taught again`,
      ).not.toContain(retired);
    }
    expect(
      prompt,
      "the prompt must say the QUOTE is copied, never paraphrased or invented",
    ).toContain("COPIED");
    expect(
      prompt,
      "a lane must be told it never has to leave the packet to cite correctly",
    ).toContain("SUFFICIENT");
    expect(prompt).not.toContain('"ref": "<path/id>"');
  });

  it("states BOTH quote rules the tool enforces, and the one case that takes no quote", () => {
    // Obedience must be SUFFICIENT, and the quote requirement is enforced at two
    // boundaries: `charterLaneSchema` refuses a quoteless ref that names a span,
    // and `checkLaneCitations` refuses a quoteless citation of a file the packet
    // EXCERPTED. A prompt stating neither would send an obedient lane into a
    // refusal it could not have predicted.
    //
    // The third sentence is the counterweight, and it is not optional: a
    // file-tree-only file has no quote to give, and a lane pressed for one
    // FABRICATES it (durable trap, docs/backlog/durable-traps.md). So the prompt
    // must license the quoteless bare path in the one case the tool allows it.
    const prompt = renderCharterKindLanePrompt({
      kind: "structural",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    expect(
      prompt,
      "the lane gate refuses a quoteless `<path>#<symbol>` — the prompt must say so",
    ).toMatch(/`<path>#<symbol>`\) with no quote/);
    expect(
      prompt,
      "the executor refuses a quoteless citation of an EXCERPTED file — the prompt must say so",
    ).toMatch(/lists as an excerpt with no quote/);
    expect(
      prompt,
      "the one quoteless case the tool accepts must be licensed, or the lane invents a quote",
    ).toMatch(/excerpts nowhere/);
  });

  it("renders a charter-COMPARISON example that is itself a valid submission", () => {
    // The same defect class as the provenance pin above, in the neighbouring file
    // and unnoticed by the registry sweep below: the comparison prompt's worked
    // example wrote the whole verdict alternation into the field VALUE
    // (`"verdict": "confirm | reject | widen"`) and filled three more fields with
    // `<...>` placeholders. A reader copying the example's shape produced a
    // submission the strict schema refused outright. The registry sweep could not
    // see it — `collectClosedEnums` stops at object depth 2, and every enum in
    // this contract sits deeper. (Owner review 2026-09-17, prompt 9.)
    const prompt = renderCharterComparisonPrompt(
      {},
      {
        submissionPath: "x/comparison.json",
        laneGraphPaths: {
          stated: "x/stated.json",
          structural: "x/structural.json",
          revealed: "x/revealed.json",
        },
      },
    );

    const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
    expect(
      fence,
      "the comparison prompt must carry exactly one fenced JSON example",
    ).not.toBeNull();
    const parsed = CharterComparisonSubmissionSchema.safeParse(JSON.parse(fence![1]!));
    expect(
      parsed.success ? null : parsed.error.issues,
      "a submission copied verbatim from the comparison prompt's own example must " +
        "satisfy CharterComparisonSubmissionSchema — obedience has to be SUFFICIENT",
    ).toBeNull();

    // A `<...>` stand-in parses as a plain string, so the schema cannot catch it
    // and the reader learns a value the tool refuses one stage later, at assembly.
    expect(
      fence![1],
      "the example must carry real literals, never `<...>` placeholders",
    ).not.toMatch(/<[^>\n]+>/u);

    // Every provenance kind the validator accepts must be named. The prompt used
    // to show `doc` and `code` in its example and state the closed six nowhere, so
    // a reader had to guess the enum from two samples.
    for (const member of CharterProvenanceSchema.shape.kind.options) {
      expect(
        prompt,
        `the comparison prompt must name provenance kind '${member}' — the validator ` +
          "accepts it and a prompt that omits it teaches a smaller contract",
      ).toContain(member);
    }
  });

  it("renders a charter-FIDELITY example that is itself a valid submission", () => {
    // The third instance of the same class, one step further down the charter
    // layer. The fidelity example wrote both alternations into field VALUES
    // (`"verdict": "supported | interpretation | unverifiable"`) and carried
    // `over_read_side` beside a non-`interpretation` verdict — which the strict
    // schema refuses on its own superRefine, and which the prompt's own closing
    // rule contradicted one line later. (Owner review 2026-09-17, prompt 9b.)
    const prompt = renderCharterFidelityPrompt({
      submissionPath: "x/fidelity.json",
      packetPath: "x/fidelity-packet.md",
    });

    const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
    expect(
      fence,
      "the fidelity prompt must carry exactly one fenced JSON example",
    ).not.toBeNull();
    const parsed = CharterFidelitySubmissionSchema.safeParse(JSON.parse(fence![1]!));
    expect(
      parsed.success ? null : parsed.error.issues,
      "a submission copied verbatim from the fidelity prompt's own example must " +
        "satisfy CharterFidelitySubmissionSchema — obedience has to be SUFFICIENT",
    ).toBeNull();

    expect(
      fence![1],
      "the example must carry real literals, never `<...>` placeholders",
    ).not.toMatch(/<[^>\n]+>/u);

    // Every verdict the lane may return must be SHOWN, not only listed: the
    // example is the shape a reader copies, and the three verdicts differ in
    // whether they carry `over_read_side` at all.
    const shown = new Set(
      (parsed.success ? parsed.data.verdicts : []).map((v) => v.verdict),
    );
    for (const member of ["supported", "interpretation", "unverifiable"]) {
      expect(
        shown,
        `the fidelity example must show verdict '${member}' — a reader copies the ` +
          "example, and only the example says which fields go with which verdict",
      ).toContain(member);
    }
  });

  it("the clarification example answers the REAL queue, in every shape the schema takes", () => {
    // The fourth instance of the same class, and the one that carried the
    // highest cost: this is the step that spends the owner's ATTENTION. Its
    // example wrote the channel alternation into the value
    // (`"governs": "stated | structural | revealed"`, which the strict enum
    // refuses) and keyed every entry on a `<one of the request_ids above>`
    // placeholder — which the gate ACCEPTS, because `request_id` is a free
    // string. The executor then stored the unmatched key in a map nothing
    // reads, defaulted every real question to `leave_open`, and recorded a
    // success. Questions asked, answers given, answers discarded in silence.
    // (Owner review 2026-09-17, prompt 10.)
    //
    // The prompt is registered as a DERIVED row in the same edit. It had sat in
    // the declared-gap list as "no worker output contract", which is why nothing
    // reconciled it against the schema it has always had.
    const prompt = renderCharterClarificationPrompt(clarificationBundleFixture, {
      answersPath: "x/answers.json",
      continueCommand: "audit-code next-step",
    });

    const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
    expect(
      fence,
      "the clarification prompt must carry exactly one fenced JSON example",
    ).not.toBeNull();
    const parsed = ClarificationAnswersSubmissionSchema.safeParse(JSON.parse(fence![1]!));
    expect(
      parsed.success ? null : parsed.error.issues,
      "a submission copied verbatim from the clarification prompt's own example " +
        "must satisfy ClarificationAnswersSubmissionSchema — obedience has to be SUFFICIENT",
    ).toBeNull();

    expect(
      fence![1],
      "the example must carry real literals, never `<...>` placeholders",
    ).not.toMatch(/<[^>\n]+>/u);

    // Schema-valid is not enough here, and that is the whole lesson of this
    // defect: a placeholder id is schema-valid. Every id the example uses must
    // be one the rendered queue actually asked.
    const askedIds = new Set(
      (clarificationBundleFixture.charter_clarification?.asked ?? []).map(
        (q) => q.request_id,
      ),
    );
    for (const answer of parsed.success ? parsed.data.answers : []) {
      expect(
        askedIds,
        `the example answers request_id '${answer.request_id}', which this queue never asked — ` +
          "an unasked id is exactly what the executor refuses",
      ).toContain(answer.request_id);
    }

    // The three answer shapes are NOT interchangeable tokens: `governs` is an
    // object, the other two are bare strings. The prompt has to say so in words,
    // because the example can only show the shapes it happens to use.
    expect(
      prompt,
      "the prompt must state the governs answer as the OBJECT the schema takes",
    ).toContain('`{ "governs": "<channel>" }`');
    expect(
      prompt,
      "the prompt must state rewrite_all as a bare STRING",
    ).toContain('`"rewrite_all"`');
    expect(
      prompt,
      "the prompt must state leave_open as a bare STRING",
    ).toContain('`"leave_open"`');

    // The rule the executor now enforces (refuseUnaskedRequestIds). A prompt
    // that stays silent about it leaves the host to discover a refusal that the
    // prompt could have prevented.
    expect(
      prompt,
      "the prompt must tell the host to copy each request_id verbatim, and say that " +
        "an unasked id is refused",
    ).toMatch(/refuses an\s+id it did not ask/u);

    // Every citation of every account reaches the reader. Rendering
    // `provenance[0]` alone showed one line of a multi-line account, and the
    // owner then chose which account governs from a partial account.
    expect(
      prompt,
      "every citation of every account must be rendered, not just the first",
    ).toContain("src/scheduling/rebook.ts#RETRY_LIMIT");

    // A question with no recorded split used to print its relation twice
    // (`presence · complementary · complementary`), which reads as a repeated
    // word rather than as an absent fact.
    expect(
      prompt,
      "a question with no split must not print its relation twice",
    ).not.toMatch(/·\s*complementary\s*·\s*complementary/u);
  });

  it("every DESIGN-REVIEW example is itself a valid submission on the door that consumes it", () => {
    // The fifth instance of the same class, and the widest: ONE shared example
    // served all four design-review prompts, and it wrote both alternations into
    // the field VALUES (`"severity": "one of: critical, high, medium, low, info"`)
    // and cited `relevant/file.ts`, which is in no repository. Three separate
    // failures followed from that one example. The judge door refused it outright
    // (`ConceptualJudgeSubmissionSchema` is `.strict()`, and the findings-only
    // envelope omits its three other required keys). The contract and
    // shallow-conceptual doors accepted it and stamped the finding `grounded`
    // with a severity `SEVERITY_RANK` cannot rank. And the cited path grounded as
    // `ungrounded` on every door, because the prompt taught the one citation its
    // own grounding pass refuses. (Owner review 2026-09-17, prompt 11.)
    const bundle = {
      unit_manifest: {
        units: [
          {
            unit_id: "u1",
            path: "src/scheduling",
            disposition: "in_scope",
            files: ["src/scheduling/window.ts"],
            required_lenses: ["architecture"],
          },
        ],
      },
      repo_manifest: {
        repository: { name: "registry-fixture" },
        generated_at: "2026-01-01T00:00:00.000Z",
        files: [
          {
            path: "src/scheduling/window.ts",
            language: "typescript",
            size_bytes: 100,
          },
        ],
      },
    } as unknown as Parameters<typeof renderContractReviewPrompt>[0];

    const judgePrompt = renderConceptualJudgePrompt(
      bundle,
      [
        {
          name: "The Simplifier",
          path: ".audit-tools/audit/x/p1.json",
          contributor_id: "perspective:the-simplifier",
        },
      ],
      "round-0001",
      { lenses: ["architecture", "security"] },
    );
    const rendered: Array<[string, string]> = [
      ["contract", renderContractReviewPrompt(bundle, {})],
      ["conceptual", renderConceptualReviewPrompt(bundle, {})],
      [
        "perspective",
        renderConceptualPerspectivePrompt(
          bundle,
          { name: "The Simplifier", lens: "simplicity above all" },
          0,
          1,
          {},
        ),
      ],
      ["judge", judgePrompt],
    ];

    for (const [door, prompt] of rendered) {
      const fence = /```json\n([\s\S]*?)\n```/u.exec(prompt);
      expect(
        fence,
        `the ${door} prompt must carry exactly one fenced JSON example`,
      ).not.toBeNull();
      const example = JSON.parse(fence![1]!) as { findings?: unknown[] };

      // EVERY door now parses its items with this schema
      // (`consumeArraySubmission` takes it, and the judge door already did), so
      // the example a host copies must satisfy it on every door alike.
      for (const [index, item] of (example.findings ?? []).entries()) {
        const parsed = SubmittedDesignFindingSchema.safeParse(item);
        expect(
          parsed.success ? null : parsed.error.issues,
          `${door}: findings[${index}] of the prompt's own example must satisfy ` +
            "SubmittedDesignFindingSchema — obedience has to be SUFFICIENT",
        ).toBeNull();
      }

      // The cited path must be one the grounding pass can find. The example takes
      // it from the manifest this prompt already prints, so a copied citation
      // grounds instead of quarantining.
      expect(
        fence![1],
        `${door}: the example must cite a path from the file inventory, never an invented one`,
      ).toContain("src/scheduling/window.ts");
      expect(
        fence![1],
        `${door}: the example must carry real literals, never the alternation that lists them`,
      ).not.toMatch(/one of:/u);

      // Grounding is what every design-review door judges the submission by, so
      // every design-review prompt has to state it. The contract prompt did not.
      expect(
        prompt,
        `${door}: the prompt must state the grounding rule it is judged by`,
      ).toContain("Ground every finding");
    }

    // The JUDGE's envelope is not the perspectives'. Its three other required
    // keys are what the shared findings-only example omitted, and a missing key
    // costs the whole merge round.
    const judgeFence = /```json\n([\s\S]*?)\n```/u.exec(judgePrompt)!;
    const judgeParsed = ConceptualJudgeSubmissionSchema.safeParse(
      JSON.parse(judgeFence[1]!),
    );
    expect(
      judgeParsed.success ? null : judgeParsed.error.issues,
      "a submission copied verbatim from the judge prompt's own example must satisfy " +
        "ConceptualJudgeSubmissionSchema — it is `.strict()`, so an omitted key and " +
        "an extra key both refuse the round",
    ).toBeNull();
  });

  it("renders a SECOND-ORDER ADVERSARY example its own grounding gate accepts", () => {
    // The sixth instance of the same class. The example wrote both closed
    // alternations into the field VALUES (`"severity": "low|medium|high"`, which
    // also taught THREE of the five severities the tool ranks) and cited
    // `<a real repo path>`. The path mattered more than it looked: the
    // submission gate now refuses an improvement that names no manifest member,
    // so the example copied verbatim was a refused round. The example takes its
    // path from the call-site map the same prompt prints. (Owner review
    // 2026-09-17, prompt 12.)
    const repoManifest = {
      repository: { name: "registry-fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/scheduling/window.ts", language: "typescript", size_bytes: 100 },
      ],
    };
    const bundle = { repo_manifest: repoManifest } as unknown as Parameters<
      typeof renderSecondOrderAdversaryPrompt
    >[0]["bundle"];

    const prompt = renderSecondOrderAdversaryPrompt({
      round: 2,
      metrics: { rollups: [], max_fan_out: 0 } as unknown as Parameters<
        typeof renderSecondOrderAdversaryPrompt
      >[0]["metrics"],
      submissionPath: ".audit-tools/audit/x/systemic-challenge.json",
      bundle,
      evidencePaths: [".audit-tools/audit/x/p1.json"],
    });

    const fences = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(
      (match) => match[1]!,
    );
    const example = fences.find((fence) =>
      fence.includes('"category": "systemic_improvement"'),
    );
    expect(
      example,
      "the adversary prompt must carry a fenced JSON example of the submission",
    ).toBeDefined();

    // The gate the round is actually judged by — the bare schema is not enough,
    // because the grounding rule is what the example's path has to satisfy.
    const parsed = systemicChallengeSchema(
      repoPathUniverse(repoManifest),
    ).safeParse(JSON.parse(example!));
    expect(
      parsed.success ? null : parsed.error.issues,
      "a submission copied verbatim from the adversary prompt's own example must " +
        "satisfy the BOUND systemic challenge schema — obedience has to be SUFFICIENT",
    ).toBeNull();

    expect(
      example,
      "the example must cite a path this run's manifest holds, never an invented one",
    ).toContain("src/scheduling/window.ts");

    // Every severity the tool ranks must be named. Teaching three of five hides
    // `critical` and `info` from the one producer whose findings drive the loop.
    for (const member of FindingSeveritySchema.options) {
      expect(
        prompt,
        `the prompt must name severity '${member}' — the validator accepts it, and a ` +
          "prompt that omits it teaches a smaller contract than the tool enforces",
      ).toContain(member);
    }

    // The alternation is a FIELD RULE. In a value it is a refused submission.
    expect(
      example,
      "a closed enum's alternation must never appear as an example VALUE",
    ).not.toMatch(/":\s*"[a-z_]+\|/u);

    // BOTH fences, not only the one that teaches a finding. The host-forced-stop
    // example carried a `/* ... */` elision, which is not JSON: the one document
    // a host copies when it is ALREADY out of budget was the one it could not
    // parse. Every fenced example in this prompt is a document a host writes.
    for (const [index, fence] of fences.entries()) {
      const valid = ((): unknown => {
        try {
          return JSON.parse(fence);
        } catch {
          return undefined;
        }
      })();
      expect(
        valid,
        `fenced example ${index} must be parseable JSON — a host copies it verbatim`,
      ).toBeDefined();
      const gated = systemicChallengeSchema(
        repoPathUniverse(repoManifest),
      ).safeParse(valid);
      expect(
        gated.success ? null : gated.error.issues,
        `fenced example ${index} must satisfy the submission contract it illustrates`,
      ).toBeNull();
    }
  });

  it("states the element shape of excluded_scope in the confirm-intent template", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/remediate/steps/nextStep.ts", "utf8"),
    );

    // Both branches of the confirm-intent prompt render this key. The fallback
    // branch already states {path, reason}; the pre-drafted branch — the common
    // path — renders a bare []. The reader (fileExclusionReason in
    // src/shared/intent/pathScope.ts) iterates it expecting objects.
    const renderings = [...source.matchAll(/^\s*"excluded_scope":\s*(.+)$/gmu)].map(
      (match) => match[1],
    );
    expect(
      renderings.length,
      "the confirm-intent template must render excluded_scope",
    ).toBeGreaterThan(0);

    for (const rendering of renderings) {
      expect(
        rendering,
        "every rendering of excluded_scope must state its element shape — a bare [] " +
          "teaches a shape the reader crashes on",
      ).toMatch(/path/u);
      expect(rendering, "and the reason field its reader requires").toMatch(/reason/u);
    }
  });
});

function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  let current = schema;
  while (true) {
    if (current instanceof ZodEffects) {
      current = current.innerType();
    } else if (
      current instanceof ZodOptional ||
      current instanceof ZodNullable ||
      current instanceof ZodBranded ||
      current instanceof ZodReadonly
    ) {
      current = current.unwrap();
    } else if (current instanceof ZodDefault) {
      current = current.removeDefault();
    } else if (current instanceof ZodCatch) {
      current = current.removeCatch();
    } else {
      return current;
    }
  }
}

function objectShape(schema: ZodTypeAny): ZodRawShape {
  const unwrapped = unwrapSchema(schema);
  expect(unwrapped, "a registered derived/projection object must resolve to z.object").toBeInstanceOf(
    ZodObject,
  );
  return (unwrapped as ZodObject<ZodRawShape>).shape;
}

function collectClosedEnums(
  schema: ZodTypeAny,
  level: number,
  found: ZodEnum<[string, ...string[]]>[],
): void {
  const unwrapped = unwrapSchema(schema);
  if (unwrapped instanceof ZodEnum) {
    found.push(unwrapped as ZodEnum<[string, ...string[]]>);
    return;
  }
  if (unwrapped instanceof ZodArray) {
    collectClosedEnums(unwrapped.element, level + 1, found);
    return;
  }
  if (unwrapped instanceof ZodUnion) {
    for (const option of unwrapped.options) collectClosedEnums(option, level, found);
    return;
  }
  if (unwrapped instanceof ZodDiscriminatedUnion) {
    for (const option of unwrapped.options.values()) collectClosedEnums(option, level, found);
    return;
  }
  if (unwrapped instanceof ZodIntersection) {
    collectClosedEnums(unwrapped._def.left, level, found);
    collectClosedEnums(unwrapped._def.right, level, found);
    return;
  }
  if (unwrapped instanceof ZodObject && level < 2) {
    for (const child of Object.values(unwrapped.shape as ZodRawShape)) {
      collectClosedEnums(child, level + 1, found);
    }
  }
}

const derivedRows = promptContractRegistry.filter((row) => row.disposition === "derived");
const projectionRows = promptContractRegistry.filter(
  (row) => row.disposition === "projection",
);
const declaredGapRows = promptContractRegistry.filter(
  (row) => row.disposition === "declared-gap",
);

describe("prompt-contract registry: derived rows", () => {
  for (const row of derivedRows) {
    it(`${row.file} :: ${row.builder}`, () => {
      expect(row.schema?.object, "derived rows must import their real zod schema object").toBeDefined();
      expect(row.render, "derived rows must render a minimal fixture").toBeDefined();

      const prompt = row.render!();
      const shape = objectShape(row.schema!.object!);
      for (const [key, field] of Object.entries(shape)) {
        if (field.safeParse(undefined).success) continue;
        expect(
          prompt,
          `${row.builder} must render required top-level schema key '${key}'`,
        ).toContain(key);
      }

      const enums: ZodEnum<[string, ...string[]]>[] = [];
      collectClosedEnums(row.schema!.object!, 0, enums);
      for (const schemaEnum of enums) {
        for (const member of schemaEnum.options) {
          expect(
            prompt,
            `${row.builder} must render every member of closed enum ${schemaEnum.options.join("|")}`,
          ).toContain(member);
        }
        expect(
          prompt,
          `${row.builder} must not teach an open alternation for a closed enum`,
        ).not.toMatch(/\|\s*["'`]?\.\.\./u);
      }
    });
  }
});

describe("prompt-contract registry: projection rows", () => {
  for (const row of projectionRows) {
    it(`${row.file} :: ${row.builder}`, () => {
      expect(row.projectionFields?.length, "projection rows must declare fields").toBeGreaterThan(0);
      if (row.render) {
        const prompt = row.render();
        for (const field of row.projectionFields!) {
          const leaf = field.split(".").at(-1)!;
          expect(prompt, `${row.builder} must render projected field '${field}'`).toContain(leaf);
        }
      }

      if (row.schema?.object) {
        const topLevelKeys = new Set(Object.keys(objectShape(row.schema.object)));
        for (const field of row.projectionFields!) {
          const topLevel = field.split(".")[0];
          expect(
            topLevelKeys,
            `${row.builder} projection field '${field}' must be a real top-level schema key`,
          ).toContain(topLevel);
        }
      }
    });
  }
});

describe("prompt-contract registry: declared gaps", () => {
  for (const row of declaredGapRows) {
    it(`${row.file} :: ${row.builder}`, () => {
      expect(row.gapReason?.trim(), "declared-gap rows must explain the gap").toBeTruthy();
    });
  }
});

interface ExportedPromptBuilder {
  file: string;
  builder: string;
}

function sourceFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path.replaceAll("\\", "/"));
  }
  return files;
}

function scanExportedPromptBuilders(): ExportedPromptBuilder[] {
  const exportPattern =
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*Prompt[\w$]*)\s*\(|export\s+const\s+([A-Za-z_$][\w$]*Prompt[\w$]*)\s*=/gu;
  return sourceFilesUnder("src").flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(exportPattern)].map((match) => ({
      file,
      builder: match[1] ?? match[2],
    }));
  });
}

describe("prompt-contract registry: reconciliation", () => {
  const exportedBuilders = scanExportedPromptBuilders();

  it("claims every exported prompt builder exactly once", () => {
    for (const exported of exportedBuilders) {
      const claims = promptContractRegistry.filter(
        (row) => row.file === exported.file && row.builder === exported.builder,
      );
      expect(
        claims,
        `${exported.file} exports ${exported.builder}; add exactly one prompt-contract registry row ` +
          "with disposition derived, projection, or declared-gap",
      ).toHaveLength(1);
    }
  });

  it("references existing files and safely imports rows that name exported symbols", async () => {
    const exportedKeys = new Set(
      exportedBuilders.map(({ file, builder }) => `${file}\u0000${builder}`),
    );
    for (const row of promptContractRegistry) {
      expect(existsSync(row.file), `${row.builder} registry file must exist: ${row.file}`).toBe(true);
      if (!exportedKeys.has(`${row.file}\u0000${row.builder}`)) continue;

      const module = (await import(pathToFileURL(resolve(row.file)).href)) as Record<
        string,
        unknown
      >;
      expect(module, `${row.file} must export ${row.builder}`).toHaveProperty(row.builder);
    }
  });
});
