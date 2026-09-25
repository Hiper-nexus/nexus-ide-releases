// `npm run release:mac` — build, gate e publicação macOS por um job do launchd.
//
// Por que launchd: dentro de um pane do Nexus todo processo tem o
// `nexus-pty-supervisor __run-disclaimed` do pane como "processo responsável"
// do macOS. O app empacotado lançado a partir dali herda esse responsável, e o
// supervisor dele recusa abrir terminal (`responsible_is_supervisor` em
// /tmp/nexus-pty-launch-auth-fail.log): o smoke empacotado morre em
// `dictation-hold-to-talk (write-refused-exited)`. Um job do launchd nasce com
// a cadeia de responsabilidade limpa — igual ao app aberto pelo Finder — e o
// mesmo comando funciona do pane e do Terminal.
//
// O comando fica em primeiro plano repassando o log do job e sai com o código
// das etapas. Etapas: build (make:release) → candidate (release:candidate) →
// publish (release:publish:macos), cada uma só se a anterior passar; o
// rebuild:node roda sempre no fim. Versão, CHANGELOG e tag continuam manuais.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEAM_ID = '35P5XL3JN6';
const NOTARY_PROFILE = 'nexus-notary';
const LABEL_PREFIX = 'com.nexuside.release.';
const STEP_ORDER = ['build', 'candidate', 'publish'];
const STEP_SCRIPTS = {
  build: 'make:release',
  candidate: 'release:candidate',
  publish: 'release:publish:macos',
  rebuild: 'rebuild:node',
};
const RELEASE_PROCESS_PATTERN =
  'make-release|electron-forge|electron-packager|release-candidate-gate|publish-release|nexus-release-e2e';
const POLL_MS = 500;

export function parseReleaseMacArgs(argv) {
  const options = { from: 'build', publish: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-publish') {
      options.publish = false;
    } else if (arg === '--from') {
      const value = argv[index + 1];
      if (value !== 'build' && value !== 'candidate') {
        throw new Error('--from aceita "build" ou "candidate"');
      }
      options.from = value;
      index += 1;
    } else {
      throw new Error(`argumento desconhecido: ${arg}`);
    }
  }
  return options;
}

export function releaseSteps({ from, publish }) {
  return STEP_ORDER.slice(STEP_ORDER.indexOf(from)).filter(
    (step) => publish || step !== 'publish',
  );
}

/** Roda as etapas em ordem; para na primeira falha; rebuild:node sempre. */
export function runReleaseSteps(steps, runStep) {
  const results = [];
  let exitCode = 0;
  for (const step of steps) {
    const code = runStep(step);
    results.push({ step, exitCode: code });
    if (code !== 0) {
      exitCode = code;
      break;
    }
  }
  const rebuild = runStep('rebuild');
  results.push({ step: 'rebuild', exitCode: rebuild });
  if (exitCode === 0 && rebuild !== 0) exitCode = rebuild;
  return { results, exitCode };
}

export function assertReleaseNode({ actual, expected }) {
  if (actual !== `v${expected}`) {
    throw new Error(
      `a release exige Node ${expected} (package.json > nexusRelease.node); ` +
        `encontrado ${actual}. Rode com esse Node ou aponte NEXUS_RELEASE_NODE ` +
        'para o binário dele.',
    );
  }
}

export function assertNoReleaseRunning({ launchdList, processes }) {
  const job = launchdList
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? '')
    .find((label) => label.startsWith(LABEL_PREFIX));
  if (job) {
    throw new Error(`já existe um job de release carregado: ${job}`);
  }
  const running = processes.trim();
  if (running) {
    throw new Error(`há processo de release rodando (um por vez):\n${running}`);
  }
}

