// Spike de diagnóstico: spawna `omp --mode rpc-ui` com o MESMO env mínimo que
// o NexusIDE usa (buildOmpChildEnv) e pergunta get_available_models.
// Uso: node scripts/spikes/omp-models-probe.mjs [--full-env]
import { spawn } from 'node:child_process';

const fullEnv = process.argv.includes('--full-env');

const allow = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'COLORTERM'];
const env = {};
if (fullEnv) {
  Object.assign(env, process.env);
} else {
  for (const key of allow) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && (k.startsWith('LC_') || k.startsWith('XDG_'))) env[k] = v;
  }
  env.NO_COLOR = '1';
}

console.log(`[probe] env mode: ${fullEnv ? 'FULL (shell atual)' : 'ALLOWLIST (igual ao app)'}`);
console.log(`[probe] keys presentes: ${Object.keys(env).filter((k) => /KEY|TOKEN/i.test(k)).join(', ') || '(nenhuma)'}`);

const proc = spawn('/opt/homebrew/bin/omp', ['--mode', 'rpc-ui', '--approval-mode', 'always-ask'], {
  env,
  stdio: 'pipe',
});

let buf = '';
let asked = false;
const ask = () => {
  if (asked) return;
  asked = true;
  proc.stdin.write(JSON.stringify({ id: 'probe-1', type: 'get_available_models' }) + '\n');
};

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let frame;
    try {
      frame = JSON.parse(t);
    } catch {
      console.log('[probe] linha não-JSON:', t.slice(0, 300));
      continue;
    }
    if (frame.type === 'ready') {
      console.log('[probe] ready recebido → pedindo modelos…');
      ask();
    } else if (frame.command === 'get_available_models') {
      console.log('[probe] RESPOSTA get_available_models:');
      console.log(JSON.stringify(frame, null, 2));
      proc.kill('SIGTERM');
      setTimeout(() => process.exit(0), 300);
    } else {
      console.log(`[probe] frame: ${frame.type ?? '?'}${frame.command ? ` (${frame.command})` : ''}`);
    }
  }
});

proc.stderr.on('data', (d) => console.log('[probe] stderr:', String(d).trim().slice(0, 300)));
proc.on('exit', (code) => {
  console.log(`[probe] exit code=${code}`);
  process.exit(0);
});

// Fallback: se o ready não vier em 5s, pergunta mesmo assim; em 12s desiste.
setTimeout(ask, 5000);
setTimeout(() => {
  console.log('[probe] timeout — encerrando');
  proc.kill('SIGKILL');
}, 12000);
