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

const { execFile, spawn } = require('node:child_process');
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

/**
 * Agente que serve a este pedido. Com `hours: 0` (só este build) apenas o agente
 * amarrado a ESTE processo serve: reaproveitar um agente de 24 h deixaria a
 * chave destrancada depois de um build que morreu antes do postMake. Pedido de 1
 * a 168 h exige prazo finito: o agente de um build com 0 morre com aquele build.
 */
function usable(status, thumbprint, now, { hours, parentPid } = {}) {
  if (!status || !status.unlocked || status.thumbprint !== thumbprint) return false;
  if (hours === 0) return status.expiresAt === null && status.parentPid === parentPid;
  return status.expiresAt !== null && status.expiresAt !== undefined && status.expiresAt - now >= MIN_REMAINING_MS;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Agente amarrado a OUTRO build que ainda roda. Trocá-lo derrubaria aquele build
 * no meio, então quem chega recusa em vez de trocar (dois builds Windows não
 * rodam juntos nesta máquina). Build que já acabou não segura nada: o agente
 * dele sai sozinho em segundos e pode ser trocado.
 */
function boundToAnotherLiveBuild(status, parentPid, isAlive = processAlive) {
  return Boolean(
    status &&
    status.expiresAt === null &&
    Number.isInteger(status.parentPid) &&
    status.parentPid !== parentPid &&
    isAlive(status.parentPid),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dois builds ao mesmo tempo não abrem duas janelas de PIN: quem chega depois
 * espera o agente do primeiro. A trava pode sumir entre o EEXIST e a leitura
 * dela (o primeiro terminou): isso é trava liberada, e a aquisição recomeça.
 */
function acquireStartLock(directory, fsImpl = fs, now = () => Date.now()) {
  const lock = path.join(directory, 'starting.lock');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fsImpl.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => fsImpl.rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let mtimeMs;
    try {
      ({ mtimeMs } = fsImpl.statSync(lock));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (now() - mtimeMs <= START_TIMEOUT_MS) return undefined;
    fsImpl.rmSync(lock, { force: true });
  }
  return undefined;
}

function launchAgent({ thumbprint, spkiSha256, hours, parentPid, pinMode, directory, nodePath, env }) {
  const args = [
    path.join(__dirname, 'agent.cjs'),
    '--thumbprint', thumbprint,
    '--spki', spkiSha256,
    '--hours', String(hours),
    '--pin-mode', pinMode,
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

const UNLOCK_MESSAGES = {
  prompt: (hours) => (hours > 0
    ? `[windows-signer] Digite o PIN do YubiKey na janela do Windows. O agente assina sem pedir de novo por ${hours} h.`
    : '[windows-signer] Digite o PIN do YubiKey na janela do Windows. O agente vale só para este build.'),
  save: () => '[windows-signer] Digite o PIN do YubiKey na janela "NexusIDE — PIN do YubiKey". Ele fica guardado pelo DPAPI deste usuário do Windows.',
  stored: () => '[windows-signer] Destrancando o YubiKey com o PIN guardado (DPAPI), sem janela.',
};

/**
 * Como o próximo agente destranca: `save` só quando pedido; com PIN guardado,
 * `stored` (nenhuma janela, e nunca cai para a janela se o PIN for recusado);
 * sem ele, a janela de PIN do Windows.
 */
function chooseUnlockMode(requested, directory) {
  if (requested === 'save') return 'save';
  return fs.existsSync(agent.pinFilePath(directory)) ? 'stored' : 'prompt';
}

/**
 * Agente destrancado para este certificado: o vivo, se ainda vale por
 * `MIN_REMAINING_MS`, ou um novo (PIN guardado, ou o Windows pede o PIN uma vez).
 * `pinMode: 'save'` sempre sobe um agente novo que pede o PIN para guardá-lo.
 */
async function ensureAgent({
  thumbprint,
  spkiSha256,
  hours,
  parentPid,
  pinMode,
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
    if (pinMode !== 'save' && usable(status, thumbprint, now(), { hours, parentPid })) return { ...status, started: false };
    if (boundToAnotherLiveBuild(status, parentPid)) {
      throw new Error(`Um build com NEXUS_WINDOWS_SIGNER_HOURS=0 (pid ${status.parentPid}) está usando o agente de assinatura. Espere ele terminar: dois builds Windows não rodam juntos nesta máquina.`);
    }
    const release = acquireStartLock(directory);
    if (!release) {
      if (now() > deadline) throw new Error('another build is still starting the signing agent');
      await sleep(2_000);
      continue;
    }
    try {
      const mode = chooseUnlockMode(pinMode, directory);
      // Guardar o PIN não derruba um agente que funciona: o antigo só sai
      // depois que o novo estiver pronto (19/10: um save-pin sem janela visível
      // deixou o operador sem agente nenhum).
      const replaced = mode === 'save' && usable(status, thumbprint, now()) ? readAgentInfo(directory) : undefined;
      if (status && !replaced) await stopAgent(directory);
      log(UNLOCK_MESSAGES[mode](hours));
      await launchAgent({ thumbprint, spkiSha256, hours, parentPid, pinMode: mode, directory, nodePath, env });
      if (replaced) await request(replaced, { op: 'stop' }, STATUS_TIMEOUT_MS).catch(() => undefined);
    } finally {
      release();
    }
    const started = await agentStatus(directory);
    if (!usable(started, thumbprint, now(), { hours, parentPid })) {
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

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'NexusIDE Windows Signer';
const LOGON_FILES = ['agent.cjs', 'client.cjs', 'engine.cs'];

function systemTool(name, env = process.env) {
  return path.join(env.SystemRoot || 'C:\\Windows', 'System32', name);
}

function runTool(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Linha da entrada `Run` do usuário: Node sem janela (`conhost --headless`), a
 * cópia dos scripts em `<agente>\bin` (não depende de checkout nenhum) e só com
 * PIN guardado: no logon nunca abre janela de PIN.
 */
function logonCommandLine({ nodePath, binDirectory, env = process.env }) {
  return [
    `"${systemTool('conhost.exe', env)}"`,
    '--headless',
    `"${nodePath}"`,
    `"${path.join(binDirectory, 'client.cjs')}"`,
    'start',
    '--if-pin-saved',
    '--wait-card',
    '--identity',
    `"${path.join(binDirectory, 'identity.json')}"`,
  ].join(' ');
}

async function installLogon({ directory, nodePath = process.execPath, identityFile, run = runTool, env = process.env }) {
  const binDirectory = path.join(directory, 'bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  for (const file of LOGON_FILES) fs.copyFileSync(path.join(__dirname, file), path.join(binDirectory, file));
  fs.copyFileSync(identityFile, path.join(binDirectory, 'identity.json'));
  const commandLine = logonCommandLine({ nodePath, binDirectory, env });
  await run(systemTool('reg.exe', env), ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', commandLine, '/f']);
  return commandLine;
}

async function uninstallLogon({ directory, run = runTool, env = process.env }) {
  try {
    await run(systemTool('reg.exe', env), ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
  } catch {
    // não estava instalado
  }
  fs.rmSync(path.join(directory, 'bin'), { recursive: true, force: true });
}

async function logonInstalled({ run = runTool, env = process.env } = {}) {
  try {
    await run(systemTool('reg.exe', env), ['query', RUN_KEY, '/v', RUN_VALUE]);
    return true;
  } catch {
    return false;
  }
}

function appendAgentLog(directory, message) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'agent.log'), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch {
    // diário é ajuda, não condição
  }
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const flags = new Set();
  let identity;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--identity') {
      identity = rest[index + 1];
      index += 1;
    } else {
      flags.add(rest[index]);
    }
  }
  return {
    command,
    flags,
    identity: identity ?? path.join(__dirname, '..', '..', 'build', 'windows-signing-identity.json'),
  };
}

function readIdentity(file) {
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!identity.certificateSha1) throw new Error(`No YubiKey certificate is pinned in ${file}.`);
  return identity;
}

/**
 * Horas de um agente subido fora de um build (`start`, logon). O `0` ("só este
 * build") não tem build a que se amarrar: é recusado, nunca trocado por 24 h.
 */
function standaloneAgentHours(env) {
  const hours = agent.parseAgentHours(env.NEXUS_WINDOWS_SIGNER_HOURS);
  if (hours === 0) {
    throw new Error('NEXUS_WINDOWS_SIGNER_HOURS=0 vale só dentro de um build (o agente morre com ele). Fora do build use de 1 a 168 horas, ou `npm run windows-signer -- stop` para encerrar o agente.');
  }
  return hours;
}

/**
 * `start` do terminal ou do logon. No logon (`--wait-card`) o YubiKey pode
 * ainda não ter aparecido: tenta por até 3 min, e para na hora se o PIN guardado
 * foi recusado (o motor já o apagou).
 */
async function startFromCli({ identity, directory, pinMode, ifPinSaved, waitCard, log = (message) => console.log(message) }) {
  const pinFile = agent.pinFilePath(directory);
  if (ifPinSaved && !fs.existsSync(pinFile)) return undefined;
  // Erro de configuração não espera o YubiKey: recusa antes de qualquer tentativa.
  const hours = standaloneAgentHours(process.env);
  const attempts = waitCard ? 12 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ensureAgent({
        thumbprint: identity.certificateSha1,
        spkiSha256: identity.spkiSha256,
        hours,
        pinMode,
        directory,
        log,
      });
    } catch (error) {
      if (attempt >= attempts || (ifPinSaved && !fs.existsSync(pinFile))) throw error;
      await sleep(15_000);
    }
  }
}

async function cli(argv) {
  const { command, flags, identity: identityFile } = parseCli(argv);
  const directory = agent.defaultAgentDirectory();
  const pinFile = agent.pinFilePath(directory);
  if (command === 'status') {
    const status = await agentStatus(directory);
    console.log(!status
      ? 'Nenhum agente de assinatura ativo.'
      : status.unlocked
        ? `Agente ativo (pid ${status.pid}), certificado ${status.thumbprint}, ${status.expiresAt === null ? 'só para o build que o abriu' : `até ${new Date(status.expiresAt).toLocaleString('pt-BR')}`}, destrancado por ${status.pinMode === 'prompt' ? 'janela do Windows' : 'PIN guardado'}.`
        : `Agente sem PIN: ${status.reason}`);
    console.log(`PIN guardado (DPAPI): ${fs.existsSync(pinFile) ? 'sim' : 'não'}.`);
    console.log(`Início no logon: ${await logonInstalled() ? 'instalado' : 'não instalado'}.`);
    return 0;
  }
  if (command === 'stop') {
    console.log(await stopAgent(directory) ? 'Agente de assinatura encerrado.' : 'Nenhum agente de assinatura ativo.');
    return 0;
  }
  if (process.platform !== 'win32') throw new Error('The YubiKey signing agent runs only on Windows.');
  if (command === 'start' || command === 'save-pin') {
    const ifPinSaved = flags.has('--if-pin-saved');
    try {
      const status = await startFromCli({
        identity: readIdentity(identityFile),
        directory,
        pinMode: command === 'save-pin' ? 'save' : undefined,
        ifPinSaved,
        waitCard: flags.has('--wait-card'),
      });
      if (!status) return 0;
      if (ifPinSaved) appendAgentLog(directory, 'logon: agent ready with the saved PIN');
      console.log(status.started
        ? `Agente pronto até ${new Date(status.expiresAt).toLocaleString('pt-BR')}.`
        : `O agente já estava ativo até ${new Date(status.expiresAt).toLocaleString('pt-BR')}: nenhum PIN pedido.`);
      if (command === 'save-pin') console.log('PIN guardado: os próximos agentes destrancam sem janela.');
      return 0;
    } catch (error) {
      if (ifPinSaved) appendAgentLog(directory, `logon: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  if (command === 'forget-pin') {
    await stopAgent(directory);
    fs.rmSync(pinFile, { force: true });
    console.log('PIN guardado apagado e agente encerrado: o próximo build pede o PIN na janela do Windows.');
    return 0;
  }
  if (command === 'install-logon') {
    readIdentity(identityFile);
    const commandLine = await installLogon({ directory, identityFile });
    console.log(`Início no logon instalado (HKCU Run "${RUN_VALUE}"): ${commandLine}`);
    if (!fs.existsSync(pinFile)) console.log('Ainda não há PIN guardado: rode `npm run windows-signer -- save-pin`.');
    return 0;
  }
  if (command === 'uninstall-logon') {
    await uninstallLogon({ directory });
    console.log('Início no logon removido.');
    return 0;
  }
  console.error('Uso: npm run windows-signer -- start|status|stop|save-pin|forget-pin|install-logon|uninstall-logon');
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
module.exports.chooseUnlockMode = chooseUnlockMode;
module.exports.logonCommandLine = logonCommandLine;
module.exports.installLogon = installLogon;
module.exports.uninstallLogon = uninstallLogon;
module.exports.startFromCli = startFromCli;
module.exports.standaloneAgentHours = standaloneAgentHours;
module.exports.boundToAnotherLiveBuild = boundToAnotherLiveBuild;
module.exports.acquireStartLock = acquireStartLock;
module.exports.MIN_REMAINING_MS = MIN_REMAINING_MS;
