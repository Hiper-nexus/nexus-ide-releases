import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from './hooks-gen';

const tmpRoots: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hook-test-'));
  tmpRoots.push(dir);
  return dir;
}

function writeHook(dir = makeTempDir()): string {
  const file = path.join(dir, 'nexus-gate.mjs');
  fs.writeFileSync(file, HOOK_SCRIPT, { mode: 0o700 });
  return file;
}

function runHook(
  script: string,
  event: string,
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: makeTempDir(),
    NEXUS_GATE_TOKEN: 'test-token',
    ...env,
  };
  delete childEnv.NEXUS_HOOK_CHILD;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, event], {
      encoding: 'utf8',
      timeout: 5_000,
      env: childEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin?.end(`${JSON.stringify(input)}\n`);
  });
}

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      resolve({
        server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}/gate`,
      });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('HOOK_SCRIPT', () => {
  it('prints Codex continue JSON for stop and exits quickly while detached child posts stop', async () => {
    let resolveStop!: (body: string) => void;
    const stopPosted = new Promise<string>((resolve) => {
      resolveStop = resolve;
    });
    const gate = await listen((req, res) => {
      if (req.method === 'POST' && req.url === '/gate/stop') {
        void readBody(req).then(resolveStop);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: true }));
        return;
      }
      res.writeHead(404).end();
    });
    const script = writeHook();
    const startedAt = Date.now();

    const result = await runHook(
      script,
      'stop',
      { tool_name: 'Stop', tool_input: { ok: true } },
      { NEXUS_GATE_URL: gate.url },
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"continue":true}\n');
    expect(result.stderr).toBe('');
    await expect(waitFor(stopPosted, 2_000)).resolves.toContain('"toolName":"Stop"');
  });

  it('blocks pretool with no stdout when the gate is unreachable', async () => {
    const script = writeHook();

    const result = await runHook(
      script,
      'pretool',
      { tool_name: 'Bash', tool_input: { command: 'date' } },
      { NEXUS_GATE_URL: 'http://127.0.0.1:9/gate' },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('gate unreachable');
  });

  it('blocks pretool with the gate verdict reason', async () => {
    const gate = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: false, reason: 'x' }));
      });
    });
    const script = writeHook();

    const result = await runHook(
      script,
      'pretool',
      { tool_name: 'Bash', tool_input: { command: 'date' } },
      { NEXUS_GATE_URL: gate.url },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('x');
  });

  it('hides the detached stop child window on Windows', () => {
    expect(HOOK_SCRIPT).toContain('windowsHide: true');
  });

  it('falls back to the arms runtime gate port when the env gate is stale', async () => {
    const gate = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: true }));
      });
    });
    const home = makeTempDir();
    fs.mkdirSync(path.join(home, '.nexus'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.nexus', 'arms-runtime.json'),
      `${JSON.stringify({ schemaVersion: 1, port: gate.port, at: Date.now() })}\n`,
    );
    const script = writeHook();

    const result = await runHook(
      script,
      'pretool',
      { tool_name: 'Bash', tool_input: { command: 'date' } },
      {
        HOME: home,
        NEXUS_GATE_URL: 'http://127.0.0.1:9/gate',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('usa o descriptor da instância do pane, não o do app instalado (F-644)', async () => {
    const gate = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: true }));
      });
    });
    const home = makeTempDir();
    fs.mkdirSync(path.join(home, '.nexus'), { recursive: true });
    // O app instalado publicou uma porta morta; o `npm start` publicou a viva.
    fs.writeFileSync(
      path.join(home, '.nexus', 'arms-runtime.json'),
      `${JSON.stringify({ schemaVersion: 1, port: 9, at: Date.now() })}\n`,
    );
    const devDescriptor = path.join(home, '.nexus', 'arms-runtime.dev.json');
    fs.writeFileSync(
      devDescriptor,
      `${JSON.stringify({ schemaVersion: 1, port: gate.port, at: Date.now() })}\n`,
    );
    const script = writeHook();

    const result = await runHook(
      script,
      'pretool',
      { tool_name: 'Bash', tool_input: { command: 'date' } },
      {
        HOME: home,
        USERPROFILE: home,
        NEXUS_GATE_URL: 'http://127.0.0.1:9/gate',
        NEXUS_PANE_ARMS_DESCRIPTOR: devDescriptor,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
