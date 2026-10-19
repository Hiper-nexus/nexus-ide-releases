'use strict';

/**
 * Agente de assinatura do YubiKey (Windows). Um processo por usuário que abre o
 * motor (`engine.cs`, num powershell.exe 5.1), faz o Windows pedir o PIN UMA vez
 * e assina os builds seguintes sem pedir de novo até o prazo vencer. O PIN é
 * digitado na janela do próprio Windows e fica no cache do provedor de chaves do
 * cartão, dentro do processo do motor: este código nunca o vê, nunca o grava.
 *
 * O agente morre (e o cache com ele) quando o prazo vence, quando alguém pede
 * `stop`, quando o motor sai, quando o YubiKey perde o PIN (removido, sono que
 * reinicia o cartão) e, no modo por build, quando o processo do build termina.
 * Enquanto vive, ele é um assinador: qualquer processo deste usuário que leia o
 * `agent.json` (token) pode pedir assinatura de um executável nas pastas de build.
 * Por isso o prazo, a lista de pastas, só .exe/.dll/.node, e o diário
 * `signed.ndjson` com o hash de tudo o que assinou (docs/windows-signing/YUBIKEY.md).
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const AGENT_SCHEMA_VERSION = 1;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 168;
const UNLOCK_TIMEOUT_MS = 5 * 60_000;
const ENGINE_START_TIMEOUT_MS = 2 * 60_000;
/** Três tentativas de carimbo com servidor lento cabem aqui; motor que passa disto é morto. */
const SIGN_TIMEOUT_MS = 10 * 60_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll', '.node']);
const IDENTITY_FILE = path.join('build', 'windows-signing-identity.json');

/** Script fixo do powershell.exe: só .NET, nenhum cmdlet (o PSModulePath do 7 quebra o 5.1). */
const ENGINE_BOOTSTRAP = [
  "$ErrorActionPreference = 'Stop'",
  '$utf8 = [System.Text.UTF8Encoding]::new($false)',
  '$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)',
  '$writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)',
  '$writer.AutoFlush = $true',
  '$parameters = [System.CodeDom.Compiler.CompilerParameters]::new()',
  '$parameters.GenerateInMemory = $true',
  "[void]$parameters.ReferencedAssemblies.Add('System.dll')",
  '$source = [System.IO.File]::ReadAllText($env:NEXUS_SIGNER_ENGINE, $utf8)',
  '$compiled = [Microsoft.CSharp.CSharpCodeProvider]::new().CompileAssemblyFromSource($parameters, $source)',
  'if ($compiled.Errors.HasErrors) { foreach ($problem in $compiled.Errors) { [Console]::Error.WriteLine($problem.ToString()) }; exit 2 }',
  "$engine = $compiled.CompiledAssembly.GetType('NexusWindowsSigner.Engine')",
  "exit [int]$engine.GetMethod('Run').Invoke($null, [object[]]@($reader, $writer, $env:NEXUS_SIGNER_THUMBPRINT))",
].join('\n');

function defaultAgentDirectory(env = process.env) {
  if (env.NEXUS_WINDOWS_SIGNER_DIR) return path.resolve(env.NEXUS_WINDOWS_SIGNER_DIR);
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'NexusIDE', 'windows-signer');
}

/** Horas de vida do agente: 24 por padrão, 1 a 168 (uma semana), ou 0 = só este build. */
function parseAgentHours(value) {
  if (value === undefined || value === '') return DEFAULT_HOURS;
  const text = String(value).trim();
  if (!/^\d{1,3}$/u.test(text) || Number(text) > MAX_HOURS) {
    throw new Error(`NEXUS_WINDOWS_SIGNER_HOURS must be a whole number from 0 (this build only) to ${MAX_HOURS} (one week).`);
  }
  return Number(text);
}

function isTimestampUrl(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s"]+$/u.test(value);
}

