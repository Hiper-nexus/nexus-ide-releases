#!/usr/bin/env node
'use strict';
// F-997: lançador Node de uma CLI de agente FALSA, no formato exato do
// codex.js / bin/mimo — repassa o PRÓPRIO argv (com o brief da missão) ao
// binário "nativo". É esse hand-off que o F-984 tirou da fila de comandos
// pesados; nenhum modelo de IA é chamado em lugar nenhum.
const path = require('node:path');
const { spawn } = require('node:child_process');

const payload = path.join(__dirname, 'fake-agent-native');
const child = spawn(payload, process.argv.slice(2), { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* já saiu */ } });
}
child.on('error', (error) => {
  process.stderr.write(`[nexus-e2e-agent] o binário nativo não iniciou: ${error.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
