import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  charterExtractionInputRevision,
  materializeCharterPacket,
} from "../dist/audit/orchestrator/charterPackets.js";
import { DEFAULT_MAX_BYTES, defaultReadFileText } from "../dist/audit/extractors/readFileText.js";

const CAP = DEFAULT_MAX_BYTES;
const MEMBER_FILES = ["plus.ts", "missing.ts", "large.ts", "empty.ts", "cap.ts", "almost.ts"];

// SHA-256 of Markdown, JSON coverage, and JSON excerpts from the clean cb0df91 build.
// The caller's pre-change revision matched the Markdown digest in each lane.
const BASELINE = {
  stated: [
    "ed97b7f1792e2e0bb544f864c093b675026440bfe5f350825e8f6d8051a8f110",
    "b9e26f6fb72b43720a0c2d23e915fa7f8403ec76b86cb44be0142b5c159d8dc4",
    "17919ea9d90aa33145a05ca1949a4b88eb604100f09d5ddcc270ab40ca9641ad",
  ],
  structural: [
    "51e7a0e90aab5b56170c2513eaa4a69177300b6685a65dfaabbc7d27f6fbb46e",
    "47d66e01c7e4496649e5ee3920ff76cd9533bdedd48c5446b3a1c8b74df7f71f",
    "95966ccabfd000529b7f6c3cfe09d37ae6718a80a1d8ea22a938b474b1b2b24c",
  ],
  revealed: [
    "7f1a3b5f502c7ed81a23631408cf7d50854dbb78eb8938260b1eb7dc1ce26e85",
    "07eadf5809c679554706e5cca138d30dbb59067f07c92dc19ff658a3fc8e5024",
    "f69db150705aa2df25309d492f23d0e2f0236ad6a656516155e4e24577cb4354",
  ],
};

function sourceOfSize(size) {
  // The first byte of the four-byte code point is the last byte of a read chunk.
  const comment = "//" + " ".repeat(64 * 1024 - 3) + "\u{1F680}";
  const source = comment + "\nexport const value = 1;\n";
  return source + " ".repeat(size - Buffer.byteLength(source));
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("charter lanes preserve admitted evidence, and oversized reads stay bounded", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "charter-bounded-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const almost = sourceOfSize(CAP - 1);
  const cap = sourceOfSize(CAP);
  await Promise.all([
    fs.writeFile(join(root, "almost.ts"), almost),
    fs.writeFile(join(root, "cap.ts"), cap),
    fs.writeFile(join(root, "empty.ts"), ""),
    fs.writeFile(join(root, "plus.ts"), Buffer.alloc(CAP + 1)),
    fs.writeFile(join(root, "large.ts"), Buffer.alloc(CAP + 4096)),
    fs.writeFile(join(root, "README.md"), "# Fixture\n\nSynthetic evidence only.\n"),
  ]);
  const bundle = {
    unit_manifest: { units: [{ unit_id: "unit", name: "Fixture", kind: "code", files: MEMBER_FILES }] },
    file_disposition: { files: [{ path: "README.md", status: "doc_only" }] },
    graph_bundle: { graphs: { imports: [{ from: "almost.ts", to: "cap.ts" }] } },
  };

  await fs.writeFile(join(root, "growing.ts"), cap);
  const observations = new Map();
  const open = fs.open;
  fs.open = async (path, ...args) => {
    const handle = await open(path, ...args);
    const name = basename(path);
    if (path !== join(root, name) || !["plus.ts", "large.ts", "growing.ts"].includes(name)) return handle;

    const seen = observations.get(name) ?? { stats: 0, reads: 0, requested: 0, bytes: 0 };
    observations.set(name, seen);
    const stat = handle.stat.bind(handle);
    handle.stat = async () => {
      const before = await stat();
      seen.stats++;
      if (name === "growing.ts") await fs.appendFile(path, Buffer.alloc(4096));
      return before;
    };
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      seen.reads++;
      seen.requested += readArgs[2];
      const result = await read(...readArgs);
      seen.bytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  syncBuiltinESMExports();
  try {
    for (const [kind, expected] of Object.entries(BASELINE)) {
      const params = { root, bundle, kind };
      const { markdown, coverage, excerpts } = await materializeCharterPacket(params);
      assert.deepEqual([
        digest(markdown),
        digest(JSON.stringify(coverage)),
        digest(JSON.stringify(excerpts)),
        await charterExtractionInputRevision(params),
      ], [...expected, expected[0]], kind);
      assert.deepEqual(
        coverage.classes.find((entry) => entry.evidence_class !== "doc").omitted,
        [
          { path: "empty.ts", reason: "no_content" },
          { path: "large.ts", reason: "unreadable_or_oversized", bytes: CAP + 4096 },
          { path: "missing.ts", reason: "unreadable_or_oversized" },
          { path: "plus.ts", reason: "unreadable_or_oversized", bytes: CAP + 1 },
        ],
      );
    }

    assert.equal(await defaultReadFileText(join(root, "cap.ts"), CAP), cap);
    assert.equal(await defaultReadFileText(join(root, "almost.ts"), CAP), almost);
    assert.equal(await defaultReadFileText(join(root, "empty.ts"), CAP), "");
    assert.equal(await defaultReadFileText(join(root, "plus.ts"), CAP), undefined);
    assert.equal(await defaultReadFileText(join(root, "missing.ts"), CAP), undefined);
    assert.deepEqual(observations.get("plus.ts"), { stats: 7, reads: 0, requested: 0, bytes: 0 });
    assert.deepEqual(observations.get("large.ts"), { stats: 6, reads: 0, requested: 0, bytes: 0 });

    const growth = await materializeCharterPacket({
      root,
      bundle: {
        unit_manifest: { units: [{ unit_id: "unit", name: "Growth", files: ["growing.ts"] }] },
      },
      kind: "revealed",
    });
    assert.deepEqual(growth.excerpts, []);
    assert.deepEqual(growth.coverage.classes[0].omitted, [
      { path: "growing.ts", reason: "unreadable_or_oversized" },
    ]);
    assert.equal(growth.markdown.includes("export const value"), false);
    assert.equal(observations.get("growing.ts").stats, 1);
    assert.equal(observations.get("growing.ts").bytes, CAP + 1);
    assert.equal(observations.get("growing.ts").requested, CAP + 1);
  } finally {
    fs.open = open;
    syncBuiltinESMExports();
  }
});
