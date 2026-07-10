import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const CHILD_READY_PREFIX = '[server-artifact-smoke] ready:';
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_ENV_ALLOWLIST = new Set([
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);
const UNSAFE_SMOKE_ENV_NAME =
  /(?:^|_)(?:TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SECRET)(?:$|_)|^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DYLD_.*|LD_PRELOAD|LD_LIBRARY_PATH)$/i;

export function compiledServerPath(serverRoot = SERVER_ROOT) {
  return resolve(serverRoot, 'dist', 'index.js');
}

export function sanitizeSmokeEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => SMOKE_ENV_ALLOWLIST.has(name) && typeof value === 'string',
    ),
  );
}

async function listenOnLoopback(app) {
  return new Promise((fulfill, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => fulfill(server));
  });
}

async function runChild(artifactPath) {
  if (Object.keys(process.env).some((name) => UNSAFE_SMOKE_ENV_NAME.test(name))) {
    throw new Error('unsafe smoke child environment');
  }
  const module = await import(pathToFileURL(artifactPath).href);
  if (typeof module.createApp !== 'function') {
    throw new Error('compiled artifact does not export createApp');
  }
  const app = module.createApp(undefined, {
    readinessProbe: async () => undefined,
  });
  const server = await listenOnLoopback(app);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('compiled artifact did not bind a TCP port');
  }
  process.stdout.write(`${CHILD_READY_PREFIX}${address.port}\n`);
  await new Promise((fulfill) => {
    process.once('SIGTERM', () => server.close(fulfill));
  });
}

function waitForChildPort(child) {
  return new Promise((fulfill, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error('compiled server smoke timed out'));
    }, SMOKE_TIMEOUT_MS);
    const finish = (callback) => (value) => {
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/\[server-artifact-smoke\] ready:(\d+)/);
      if (match) finish(fulfill)(Number(match[1]));
    });
    child.once('error', finish(reject));
    child.once('exit', (code) => {
      if (!output.includes(CHILD_READY_PREFIX)) {
        finish(reject)(new Error(`compiled server exited before ready (${code ?? 'signal'})`));
      }
    });
  });
}

async function assertJsonResponse(port, pathname, expected) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  if (response.status !== 200 || JSON.stringify(body) !== JSON.stringify(expected)) {
    throw new Error(`compiled server ${pathname} probe failed`);
  }
}

export async function runCompiledServerSmoke(options = {}) {
  const artifactPath = options.artifactPath ?? compiledServerPath();
  await access(artifactPath, constants.R_OK);
  const child = spawn(process.execPath, [SCRIPT_PATH, '--child', artifactPath], {
    cwd: SERVER_ROOT,
    env: sanitizeSmokeEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await waitForChildPort(child);
    await assertJsonResponse(port, '/live', { status: 'alive' });
    await assertJsonResponse(port, '/ready', { status: 'ready' });
  } finally {
    child.kill('SIGTERM');
  }
  process.stdout.write('[server-artifact-smoke] ok\n');
}

const isDirectExecution = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const childFlagIndex = process.argv.indexOf('--child');
  if (childFlagIndex >= 0) {
    await runChild(resolve(process.argv[childFlagIndex + 1] ?? ''));
  } else {
    await runCompiledServerSmoke();
  }
}
