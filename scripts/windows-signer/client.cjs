'use strict';

/**
 * Cliente do agente de assinatura do YubiKey (agent.cjs).
 *
 * - Exportado como função, é o `hookModulePath` do @electron/windows-sign: o
 *   packager o carrega dentro do Forge e o Squirrel o carrega no signtool falso
 *   (o executável SEA do electron-winstaller), uma vez por executável. Nos dois
 *   casos ele pede a assinatura ao agente vivo, que já tem o PIN: nenhum desses
 *   processos abre janela de PIN.
 * - `ensureAgent` é o que o Forge chama antes de empacotar: reaproveita o agente
 *   destrancado (zero PIN) ou sobe um novo (a janela de PIN do Windows, uma vez).
 * - Rodado direto (`npm run windows-signer -- start|status|stop`) liga, mostra e
 *   desliga o agente sem build.
 *
 * O @electron/windows-sign engole o erro do hook (sign-with-hook.js só registra),
 * então uma falha aqui marca `process.exitCode = 1` (o signtool falso sai com 1 e o
 * Squirrel para) e fica na lista `failures()`, que o Forge confere depois do pacote.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const agent = require('./agent.cjs');

const FAILURES = Symbol.for('nexus.windowsSigner.failures');
const STATUS_TIMEOUT_MS = 60_000;
const SIGN_REQUEST_TIMEOUT_MS = 12 * 60_000;
const START_TIMEOUT_MS = 7 * 60_000;
/** Agente que vence antes disto não serve para um build novo: sobe outro. */
const MIN_REMAINING_MS = 45 * 60_000;

function failureList() {
  globalThis[FAILURES] ??= [];
  return globalThis[FAILURES];
}

function failures() {
  return [...failureList()];
}

function readAgentInfo(directory) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(directory, 'agent.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (
    !info ||
    info.schemaVersion !== agent.AGENT_SCHEMA_VERSION ||
    typeof info.pipe !== 'string' ||
    typeof info.token !== 'string' ||
    typeof info.thumbprint !== 'string' ||
    !Number.isInteger(info.pid)
  ) {
    return undefined;
  }
  return info;
}