function spkiSha256(certificate) {
  return crypto.createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function realDirectory(directory) {
  try {
    const real = fs.realpathSync.native(directory);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Pastas temporárias em que o packager e o Squirrel assinam (medido no make de 19/10). */
function temporaryBuildRoots(env = process.env) {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(localAppData, 'SquirrelTemp'),
    path.join(os.tmpdir(), 'electron-packager'),
  ];
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * O staging do electron-packager fica no TEMP de quem roda o build, que pode
 * não ser o do agente (o agente vive dias e serve builds de terminais
 * diferentes): o pedido diz qual é, e só uma pasta chamada `electron-packager`
 * vale.
 */
function packagerRootFrom(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.basename(value) === 'electron-packager'
    ? [value]
    : [];
}

/**
 * Decide se um arquivo pode ser assinado. Só executável (.exe/.dll/.node),
 * arquivo comum, com o caminho real (junction e link resolvidos) dentro de uma
 * pasta de build: a `out\` de um checkout do NexusIDE que fixa ESTE certificado,
 * a SquirrelTemp ou a pasta de staging do electron-packager. Devolve o caminho
 * real que o motor vai assinar.
 */
function resolveSignableFile({ file, checkoutRoot, thumbprint, temporaryRoots }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('file must be an absolute path');
  if (!SIGNABLE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new Error(`refusing ${path.basename(file)}: only .exe, .dll and .node files are signed`);
  }
  let real;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    throw new Error(`refusing ${file}: it does not exist`);
  }
  if (!fs.lstatSync(real).isFile()) throw new Error(`refusing ${file}: not a regular file`);
  if (!SIGNABLE_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw new Error(`refusing ${file}: it resolves to a file that is not .exe, .dll or .node`);
  }
  const roots = [];
  for (const root of temporaryRoots) {
    const realRoot = realDirectory(root);
    if (realRoot) roots.push(realRoot);
  }
  const checkout = typeof checkoutRoot === 'string' && path.isAbsolute(checkoutRoot)
    ? realDirectory(checkoutRoot)
    : undefined;
  if (checkout && checkoutPinsThumbprint(checkout, thumbprint)) {
    const out = realDirectory(path.join(checkout, 'out'));
    if (out) roots.push(out);
  }
  if (!roots.some((root) => isInside(root, real))) {
    throw new Error(`refusing ${file}: outside the build folders (out\\ of a NexusIDE checkout, SquirrelTemp, electron-packager)`);
  }
  return real;
}

function checkoutPinsThumbprint(checkout, thumbprint) {
  try {
    const identity = JSON.parse(fs.readFileSync(path.join(checkout, IDENTITY_FILE), 'utf8'));
    return identity && identity.certificateSha1 === thumbprint;
  } catch {
    return false;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function fromB64(text) {
  return Buffer.from(text || '', 'base64').toString('utf8');
}

function windowsPowerShell(env = process.env) {
  return path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Abre o motor e fala com ele uma linha por vez. A primeira linha é a do
 * certificado; as seguintes respondem aos comandos na ordem em que saíram.
 */
function startEngine({ thumbprint, env = process.env, spawnEngine }) {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  childEnv.NEXUS_SIGNER_ENGINE = path.join(__dirname, 'engine.cs');
  childEnv.NEXUS_SIGNER_THUMBPRINT = thumbprint;
  const child = spawnEngine
    ? spawnEngine(childEnv)
    : spawn(windowsPowerShell(env), [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(ENGINE_BOOTSTRAP, 'utf16le').toString('base64'),
    ], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const waiting = [];
  let stderr = '';
  let exited = false;
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const next = waiting.shift();
    if (next) next.resolve(line);
  });
  const failAll = (error) => {
    exited = true;
    for (const next of waiting.splice(0)) next.reject(error);
  };
  child.on('error', failAll);
  child.on('exit', (code) => {
    failAll(new Error(`the signing engine exited (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
  });

  const nextLine = (timeoutMs) => new Promise((resolve, reject) => {
    if (exited) {
      reject(new Error('the signing engine is not running'));
      return;
    }
    const entry = {
      resolve: (line) => { clearTimeout(timer); resolve(line); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      reject(new Error('the signing engine did not answer in time'));
      child.kill();
    }, timeoutMs);
    waiting.push(entry);
  });

  // Um comando por vez: o motor é sequencial e o cartão também.
  let queue = Promise.resolve();
  const command = (line, timeoutMs) => {
    const run = queue.then(() => {
      const answer = nextLine(timeoutMs);
      child.stdin.write(`${line}\n`);
      return answer;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    child,
    first: () => nextLine(ENGINE_START_TIMEOUT_MS),
    command,
    get exited() { return exited; },
    close: () => {
      if (!exited) child.stdin.end();
    },
  };
}

function engineAnswer(line) {
  const [kind, ...rest] = line.split(' ');
  return { kind, rest, message: rest[0] ? fromB64(rest[0]) : '' };
}

function pipePath(id) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nexus-windows-signer-${id}`
    : path.join(os.tmpdir(), `nexus-windows-signer-${id}.sock`);
}

function writeFileAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Sobe o agente: motor, conferência do certificado, PIN, pipe. `onReady` recebe
 * as informações públicas (sem token) quando o agente aceita pedidos.
 */
async function runAgent({
  thumbprint,
  expectedSpkiSha256,
  hours,
  parentPid,
  directory = defaultAgentDirectory(),
  env = process.env,
  spawnEngine,
  now = () => Date.now(),
  onReady = () => undefined,
}) {
  fs.mkdirSync(directory, { recursive: true });
  const logFile = path.join(directory, 'agent.log');
  const log = (message) => {
    try {
      fs.appendFileSync(logFile, `${new Date(now()).toISOString()} [${process.pid}] ${message}\n`);
    } catch {
      // diário é ajuda, não condição
    }
  };
  const audit = (entry) => {
    fs.appendFileSync(path.join(directory, 'signed.ndjson'), `${JSON.stringify(entry)}\n`);
  };

  const engine = startEngine({ thumbprint, env, spawnEngine });
  let server;
  let stopping = false;
  let ttlTimer;
  let parentTimer;
  const infoFile = path.join(directory, 'agent.json');
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });

  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    clearTimeout(ttlTimer);
    clearInterval(parentTimer);
    try {
      const current = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
      if (current.pid === process.pid) fs.rmSync(infoFile, { force: true });
    } catch {
      // nada a limpar
    }
    engine.close();
    if (server) server.close();
    resolveStopped(reason);
  };
  engine.child.on('exit', () => shutdown('the signing engine exited'));

  try {
    const first = engineAnswer(await engine.first());
    if (first.kind !== 'CERT') throw new Error(first.message || 'the signing engine did not start');
    const der = Buffer.from(first.rest[0] || '', 'base64');
    const certificate = new crypto.X509Certificate(der);
    const actualThumbprint = certificate.fingerprint.replaceAll(':', '').toUpperCase();
    if (actualThumbprint !== thumbprint) throw new Error(`the engine opened ${actualThumbprint}, not ${thumbprint}`);
    if (spkiSha256(certificate) !== expectedSpkiSha256) {
      throw new Error('the certificate public key is not the YubiKey slot 9a key');
    }
    if (first.rest[1] !== '1') throw new Error('Windows has no private key for the certificate (YubiKey unplugged?)');

    log('unlocking: Windows asks for the YubiKey PIN');
    const unlocked = engineAnswer(await engine.command('UNLOCK', UNLOCK_TIMEOUT_MS));
    if (unlocked.kind !== 'UNLOCKED') throw new Error(unlocked.message || 'the YubiKey did not unlock');

    const token = crypto.randomBytes(32).toString('hex');
    const tokenBuffer = Buffer.from(token);
    const pipe = pipePath(crypto.randomBytes(16).toString('hex'));
    const startedAt = now();
    const expiresAt = hours > 0 ? startedAt + hours * 3_600_000 : null;
    const temporaryRoots = temporaryBuildRoots(env);

    const status = async () => {
      const probe = engineAnswer(await engine.command('PROBE', SIGN_TIMEOUT_MS));
      if (probe.kind !== 'OK') {
        setImmediate(() => shutdown(`locked: ${probe.message}`));
        return { ok: true, unlocked: false, reason: probe.message };
      }
      return {
        ok: true,
        unlocked: true,
        pid: process.pid,
        thumbprint,
        certificate: der.toString('base64'),
        startedAt,
        expiresAt,
      };
    };

    const handle = async (request) => {
      const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
      if (supplied.length !== tokenBuffer.length || !crypto.timingSafeEqual(supplied, tokenBuffer)) {
        return { ok: false, error: 'unauthorized' };
      }
      if (stopping) return { ok: false, error: 'the signing agent is stopping' };
      if (request.op === 'status') return status();
      if (request.op === 'stop') {
        setImmediate(() => shutdown('stop requested'));
        return { ok: true };
      }
      if (request.op !== 'sign' && request.op !== 'verify') return { ok: false, error: 'unknown operation' };
      const file = resolveSignableFile({
        file: request.file,
        checkoutRoot: request.checkoutRoot,
        thumbprint,
        temporaryRoots: [...temporaryRoots, ...packagerRootFrom(request.packagerRoot)],
      });
      if (request.op === 'verify') {
        const answer = engineAnswer(await engine.command(`VERIFY ${b64(file)}`, SIGN_TIMEOUT_MS));
        return answer.kind === 'OK' ? { ok: true } : { ok: false, error: answer.message };
      }
      if (!isTimestampUrl(request.timestampServer)) return { ok: false, error: 'timestampServer must be an http(s) URL' };
      const answer = engineAnswer(await engine.command(`SIGN ${b64(file)} ${b64(request.timestampServer)}`, SIGN_TIMEOUT_MS));
      if (answer.kind === 'LOCKED') {
        setImmediate(() => shutdown(`locked: ${answer.message}`));
        return { ok: false, locked: true, error: answer.message };
      }
      if (answer.kind !== 'OK') {
        log(`sign failed: ${file}: ${answer.message}`);
        return { ok: false, error: answer.message };
      }
      const sha256 = sha256File(file);
      audit({ at: new Date(now()).toISOString(), file, sha256, requester: request.requester ?? null });
      return { ok: true, sha256 };
    };

    server = net.createServer((socket) => {
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('error', () => undefined);
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.end(`${JSON.stringify({ ok: false, error: 'request too large' })}\n`);
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        socket.removeAllListeners('data');
        let request;
        try {
          request = JSON.parse(buffer.slice(0, newline));
        } catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'invalid request' })}\n`);
          return;
        }
        handle(request ?? {})
          .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
          .then((answer) => socket.end(`${JSON.stringify(answer)}\n`));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, resolve);
    });

    writeFileAtomic(infoFile, `${JSON.stringify({
      schemaVersion: AGENT_SCHEMA_VERSION,
      pid: process.pid,
      pipe,
      token,
      thumbprint,
      startedAt,
      expiresAt,
    })}\n`);
    if (expiresAt !== null) ttlTimer = setTimeout(() => shutdown('expired'), expiresAt - startedAt);
    if (parentPid) {
      parentTimer = setInterval(() => {
        try {
          process.kill(parentPid, 0);
        } catch {
          shutdown('the build that started this agent ended');
        }
      }, 5_000);
    }
    log(`ready until ${expiresAt === null ? 'the build ends' : new Date(expiresAt).toISOString()}`);
    onReady({ pid: process.pid, pipe, thumbprint, startedAt, expiresAt });
  } catch (error) {
    shutdown(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return stopped;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`bad argument ${name}`);
    options[name.slice(2)] = value;
  }
  return options;
}

/** Entrada do processo destacado: READY/FAILED vão ao launcher pelo stdout, uma vez. */
async function main(argv) {
  const say = (line) => {
    try {
      process.stdout.write(`${line}\n`);
    } catch {
      // o launcher já soltou o pipe
    }
  };
  process.stdout.on('error', () => undefined);
  process.stderr.on('error', () => undefined);
  try {
    const options = parseArguments(argv);
    if (!/^[A-F0-9]{40}$/u.test(options.thumbprint ?? '')) throw new Error('--thumbprint must be 40 uppercase hex characters');
    if (!/^[a-f0-9]{64}$/u.test(options.spki ?? '')) throw new Error('--spki must be 64 lowercase hex characters');
    const reason = await runAgent({
      thumbprint: options.thumbprint,
      expectedSpkiSha256: options.spki,
      hours: parseAgentHours(options.hours),
      parentPid: options['parent-pid'] ? Number(options['parent-pid']) : undefined,
      onReady: (info) => say(`READY ${JSON.stringify(info)}`),
    });
    process.exitCode = reason === 'expired' || reason === 'stop requested' ? 0 : 1;
  } catch (error) {
    say(`FAILED ${b64(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  }
  // Pipe e motor fechados: nada mais segura o processo.
  setTimeout(() => process.exit(), 1_000).unref();
}

if (require.main === module) {
  void main(process.argv.slice(2));
}

module.exports = {
  AGENT_SCHEMA_VERSION,
  DEFAULT_HOURS,
  MAX_HOURS,
  ENGINE_BOOTSTRAP,
  defaultAgentDirectory,
  parseAgentHours,
  isTimestampUrl,
  temporaryBuildRoots,
  packagerRootFrom,
  resolveSignableFile,
  startEngine,
  runAgent,
  fromB64,
  b64,
};
