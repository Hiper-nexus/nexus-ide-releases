import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOwnedProcess } from './video-process';

/**
 * Real child processes: the tree kill is the acceptance criterion "cancelar
 * mata a árvore de processos sem deixar órfão", so it is tested with an
 * actual parent that spawns an actual grandchild.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-proc-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

const env = (): Record<string, string> => {
  const keep: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value) keep[key] = value;
  }
  return keep;
};

describe('runOwnedProcess', () => {
  it('entrega linhas de stdout e stderr e o código de saída', async () => {
    const script = path.join(dir, 'lines.js');
    fs.writeFileSync(script, 'console.log("@hf-progress {\\"pct\\":50}"); console.error("aviso"); console.log("fim"); process.exit(3);');
    const seen: string[] = [];
    const result = await runOwnedProcess({
      file: process.execPath,
      args: [script],
      cwd: dir,
      env: env(),
      timeoutMs: 20_000,
      onLine: (line, stream) => seen.push(`${stream}:${line}`),
    });
    expect(result.exitCode).toBe(3);
    expect(seen).toContain('stdout:@hf-progress {"pct":50}');
    expect(seen).toContain('stderr:aviso');
    expect(result.tail).toContain('fim');
  });

  it('cancelar mata o processo E o neto, sem órfão', async () => {
    const grandchild = path.join(dir, 'grandchild.js');
    fs.writeFileSync(grandchild, 'setInterval(() => {}, 1000);');
    const parent = path.join(dir, 'parent.js');
    fs.writeFileSync(
      parent,
      `const { spawn } = require('node:child_process');
       const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
       console.log('neto ' + child.pid);
       setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    let grandchildPid = 0;
    const running = runOwnedProcess({
      file: process.execPath,
      args: [parent],
      cwd: dir,
      env: env(),
      signal: controller.signal,
      timeoutMs: 60_000,
      onLine: (line) => {
        const match = /^neto (\d+)$/u.exec(line);
        if (match) grandchildPid = Number(match[1]);
      },
    });
    expect(await waitFor(() => grandchildPid > 0)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(await waitFor(() => !alive(grandchildPid), 10_000)).toBe(true);
  }, 30_000);

  it('o prazo encerra a árvore e diz que estourou', async () => {
    const script = path.join(dir, 'forever.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
    const result = await runOwnedProcess({
      file: process.execPath,
      args: [script],
      cwd: dir,
      env: env(),
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 30_000);

  it('executável inexistente vira erro de spawn, sem exceção', async () => {
    const result = await runOwnedProcess({
      file: path.join(dir, 'nao-existe.exe'),
      args: [],
      cwd: dir,
      env: env(),
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeTruthy();
  });
});
