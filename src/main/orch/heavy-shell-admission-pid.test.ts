import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

// F-1434: o guard de BASH_ENV pede a admissão com o PID do próprio shell. No
// Git Bash (MSYS2) `$$`/`BASHPID` são PIDs do runtime POSIX, não do Windows, e
// o Main confere a árvore real do pane pelo PID do kernel: todo comando pesado
// do Bash de um pane Claude Code no Windows era recusado em ~0,4 s com uma
// mensagem que culpava CPU/RAM.
const resources = path.join(process.cwd(), 'resources/heavy-command');

function findBash(): { file: string; pathDirs: string[] } | null {
 if (process.platform !== 'win32') return fs.existsSync('/bin/bash') ? { file: '/bin/bash', pathDirs: ['/usr/bin', '/bin'] } : null;
 // O bash.exe de Git\bin é um lançador que abre Git\usr\bin\bash.exe como
 // filho; só o de usr\bin tem o PID que o shell enxerga em /proc/$$/winpid.
 const roots = (process.env.PATH ?? '').split(path.delimiter)
  .filter((dir) => fs.existsSync(path.join(dir, 'git.exe')))
  .map((dir) => path.dirname(dir));
 roots.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git'));
 for (const root of roots) {
  const file = path.join(root, 'usr', 'bin', 'bash.exe');
  if (fs.existsSync(file)) return { file, pathDirs: [path.join(root, 'usr', 'bin')] };
 }
 return null;
}
const bash = findBash();
const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
 await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
 for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fakeMain(reply: (body: Record<string, unknown>) => unknown) {
 const received: Array<Record<string, unknown>> = [];
 const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (part) => { raw += part; });
  req.on('end', () => {
   const body = JSON.parse(raw) as Record<string, unknown>; received.push(body);
   res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply(body)));
  });
 });
 servers.push(server);
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
 return { received, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hook/heavy-command` };
}

function runGuardedShell(url: string, command: string) {
 if (!bash) throw new Error('bash unavailable');
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-pid-')); dirs.push(home);
 const env: NodeJS.ProcessEnv = {
  PATH: bash.pathDirs.join(path.delimiter), HOME: home, BASH_ENV: path.join(resources, 'shell.bash'),
  NEXUS_HEAVY_COMMAND_URL: url, NEXUS_GATE_TOKEN: 'finite-pid-fixture', NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources,
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
 };
 const child = spawn(bash.file, ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
 let stderr = ''; child.stderr.on('data', (part) => { stderr += part; });
 return new Promise<{ pid: number | undefined; code: number | null; stderr: string }>((resolve) => {
  child.once('close', (code) => resolve({ pid: child.pid, code, stderr }));
 });
}

it.skipIf(!bash)('F-1434: o guard do Bash pede admissão com o PID real do shell (no Windows, o do kernel, não o do MSYS)', async () => {
 const main = await fakeMain(() => ({ allow: false, reason: 'heavy_command_fixture', message: 'nexus-heavy: fixture denial' }));
 const run = await runGuardedShell(main.url, 'vitest run fixture-never-runs');
 expect(main.received).toHaveLength(1);
 expect(main.received[0]).toMatchObject({ pid: run.pid, kind: 'tests' });
 expect(run.code).toBe(78);
}, 30_000);

it.skipIf(!bash)('F-1434: a recusa mostra o motivo do Main e não culpa CPU/RAM', async () => {
 const main = await fakeMain(() => ({ allow: false, reason: 'heavy_command_process_ownership_unproved', message: 'nexus-heavy: fixture ownership reason' }));
 const run = await runGuardedShell(main.url, 'vitest run fixture-never-runs');
 expect(run.code).toBe(78);
 expect(run.stderr).toContain('nexus-heavy: fixture ownership reason');
 expect(run.stderr).toContain('[Nexus] Heavy command not started');
 expect(run.stderr).not.toMatch(/CPU\/RAM/);
}, 30_000);

it.skipIf(!bash)('F-1434: Main que não responde vira motivo explícito, não "CPU/RAM indisponível"', async () => {
 const closed = http.createServer(); await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
 const port = (closed.address() as { port: number }).port; await new Promise<void>((resolve) => closed.close(() => resolve()));
 const run = await runGuardedShell(`http://127.0.0.1:${port}/hook/heavy-command`, 'vitest run fixture-never-runs');
 expect(run.code).toBe(78);
 expect(run.stderr).toMatch(/nexus-heavy: .*(did not answer|não respondeu)/);
 expect(run.stderr).not.toMatch(/CPU\/RAM/);
}, 30_000);

it.each([[null], [42], ['allow'], [[]]])('F-1479: resposta HTTP 200 que não é objeto (%j) sai 78 com o motivo, sem TypeError', async (reply) => {
 const main = await fakeMain(() => reply);
 const child = spawn(process.execPath, [path.join(resources, 'request.cjs'), String(process.pid), 'tests'], {
  env: { NEXUS_HEAVY_COMMAND_URL: main.url, NEXUS_GATE_TOKEN: 'finite-pid-fixture', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
 });
 let stdout = '', stderr = ''; child.stdout.on('data', (part) => { stdout += part; }); child.stderr.on('data', (part) => { stderr += part; });
 const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
 expect(main.received).toHaveLength(1);
 expect({ code, stdout, stderr }).toEqual({ code: 78, stdout: '', stderr: 'nexus-heavy: Nexus admission sent an unreadable reply (HTTP 200)\n' });
}, 30_000);