function request(info, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.pipe);
    let answer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('the signing agent did not answer in time'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...payload, token: info.token })}\n`));
    socket.on('data', (chunk) => { answer += chunk; });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(answer));
      } catch {
        reject(new Error('the signing agent sent an invalid answer'));
      }
    });
  });
}

/** Estado do agente registrado, ou `undefined` se não há agente vivo. */
async function agentStatus(directory = agent.defaultAgentDirectory()) {
  const info = readAgentInfo(directory);
  if (!info) return undefined;
  try {
    const answer = await request(info, { op: 'status' }, STATUS_TIMEOUT_MS);
    return answer && answer.ok ? { info, ...answer } : undefined;
  } catch {
    return undefined;
  }
}

async function stopAgent(directory = agent.defaultAgentDirectory()) {
  const info = readAgentInfo(directory);
  if (!info) return false;
  try {
    const answer = await request(info, { op: 'stop' }, STATUS_TIMEOUT_MS);
    return Boolean(answer && answer.ok);
  } catch {
    return false;
  }
}

function usable(status, thumbprint, now) {
  return Boolean(
    status &&
    status.unlocked &&
    status.thumbprint === thumbprint &&
    (status.expiresAt === null || status.expiresAt - now >= MIN_REMAINING_MS),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dois builds ao mesmo tempo não abrem duas janelas de PIN: quem chega depois
 * espera o agente do primeiro.
 */
function acquireStartLock(directory) {
  const lock = path.join(directory, 'starting.lock');
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return () => fs.rmSync(lock, { force: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > START_TIMEOUT_MS) {
      fs.rmSync(lock, { force: true });
      return acquireStartLock(directory);
    }
    return undefined;
  }
}

function launchAgent({ thumbprint, spkiSha256, hours, parentPid, directory, nodePath, env }) {
  const args = [
    path.join(__dirname, 'agent.cjs'),
    '--thumbprint', thumbprint,
    '--spki', spkiSha256,
    '--hours', String(hours),
  ];
  if (parentPid) args.push('--parent-pid', String(parentPid));
  const child = spawn(nodePath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...env, NEXUS_WINDOWS_SIGNER_DIR: directory },
  });
  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    const release = () => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const timer = setTimeout(() => {
      release();
      child.kill();
      reject(new Error('the YubiKey PIN was not entered in time'));
    }, START_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      const line = output.slice(0, newline).trim();
      release();
      if (line.startsWith('READY ')) {
        resolve(JSON.parse(line.slice('READY '.length)));
      } else if (line.startsWith('FAILED ')) {
        reject(new Error(agent.fromB64(line.slice('FAILED '.length))));
      } else {
        reject(new Error(`unexpected answer from the signing agent: ${line}`));
      }
    });
    child.on('error', (error) => {
      release();
      reject(error);
    });
    child.on('exit', (code) => {
      release();
      reject(new Error(`the signing agent exited (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * Agente destrancado para este certificado: o vivo, se ainda vale por
 * `MIN_REMAINING_MS`, ou um novo (o Windows pede o PIN uma vez).
 */
async function ensureAgent({
  thumbprint,
  spkiSha256,
  hours,
  parentPid,
  directory = agent.defaultAgentDirectory(),
  nodePath = process.execPath,
  env = process.env,
  now = () => Date.now(),
  log = (message) => console.log(message),
}) {
  fs.mkdirSync(directory, { recursive: true });
  const deadline = now() + START_TIMEOUT_MS;
  for (;;) {
    const status = await agentStatus(directory);
    if (usable(status, thumbprint, now())) return { ...status, started: false };
    const release = acquireStartLock(directory);
    if (!release) {
      if (now() > deadline) throw new Error('another build is still starting the signing agent');
      await sleep(2_000);
      continue;
    }
    try {
      if (status) await stopAgent(directory);
      log(hours > 0
        ? `[windows-signer] Digite o PIN do YubiKey na janela do Windows. O agente assina sem pedir de novo por ${hours} h.`
        : '[windows-signer] Digite o PIN do YubiKey na janela do Windows. O agente vale só para este build.');
      await launchAgent({ thumbprint, spkiSha256, hours, parentPid, directory, nodePath, env });
    } finally {
      release();
    }
    const started = await agentStatus(directory);
    if (!usable(started, thumbprint, now())) {
      throw new Error('the signing agent started but does not answer as unlocked');
    }
    return { ...started, started: true };
  }
}

function recordFailure(file, error) {
  const message = error instanceof Error ? error.message : String(error);
  failureList().push({ file, error: message });
  process.exitCode = 1;
  return message;
}

async function askAgent(op, file, env) {
  const directory = agent.defaultAgentDirectory(env);
  const info = readAgentInfo(directory);
  if (!info) {
    throw new Error('no YubiKey signing agent is running: start the build again (it opens the PIN window once).');
  }
  const answer = await request(info, {
    op,
    file: path.resolve(file),
    checkoutRoot: env.NEXUS_WINDOWS_SIGNER_CHECKOUT,
    packagerRoot: path.join(os.tmpdir(), 'electron-packager'),
    timestampServer: env.NEXUS_WINDOWS_SIGNER_TIMESTAMP,
    requester: { pid: process.pid, ppid: process.ppid },
  }, SIGN_REQUEST_TIMEOUT_MS);
  if (!answer || !answer.ok) {
    throw new Error(`${path.basename(file)}: ${answer && answer.error ? answer.error : 'the signing agent refused'}`);
  }
  return answer;
}

/** Hook do @electron/windows-sign: um arquivo por chamada. */
async function signFile(file) {
  try {
    await askAgent('sign', file, process.env);
    console.log(`[windows-signer] assinado ${file}`);
  } catch (error) {
    const message = recordFailure(file, error);
    console.error(`[windows-signer] FALHOU ${file}: ${message}`);
    throw error;
  }
}

async function verifyFile(file, env = process.env) {
  await askAgent('verify', file, env);
}

async function cli(argv) {
  const [command] = argv;
  const directory = agent.defaultAgentDirectory();
  if (command === 'status') {
    const status = await agentStatus(directory);
    if (!status) {
      console.log('Nenhum agente de assinatura ativo.');
      return 0;
    }
    console.log(status.unlocked
      ? `Agente ativo (pid ${status.pid}), certificado ${status.thumbprint}, ${status.expiresAt === null ? 'só para o build que o abriu' : `até ${new Date(status.expiresAt).toLocaleString('pt-BR')}`}.`
      : `Agente sem PIN: ${status.reason}`);
    return 0;
  }
  if (command === 'stop') {
    console.log(await stopAgent(directory) ? 'Agente de assinatura encerrado.' : 'Nenhum agente de assinatura ativo.');
    return 0;
  }
  if (command === 'start') {
    if (process.platform !== 'win32') throw new Error('The YubiKey signing agent runs only on Windows.');
    const identity = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', 'build', 'windows-signing-identity.json'),
      'utf8',
    ));
    if (!identity.certificateSha1) throw new Error('No YubiKey certificate is pinned in build/windows-signing-identity.json.');
    const status = await ensureAgent({
      thumbprint: identity.certificateSha1,
      spkiSha256: identity.spkiSha256,
      hours: agent.parseAgentHours(process.env.NEXUS_WINDOWS_SIGNER_HOURS) || agent.DEFAULT_HOURS,
      directory,
    });
    console.log(status.started
      ? `Agente pronto até ${new Date(status.expiresAt).toLocaleString('pt-BR')}.`
      : `O agente já estava ativo até ${new Date(status.expiresAt).toLocaleString('pt-BR')}: nenhum PIN pedido.`);
    return 0;
  }
  console.error('Uso: npm run windows-signer -- start|status|stop');
  return 2;
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}

module.exports = signFile;
module.exports.signFile = signFile;
module.exports.verifyFile = verifyFile;
module.exports.ensureAgent = ensureAgent;
module.exports.agentStatus = agentStatus;
module.exports.stopAgent = stopAgent;
module.exports.failures = failures;
module.exports.readAgentInfo = readAgentInfo;
module.exports.parseAgentHours = agent.parseAgentHours;
module.exports.MIN_REMAINING_MS = MIN_REMAINING_MS;