/** Ambiente de cada etapa, no mesmo contrato do runbook (build/notarize.md). */
export function stepEnvironment(step, baseEnv, { nodeDir, repoRoot }) {
  const {
    APPLE_ID: _appleId,
    APPLE_APP_SPECIFIC_PASSWORD: _applePassword,
    APPLE_TEAM_ID: _teamId,
    APPLE_KEYCHAIN_PROFILE: _profile,
    NEXUS_MAC_PUBLISH_RELEASE: _publish,
    ...rest
  } = baseEnv;
  const pathPrefix =
    step === 'build'
      ? `${path.join(repoRoot, 'scripts', 'codesign-retry-bin')}:${nodeDir}`
      : nodeDir;
  const env = { ...rest, PATH: `${pathPrefix}:${baseEnv.PATH ?? ''}` };
  if (step === 'rebuild') return env;
  return {
    ...env,
    NEXUS_MAC_PUBLISH_RELEASE: '1',
    APPLE_TEAM_ID: TEAM_ID,
    APPLE_KEYCHAIN_PROFILE: NOTARY_PROFILE,
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildLaunchdPlist({
  label,
  programArguments,
  workingDirectory,
  logPath,
  environment,
}) {
  const args = programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  const env = Object.entries(environment)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`,
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(workingDirectory)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    env,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(logPath)}</string>`,
    // Uma execução só: `launchctl submit` reinicia o job quando ele termina e
    // repetiria o gate (visto na 0.76.99).
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function readFrom(file, offset) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { text: '', offset };
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      return { text: buffer.toString('utf8'), offset: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', offset };
  }
}

/** Lê `launchctl print`: job rodando e o último código de saída. */
export function parseJobStatus(printOutput) {
  const state = /^\s*state = (.+)$/mu.exec(printOutput)?.[1]?.trim();
  const exit = /^\s*last exit code = (-?\d+)/mu.exec(printOutput)?.[1];
  return {
    // Parado só nos estados finais. A partida passa por spawn scheduled →
    // spawning → xpcproxy → running, e ler um desses como "terminou" derrubou
    // o job 7 ms após o bootstrap (0.76.101). Sem linha de estado (bootstrap
    // acabou de voltar) também conta como rodando.
    // ponytail: um estado final desconhecido faria o controlador esperar;
    // se aparecer, entra nesta lista.
    running: state !== 'not running' && state !== 'exited',
    lastExitCode: exit === undefined ? null : Number(exit),
  };
}

/** Controlador: sobe o job, repassa o log, espera o estado e sempre faz bootout. */
export async function runDetachedRelease(options, deps) {
  if (deps.platform !== 'darwin') {
    throw new Error('release:mac só roda no macOS');
  }
  assertReleaseNode({ actual: deps.nodeVersion, expected: deps.expectedNodeVersion });
  assertNoReleaseRunning({
    launchdList: deps.launchdList(),
    processes: deps.releaseProcesses(),
  });

  const workDir = deps.makeWorkDir();
  const label = `${LABEL_PREFIX}${deps.version}.${deps.nonce()}`;
  const logPath = path.join(workDir, 'release.log');
  const statePath = path.join(workDir, 'state.json');
  const plistPath = path.join(workDir, `${label}.plist`);
  const runnerArgs = [
    '--runner',
    '--state',
    statePath,
    '--from',
    options.from,
    ...(options.publish ? [] : ['--no-publish']),
  ];
  const command =
    `exec ${shellQuote(deps.nodePath)} ${shellQuote(path.join(deps.repoRoot, 'scripts', 'release-mac-detached.mjs'))} ` +
    runnerArgs.map(shellQuote).join(' ');
  fs.writeFileSync(
    plistPath,
    buildLaunchdPlist({
      label,
      // Shell de login: o E2E do gate precisa do PATH das CLIs do operador.
      programArguments: ['/bin/zsh', '-lc', command],
      workingDirectory: deps.repoRoot,
      logPath,
      environment: { HOME: deps.realHome, NEXUS_RELEASE_NODE: deps.nodePath },
    }),
  );

  const domain = `gui/${deps.uid}`;
  const boot = deps.launchctl(['bootstrap', domain, plistPath]);
  if (boot.status !== 0) {
    throw new Error(`launchctl bootstrap falhou: ${boot.stderr ?? ''}`.trim());
  }
  try {
    let offset = 0;
    for (;;) {
      const chunk = readFrom(logPath, offset);
      offset = chunk.offset;
      if (chunk.text) deps.write(chunk.text);
      if (fs.existsSync(statePath)) {
        const tail = readFrom(logPath, offset);
        if (tail.text) deps.write(tail.text);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        return Number.isInteger(state.exitCode) ? state.exitCode : 1;
      }
      // O runner pode morrer antes de gravar o estado (Node ausente, erro no
      // shell de login): sem esta checagem o comando esperaria para sempre.
      const status = deps.jobStatus(label);
      if (!status.running && !fs.existsSync(statePath)) {
        const tail = readFrom(logPath, offset);
        if (tail.text) deps.write(tail.text);
        throw new Error(
          `o job ${label} terminou sem gravar o estado (último exit ${status.lastExitCode ?? 'desconhecido'})`,
        );
      }
      await deps.sleep(POLL_MS);
    }
  } finally {
    deps.launchctl(['bootout', `${domain}/${label}`]);
  }
}

/** Runner: dentro do job do launchd, roda as etapas e grava o estado. */
function runRunner(argv) {
  const stateIndex = argv.indexOf('--state');
  const statePath = argv[stateIndex + 1];
  const options = parseReleaseMacArgs(
    argv.filter((arg, index) => arg !== '--runner' && index !== stateIndex && index !== stateIndex + 1),
  );
  const repoRoot = process.cwd();
  const nodeDir = path.dirname(process.env.NEXUS_RELEASE_NODE || process.execPath);
  const outcome = runReleaseSteps(releaseSteps(options), (step) => {
    process.stdout.write(`\n[release:mac] etapa ${step} (${STEP_SCRIPTS[step]})\n`);
    const result = spawnSync('npm', ['run', STEP_SCRIPTS[step]], {
      cwd: repoRoot,
      env: stepEnvironment(step, process.env, { nodeDir, repoRoot }),
      stdio: 'inherit',
    });
    const code = result.status ?? 1;
    process.stdout.write(`[release:mac] etapa ${step} → exit ${code}\n`);
    return code;
  });
  fs.writeFileSync(statePath, JSON.stringify(outcome));
  process.exitCode = outcome.exitCode;
}

async function main(argv) {
  if (argv.includes('--runner')) {
    runRunner(argv);
    return;
  }
  const options = parseReleaseMacArgs(argv);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const nodePath = process.env.NEXUS_RELEASE_NODE || process.execPath;
  const nodeVersion =
    nodePath === process.execPath
      ? process.version
      : spawnSync(nodePath, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const code = await runDetachedRelease(options, {
    platform: process.platform,
    uid: process.getuid(),
    // HOME do pane é efêmero; Keychain, gh e CLIs moram na home real.
    realHome: os.userInfo().homedir,
    repoRoot,
    version: packageJson.version,
    nodePath,
    nodeVersion,
    expectedNodeVersion: packageJson.nexusRelease?.node,
    makeWorkDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-mac-')),
    nonce: () => randomBytes(4).toString('hex'),
    launchdList: () => spawnSync('launchctl', ['list'], { encoding: 'utf8' }).stdout ?? '',
    releaseProcesses: () =>
      spawnSync('pgrep', ['-fl', RELEASE_PROCESS_PATTERN], { encoding: 'utf8' }).stdout ?? '',
    launchctl: (args) => spawnSync('launchctl', args, { encoding: 'utf8' }),
    jobStatus: (label) => parseJobStatus(
      spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' }).stdout ?? '',
    ),
    write: (text) => process.stdout.write(text),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[release:mac] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
