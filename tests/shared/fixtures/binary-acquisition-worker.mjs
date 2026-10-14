// Inert cooperative process fixture. The parent supplies bytes over IPC; no network/spawn.
import { resolveBinary } from "../../../src/shared/analyzers/binaryAcquisition.ts";
let sequence = 0;
const replies = new Map();
process.on("message", async message => {
  if (message.kind === "bytes") {
    replies.get(message.id)?.(new Uint8Array(message.bytes)); replies.delete(message.id); return;
  }
  if (message.kind !== "start") return;
  process.send({ kind: "started" });
  const result = await resolveBinary({
    binaryName: "inert", version: "1.0.0", versionProbeArgs: ["inert", "--version"], archived: false,
    assetFor: () => "asset", checksumsAsset: "checksums", releaseUrlForAsset: name => `https://example.test/${name}`,
  }, {
    cacheDir: message.root, platform: "linux", arch: message.arch, resolveExecutable: () => null,
    deadline: { at: Date.now() + 10000 },
    fetch: url => new Promise(resolve => {
      const id = ++sequence; replies.set(id, resolve); process.send({ kind: "request", id, url });
    }),
  });
  process.send({ kind: "result", result });
  process.disconnect();
});
process.send({ kind: "ready" });
