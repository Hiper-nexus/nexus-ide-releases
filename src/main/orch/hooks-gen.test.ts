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
  // O descriptor da instância (F-644) vem do ambiente: rodando os testes
  // dentro de um pane do Nexus ele aponta para o gate VIVO do app, e o
  // fallback "gate inacessível" acabava permitindo. Só o teste decide.
  const { NEXUS_PANE_ARMS_DESCRIPTOR: _ambientDescriptor, ...ambient } = process.env;
  const childEnv: NodeJS.ProcessEnv = {
    ...ambient,
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

function spoolEnv(): { env: Record<string, string>; files: () => string[] } {
  const dir = makeTempDir();
  return {
    env: {
      NEXUS_HANDOFF_SPOOL_DIR: dir,
      NEXUS_HANDOFF_SPOOL_ID: 'spool-hooks-gen-test',
      NEXUS_HANDOFF_SPOOL_KEY: 'a'.repeat(64),
    },
    files: () => fs.readdirSync(dir).filter((name) => name.endsWith('.json')),
  };
}

const HANDOFF = {
  tool_name: 'mcp__nexus__nexus_handoff_submit',
  tool_input: { status: 'blocked', summary: 'Main fora do ar; plano pronto para retomada.' },
};

describe('HOOK_SCRIPT', () => {
  // Doutrina do dono (10/10/2026): o hook não autoriza nada e o Nexus fora do
  // ar nunca bloqueia ferramenta. A única saída 2 é a do spool do handoff.
  it.each(['Bash', 'Edit', 'Write', 'WebFetch', 'Task', 'Skill', 'Read', 'mcp__nexus__nexus_git_commit', 'mcp__other__delete'])(
    'never blocks %s when the gate is unreachable',
    async (tool) => {
      const result = await runHook(writeHook(), 'pretool', { tool_name: tool, tool_input: { command: 'date' } }, {
        NEXUS_GATE_URL: 'http://127.0.0.1:9/gate',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    },
  );

  it('never blocks when the pane has no gate credentials', async () => {
    const result = await runHook(writeHook(), 'pretool', { tool_name: 'Bash', tool_input: { command: 'date' } }, {
      NEXUS_GATE_URL: '', NEXUS_GATE_TOKEN: '',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('a reachable gate no longer authorizes: a legacy deny verdict does not block', async () => {
    const gate = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: false, reason: 'allowlist antiga' }));
      });
    });
    const result = await runHook(writeHook(), 'pretool', { tool_name: 'Bash', tool_input: { command: 'date' } }, {
      NEXUS_GATE_URL: gate.url,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('with the Main unreachable the handoff goes to the spool and the agent hears it was saved (F-795)', async () => {
    const spool = spoolEnv();
    const result = await runHook(writeHook(), 'pretool', HANDOFF, {
      NEXUS_GATE_URL: 'http://127.0.0.1:9/gate', ...spool.env,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('handoff guardado em disco');
    expect(spool.files()).toHaveLength(1);
  });

  it('with the Main reachable the handoff follows the MCP call and nothing is spooled', async () => {
    const gate = await listen((req, res) => {
      void readBody(req).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ allow: true }));
      });
    });
    const spool = spoolEnv();
    const result = await runHook(writeHook(), 'pretool', HANDOFF, { NEXUS_GATE_URL: gate.url, ...spool.env });
    expect(result.status).toBe(0);
    expect(spool.files()).toHaveLength(0);
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
    const spool = spoolEnv();
    const result = await runHook(writeHook(), 'pretool', HANDOFF, {
      HOME: home,
      NEXUS_GATE_URL: 'http://127.0.0.1:9/gate',
      ...spool.env,
    });

    // The live fallback answered, so the handoff was not diverted to disk.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(spool.files()).toHaveLength(0);
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
    const spool = spoolEnv();
    const result = await runHook(writeHook(), 'pretool', HANDOFF, {
      HOME: home,
      USERPROFILE: home,
      NEXUS_GATE_URL: 'http://127.0.0.1:9/gate',
      NEXUS_PANE_ARMS_DESCRIPTOR: devDescriptor,
      ...spool.env,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(spool.files()).toHaveLength(0);
  });
});
