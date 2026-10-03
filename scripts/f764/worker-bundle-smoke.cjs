const { Worker } = require('node:worker_threads');
const path = require('node:path');
const entry = process.argv[2];
const worker = new Worker(entry, { workerData: { manifestDir: path.join(process.cwd(), 'resources/agent-detection') } });
let seq = 0;
let phase = 0;
let bytes = 0;
const evidence = [];
let timer;
const send = (body) => {
  clearTimeout(timer);
  timer = setTimeout(() => { console.error('worker-smoke timed out'); worker.terminate(); process.exitCode = 1; }, 2000);
  worker.postMessage({ workerEpoch: 1, sessionId: 'finite-smoke', generation: 1, eventSeq: ++seq, observedAt: Date.now(), ...body });
};
const steps = [
  { kind: 'bind', binding: { adapterId: 'codex', paneId: 'finite-smoke' } },
  { kind: 'arm', consumer: 'screen', registration: 1 },
  { kind: 'arm', consumer: 'completion', registration: 1, config: { prompt: 'Faça a prova e escreva PRONTO: resumo' } },
  { kind: 'arm', consumer: 'command', registration: 1 },
  { kind: 'data', data: '\x1b[32mPRONTO: Worker bundling verified\x1b[0m\n\x1b]133;E;echo verified\x07\x1b]133;B\x07\x1b]133;D;0\x07' },
  { kind: 'exit' },
];
worker.on('message', (message) => {
  if (message.kind === 'failed') throw new Error(message.reason);
  if (message.kind === 'ready') send(steps[phase++]);
  if (message.kind !== 'result') return;
  evidence.push(...message.events);
  bytes += message.ackBytes;
  if (message.done === false) return;
  if (phase < steps.length) send(steps[phase++]);
  else {
    clearTimeout(timer);
    const completion = evidence.some((e) => e.consumer === 'completion' && e.value.text === 'Worker bundling verified');
    const command = evidence.some((e) => e.consumer === 'command' && e.value.kind === 'command_finished');
    if (!completion || !command) throw new Error('worker-smoke missing semantic events');
    console.log(JSON.stringify({ label: 'standalone bundled Worker smoke (not C.1/C.2 acceptance)', entry, ackedBytes: bytes, completion, command, eventCount: evidence.length }));
    worker.terminate();
  }
});
worker.on('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
