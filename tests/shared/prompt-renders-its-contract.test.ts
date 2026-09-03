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
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { CharterProvenanceSchema } from "../../src/shared/types/charter.js";
import { promptContractRegistry } from "./promptContractRegistry.js";

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

/** Smallest bundle the lane renderer accepts — only `consensus` is read. */
function bundle(): ArtifactBundle {
  return {
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: ["call_import"],
      consensus: [],
      contested: [],
      findings: [],
    },
  };
}

describe(FAILURE_SIGNATURE, () => {
  it("renders the charter provenance enum exhaustively, never as an open list", () => {
    const prompt = renderCharterKindLanePrompt(bundle(), {
      kind: "stated",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    // The rendered alternation IS the schema's option list, in schema order.
    const alternation = CharterProvenanceSchema.shape.kind.options.join("|");
    expect(
      prompt,
      "the lane prompt must show a provenance example derived from the schema",
    ).toContain(`"provenance": [{ "kind": "${alternation}"`);

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
    const prompt = renderCharterKindLanePrompt(bundle(), {
      kind: "stated",
      submissionPath: "x/submission.json",
      packetPath: "x/packet.json",
    });

    expect(
      prompt,
      "the ref grammar must state the line-range shape the packet publishes",
    ).toContain("<path>:<startLine>-<endLine>");
    expect(
      prompt,
      "the prompt must say the ref is COPIED, never counted or inferred",
    ).toContain("COPIED");
    expect(
      prompt,
      "a lane must be told it never has to leave the packet to cite correctly",
    ).toContain("SUFFICIENT");
    expect(prompt).not.toContain('"ref": "<path/id>"');
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
