import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function toBase64Url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const root = "C:\\Code\\audit-tools";
const artifactsDir = join(root, ".audit-artifacts");
const runDir = join(artifactsDir, "runs", "run_1");
const workerResultsDir = join(runDir, "worker-results");
const ingestedDir = join(runDir, "worker-results-ingested");

if (!existsSync(ingestedDir)) {
  mkdirSync(ingestedDir, { recursive: true });
}

let files;
try {
  files = readdirSync(workerResultsDir).filter(f => f.endsWith(".json"));
} catch {
  files = [];
}

let ingestedCount = 0;
let errorCount = 0;

for (const file of files) {
  // worker-X-packet-ID.json
  // Extract packet ID. E.g. worker-0-packet-19-a1413c783c.json -> packet-19-a1413c783c
  const match = file.match(/worker-\d+-(packet-.*)\.json/);
  if (!match) continue;
  const packetId = match[1];

  const filePath = join(workerResultsDir, file);
  
  // Submit packet via CLI
  try {
    console.log(`Submitting ${packetId} from ${file}...`);
    // Read the JSON content to pass via stdin
    const content = readFileSync(filePath, "utf8");
    
    // Execute submit-packet
    const cmd = `node packages/audit-code/audit-code.mjs submit-packet --run-id-b64 ${toBase64Url("run_1")} --packet-id-b64 ${toBase64Url(packetId)} --artifacts-dir-b64 ${toBase64Url(artifactsDir)}`;
    
    execSync(cmd, { cwd: root, input: content, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`Successfully ingested ${packetId}`);
    
    // Move to ingested directory
    renameSync(filePath, join(ingestedDir, file));
    ingestedCount++;
  } catch (err) {
    console.error(`Failed to ingest ${file}:`, err.message);
    if (err.stderr) console.error(err.stderr.toString());
    errorCount++;
  }
}

console.log(`Ingestion complete. Success: ${ingestedCount}, Errors: ${errorCount}`);
