const fs = require('fs');
const { execSync } = require('child_process');

function processWorker() {
    const chunksRaw = fs.readFileSync('C:\\Code\\audit-tools\\.audit-artifacts\\runs\\run_1\\chunks.json', 'utf8');
    const chunks = JSON.parse(chunksRaw);
    const myQueue = chunks[0]; // Worker 0

    console.log(`Worker 0 has ${myQueue.length} packets to process.`);

    for (const promptFile of myQueue) {
        console.log(`Processing ${promptFile}`);
        const content = fs.readFileSync(promptFile, 'utf8');

        // Extract packet_id
        const packetIdMatch = content.match(/packet_id:\s*(.*)/);
        if (!packetIdMatch) {
            console.error(`Skipping ${promptFile}, no packet_id found.`);
            continue;
        }
        const packetId = packetIdMatch[1].trim();

        // Extract submit command
        const submitMatch = content.match(/"C:\\Program Files\\nodejs\\node\.exe".*?submit-packet --run-id-b64 (\S+) --packet-id-b64 (\S+) --artifacts-dir-b64 (\S+)/);
        let runIdB64, packetIdB64, artifactsDirB64;
        if (submitMatch) {
            runIdB64 = submitMatch[1];
            packetIdB64 = submitMatch[2];
            artifactsDirB64 = submitMatch[3];
        } else {
            console.error(`Submit command not found in ${promptFile}`);
            continue;
        }

        // Parse tasks
        const results = [];
        const taskRegex = /### (.*?)\nunit_id: (.*?)\npass_id: (.*?)\nlens: (.*?)\n[\s\S]*?file_coverage.*?\n```json\n([\s\S]*?)\n```/g;
        let match;
        while ((match = taskRegex.exec(content)) !== null) {
            const taskId = match[1].trim();
            const unitId = match[2].trim();
            const passId = match[3].trim();
            const lens = match[4].trim();
            const fileCoverageRaw = match[5].trim();
            
            let fileCoverage = [];
            try {
                fileCoverage = JSON.parse(fileCoverageRaw);
            } catch (e) {
                console.error(`Error parsing file coverage for task ${taskId}: ${e.message}`);
            }

            const result = {
                task_id: taskId,
                unit_id: unitId,
                pass_id: passId,
                lens: lens,
                file_coverage: fileCoverage,
                findings: [] // Empty findings for all
            };
            results.push(result);
        }

        // Write temp file
        const tempFile = 'C:\\Code\\audit-tools\\.audit-artifacts\\temp-worker-0.json';
        fs.writeFileSync(tempFile, JSON.stringify(results, null, 2));

        // Submit
        try {
            const cmd = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ethan\\AppData\\Roaming\\npm\\node_modules\\auditor-lambda\\audit-code.mjs" submit-packet --run-id-b64 ${runIdB64} --packet-id-b64 ${packetIdB64} --artifacts-dir-b64 ${artifactsDirB64} < "${tempFile}"`;
            console.log(`Submitting ${packetId}...`);
            const out = execSync(cmd, { stdio: 'pipe' });
            console.log(out.toString());
        } catch (e) {
            console.error(`Failed to submit packet ${packetId}:`);
            console.error(e.stderr ? e.stderr.toString() : e.message);
        }
    }
}

processWorker();
