const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const entry = process.argv[2]; const target = process.argv[3];
const worker = new Worker(entry, { workerData: { root: process.cwd() } });
let timer; let lastJob;
function deadline(ms) { clearTimeout(timer); timer = setTimeout(async () => { const code = await worker.terminate(); console.error(JSON.stringify({ failure: 'hard regex deadline', lastJob, code })); process.exitCode = 1; }, ms); }
deadline(5000);
worker.on('message', (message) => {
 if (message.kind === 'start') { lastJob = message.id; deadline(250); }
 if (message.kind === 'end') deadline(5000);
 if (message.kind === 'done') { clearTimeout(timer); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(message.result, null, 2)); console.log(JSON.stringify(message.result)); worker.terminate(); }
});
worker.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
