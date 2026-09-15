// sites-pinned: tests/audit/charter-fidelity-executor.test.ts
// The FIDELITY PACKET (step 4, judgment half): per open finding candidate, the
// accounts, their cited provenance, and the exact source slices at those
// citations — materialized by the tool so the fidelity lane is blind by INPUT
// (it sees the slices, never the whole tree). Every quote in the packet was
// already re-read from disk by the comparison executor's pre-check; a difference
// with a missing quote never reaches this packet.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactBundle } from "../io/artifacts.js";
import { provenancePath, type CharterProvenance } from "audit-tools/shared";

/** Lines of context shown on each side of a cited line or quote. */
const CONTEXT_LINES = 12;

async function sliceFor(
  root: string,
  provenance: CharterProvenance,
): Promise<string[]> {
  const path = provenancePath(provenance.ref);
  let text: string;
  try {
    text = await readFile(join(root, path), "utf8");
  } catch {
    return [`(source ${path} could not be read)`];
  }
  const lines = text.split(/\r?\n/);
  let anchor = -1;
  const lineRef = provenance.ref.match(/:(\d+)(?:-\d+)?$/);
  if (lineRef) anchor = Number(lineRef[1]) - 1;
  if (anchor < 0 && provenance.quote) {
    anchor = lines.findIndex((l) => l.includes(provenance.quote!));
  }
  if (anchor < 0) {
    const symbol = provenance.ref.includes("#") ? provenance.ref.slice(provenance.ref.indexOf("#") + 1) : undefined;
    if (symbol) anchor = lines.findIndex((l) => l.includes(symbol));
  }
  const start = Math.max(0, (anchor < 0 ? 0 : anchor) - CONTEXT_LINES);
  const end = Math.min(lines.length, (anchor < 0 ? CONTEXT_LINES * 2 : anchor) + CONTEXT_LINES + 1);
  const width = String(end).length;
  return lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(width, " ")}| ${l}`);
}

/**
 * Build the fidelity packet markdown for every finding candidate still owed a
 * lane verdict. Deterministic given the register and the tree.
 */
export async function buildCharterFidelityPacket(
  bundle: ArtifactBundle,
  root: string,
): Promise<string> {
  const register = bundle.charter_register;
  const pending = (register?.differences ?? []).filter((d) => d.finding_candidate && !d.fidelity);
  const sections: string[] = [
    "# Charter fidelity packet",
    "",
    `${pending.length} difference(s) await a verdict. Each block holds the accounts, their citations, and the source slice at each citation (line numbers are true line numbers in the source file).`,
    "",
  ];
  for (const d of pending) {
    sections.push(`## ${d.difference_id} — ${d.dimension} · ${d.relation}${d.split ? ` · ${d.split.kind === "three_way" ? "three_way" : `two_against_one: ${d.split.odd}`}` : ""}`, "", `Gap: ${d.gap}`, "");
    for (const account of d.accounts) {
      sections.push(`### ${account.kind} says: ${account.claim}`, "");
      if (account.provenance.length === 0) {
        sections.push("(no provenance cited)", "");
        continue;
      }
      for (const p of account.provenance) {
        sections.push(`- \`${p.ref}\`${p.quote ? ` — "${p.quote}"` : ""}`, "", "```", ...(await sliceFor(root, p)), "```", "");
      }
    }
  }
  return sections.join("\n");
}
